import { lstat, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNoteFrontmatter, parseNoteFrontmatterFields, type KnowledgeAcceptanceStore } from "../acceptance.js";
import type { KnowledgeBindingRegistry } from "../bindings.js";
import { assertReviewMatchesBatch, publicationManifestHash, type KnowledgeBinding, type PublicationBatch, type PublicationFile, type ReviewDecision } from "../contracts.js";
import { hashBufferSha256 } from "../hashing.js";
import type { KnowledgeObjectStore } from "../objects.js";
import { checkedKnowledgeRoot, readNoteBytes, withinKnowledgeRoot, type KnowledgeObservationService } from "../observation.js";
import type { KnowledgeSearchIndex } from "../search-index.js";
import type { WikiPublisher } from "../../routes/wiki.js";
import type { ReviewStore } from "./review-store.js";
import { PublishJournal, type PublishFileRecord, type StoredPublishOperation } from "./publish-journal.js";
import { publicationContextChanges } from "./publication-context.js";
import { isControlDocument } from "../note-paths.js";
import { assertImageBatchIntegrity, readImageDiskBytes } from "../image-publication.js";
import { withKnowledgeMutation } from "../mutation-lock.js";

/** 测试注入用的模拟进程崩溃：publisher 不捕获、不收敛，直接穿出 onApproved。 */
export class PublishCrashError extends Error {}

/** 崩溃点注入：在副作用完成后、回执落盘前触发（仅限进程内测试使用）。
 *  "preflight" 在全局预读通过后、首个写入前触发，用于注入 TOCTOU 外部改动。 */
export type PublishStepHook = (step: "preflight" | "before_image" | "write" | "verify" | "group_commit", targetPath: string) => void | Promise<void>;

export interface MarkdownWikiPublisherDeps {
	bindings: Pick<KnowledgeBindingRegistry, "requireUsable">;
	reviews: ReviewStore;
	journal: PublishJournal;
	acceptance: Pick<KnowledgeAcceptanceStore, "getSnapshot" | "adoptPublished">;
	observation: Pick<KnowledgeObservationService, "scan"> & Partial<Pick<KnowledgeObservationService, "setPublicationJournal">>;
	objects: Pick<KnowledgeObjectStore, "get" | "put">;
	searchIndex: Pick<KnowledgeSearchIndex, "load">;
	/** before-image 等操作产物目录（state/knowledge/operations）。 */
	operationsDir: string;
	stepHook?: PublishStepHook;
}

interface ResolvedTarget {
	file: PublicationFile;
	absolute: string;
	candidateBytes: Buffer;
	/** update 的写前磁盘内容（before-image 来源）；create 恒为 null。 */
	baselineBytes: Buffer | null;
	conflict?: string;
}

/** 磁盘内容三态：与候选一致（已写入）/ 与基线一致或不存在（未执行）/ 第三态（外部冲突）。 */
type DiskClass = "applied" | "not_executed" | "external";

function sameMembers(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && new Set(actual).size === actual.length &&
		actual.every((item) => expected.includes(item));
}

/**
 * Markdown 发布器（T40/T42/T44）：capabilities {create, update}，delete 拒止。
 * 按 binding 串行；写前预读全部基线，任一冲突未写盘即中止（P05）；每步回执落盘
 * 后才推进下一步；依赖组全成才回写采纳账本（P08），否则批次如实标 partial。
 */
export class MarkdownWikiPublisher implements WikiPublisher {
	readonly capabilities = { create: true, update: true, delete: false } as const;

	constructor(private readonly deps: MarkdownWikiPublisherDeps) { deps.observation.setPublicationJournal?.(deps.journal); }

	/** 同 binding 的发布串行化（进程内队列即锁）；onApproved 同步跑到终态再返回。 */
	onApproved(batch: PublicationBatch, review: ReviewDecision): Promise<{ accepted: boolean; note?: string }> {
		return withKnowledgeMutation(batch.bindingId, () => this.run(batch, review)).then(async outcome => {
			const stored = await this.deps.reviews.get(batch.id);
			const binding = stored ? await this.deps.bindings.requireUsable(stored.ownerId, batch.bindingId).catch(() => null) : null;
			if (binding) await this.deps.observation.scan(binding).catch(() => undefined);
			return outcome;
		});
	}

	/** 解析发布目标：批次 shape 已拒绝绝对路径/..；再逐段 lstat 防符号链接，并复核未逃逸库根。 */
	private async resolveTarget(root: string, targetPath: string): Promise<string> {
		const parts = targetPath.split("/");
		let current = root;
		for (const [index, part] of parts.entries()) {
			current = path.join(current, part);
			const info = await lstat(current).catch(() => null);
			if (info?.isSymbolicLink()) throw new Error(`发布目标经过符号链接：${targetPath}`);
			if (index < parts.length - 1 && info && !info.isDirectory()) throw new Error(`发布目标的父路径不是目录：${targetPath}`);
		}
		const absolute = path.resolve(root, targetPath);
		if (!withinKnowledgeRoot(root, absolute)) throw new Error(`发布目标逃逸库根：${targetPath}`);
		return absolute;
	}

	private async bindingMatches(batch: PublicationBatch, binding: KnowledgeBinding): Promise<boolean> {
		return (await publicationContextChanges(batch, binding)).length === 0;
	}

	private async readDiskHash(absolute: string, kind?: "image"): Promise<string | null> {
		const bytes = await (kind === "image" ? readImageDiskBytes(absolute) : readNoteBytes(absolute)).catch(() => null);
		return bytes ? hashBufferSha256(bytes) : null;
	}

	private async run(batch: PublicationBatch, review: ReviewDecision): Promise<{ accepted: boolean; note?: string }> {
		const stored = await this.deps.reviews.get(batch.id);
		if (!stored) return { accepted: false, note: "批次不存在" };
		const frozenReview = (await this.deps.reviews.decisionsFor(batch.id)).find((decision) => decision.id === stored.decisionId);
		if (batch.manifestHash !== stored.batch.manifestHash || publicationManifestHash(batch) !== stored.batch.manifestHash ||
			!frozenReview || review.id !== frozenReview.id || JSON.stringify(review) !== JSON.stringify(frozenReview)) {
			return { accepted: false, note: "发布请求与冻结批次或审核决定不一致" };
		}
		try { assertReviewMatchesBatch(stored.batch, frozenReview); }
		catch { return { accepted: false, note: "冻结审核无效" }; }
		batch = stored.batch;
		review = frozenReview;
		if (stored.status !== "approved") {
			const terminal = stored.status === "published" || stored.status === "partial" || stored.status === "conflict";
			return { accepted: terminal, note: `批次已处于 ${stored.status}，不重复发布` };
		}
		const ownerId = stored.ownerId;
		// A journal created before a crash may already contain effects. Never run it forward again.
		const prior = (await this.deps.journal.list()).find((operation) => operation.reviewId === review.id);
		if (prior) {
			await this.deps.reviews.markPublishing(batch.id);
			const reconciled = await this.reconcileOne(prior);
			return { accepted: !!reconciled, note: reconciled ? `中断发布已对账：${reconciled.state}` : "发布等待安全对账" };
		}
		// fail-closed：delete 不在 capabilities 内，整批拒止（同 W1 准入语义）。
		if (batch.files.some((file) => file.operation === "delete")) {
			const { record } = await this.deps.journal.begin({ batch, ownerId, actorId: review.actorId, reviewId: review.id, idempotencyKey: review.id });
			for (const file of record.files) {
				await this.deps.journal.updateFile(record.id, file.targetPath, { status: "rejected", error: "delete 请求拒止（fail-closed）" });
			}
			await this.deps.journal.settle(record.id, "conflict", "本批包含暂不支持发布的删除操作，整批未写入");
			await this.deps.reviews.markPublishing(batch.id);
			await this.deps.reviews.settlePublish(batch.id, "conflict", "publish_rejected");
			return { accepted: true, note: "批次包含 delete 请求，已整批拒止（fail-closed）" };
		}
		const { record: queued } = await this.deps.journal.begin({ batch, ownerId, actorId: review.actorId, reviewId: review.id, idempotencyKey: review.id });
		await this.deps.reviews.markPublishing(batch.id);
		const operation = await this.deps.journal.setRunning(queued.id);
		try {
			return await this.execute(batch, stored, operation, review);
		} catch (error) {
			if (error instanceof PublishCrashError) throw error;
			// 未预期异常：当前步结果不可知，停止后续写入，标 unknown 交启动对账。
			const note = error instanceof Error ? error.message : String(error);
			await this.deps.journal.settle(operation.id, "unknown", `发布中断：${note}；写入结果需要对账确认`).catch(() => undefined);
			await this.deps.reviews.settlePublish(batch.id, "conflict", "publish_uncertain").catch(() => undefined);
			return { accepted: true, note: `发布中断：${note}；操作已标 uncertain，重启后对账` };
		}
	}

	private async execute(batch: PublicationBatch, stored: { ownerId: string }, operation: StoredPublishOperation,
		review: ReviewDecision): Promise<{ accepted: boolean; note?: string }> {
		const binding = await this.deps.bindings.requireUsable(stored.ownerId, batch.bindingId)
			.catch(() => null);
		const root = binding ? await checkedKnowledgeRoot(binding).catch(() => null) : null;
		if (!binding) {
			return this.abortBeforeWrite(batch, operation, "当前无法访问或确认知识库文件夹，未写入任何文件", "publish_preflight");
		}
		const contextChanges = await publicationContextChanges(batch, binding);
		if (contextChanges.length > 0) {
			return this.abortBeforeWrite(batch, operation, `${contextChanges.join("；")}。未写入任何文件，请按当前知识库重新生成候选并审核`, "publish_preflight");
		}
		if (!root) return this.abortBeforeWrite(batch, operation, "当前无法访问或确认知识库文件夹，未写入任何文件", "publish_preflight");
		try { await assertImageBatchIntegrity(batch, this.deps.objects); }
		catch (error) { return this.abortBeforeWrite(batch, operation, error instanceof Error ? error.message : "图片批次校验失败", "publish_preflight"); }
		// 写前预读全部目标基线（P05）：任一冲突 → 未写盘即中止。
		const targets = new Map<string, ResolvedTarget>();
		for (const file of batch.files) {
			if (isControlDocument(file.targetPath) && !["index.md", "log.md"].includes(file.targetPath.split("/").pop()!.toLowerCase()))
				return this.abortBeforeWrite(batch, operation, "发布候选不得修改知识库操作契约", "publish_preflight");
			const resolved = await this.preflightOne(root, file);
			targets.set(file.targetPath, resolved);
			if (!resolved.conflict) {
				await this.deps.journal.appendReceipt(operation.id, file.targetPath, { step: "preflight" });
			}
		}
		const conflicts = [...targets.values()].filter((target) => target.conflict);
		if (conflicts.length > 0) {
			for (const target of conflicts) {
				await this.deps.journal.updateFile(operation.id, target.file.targetPath, { status: "conflict", error: target.conflict });
			}
			return this.abortBeforeWrite(batch, operation,
				`${conflicts.length} 个目标基线冲突（${conflicts[0]!.file.targetPath}：${conflicts[0]!.conflict}），未写入任何字节`, "publish_preflight");
		}
		await this.deps.stepHook?.("preflight", "");
		// 逐组逐文件写入；任一文件失败/未知即停止后续写入。
		let stopReason: { kind: "conflict" | "failed" | "uncertain"; target: string; message: string } | null = null;
		outer: for (const group of batch.dependencyGroups) {
			for (const targetPath of group) {
				const target = targets.get(targetPath)!;
				const currentBinding = await this.deps.bindings.requireUsable(stored.ownerId, batch.bindingId);
				if (!await this.bindingMatches(batch, currentBinding) || await checkedKnowledgeRoot(currentBinding) !== root) {
					throw new Error("发布期间知识库权限或身份变化");
				}
				const outcome = await this.writeOne(root, operation, target);
				if (outcome) {
					stopReason = { kind: outcome, target: targetPath, message: "" };
					break outer;
				}
			}
			await this.commitGroup(binding, operation, batch, group, review.actorId);
		}
		// 组提交后重建索引与观察（派生视图；周期性重扫兜底，失败不阻断收敛）。
		const committed = (await this.deps.journal.get(operation.id))!.committedGroups;
		if (committed.length > 0) {
			const ledger = await this.deps.acceptance.getSnapshot(binding.id);
			await this.deps.searchIndex.load(binding.id, ledger).catch(() => undefined);
		}
		return this.settle(batch, operation.id, stopReason);
	}

	/** 未写盘即中止：操作与批次直接收敛 conflict。 */
	private async abortBeforeWrite(batch: PublicationBatch, operation: StoredPublishOperation, note: string,
		reason: "publish_preflight" | "publish_rejected"): Promise<{ accepted: boolean; note?: string }> {
		await this.deps.journal.settle(operation.id, "conflict", note);
		await this.deps.reviews.settlePublish(batch.id, "conflict", reason);
		return { accepted: true, note };
	}

	private async preflightOne(root: string, file: PublicationFile): Promise<ResolvedTarget> {
		const absolute = await this.resolveTarget(root, file.targetPath);
		const candidateBytes = file.blobRef ? await this.deps.objects.get(file.blobRef).catch(() => null) : null;
		if (!candidateBytes || hashBufferSha256(candidateBytes) !== file.candidateHash) {
			return { file, absolute, candidateBytes: Buffer.alloc(0), baselineBytes: null, conflict: "候选字节缺失或已损坏" };
		}
		if (file.operation === "create") {
			const existing = await lstat(absolute).catch(() => null);
			if (existing) return { file, absolute, candidateBytes, baselineBytes: null, conflict: "目标已存在，create 不覆盖" };
			return { file, absolute, candidateBytes, baselineBytes: null };
		}
		const baselineBytes = await (file.kind === "image" ? readImageDiskBytes(absolute) : readNoteBytes(absolute)).catch(() => null);
		if (!baselineBytes) return { file, absolute, candidateBytes, baselineBytes: null, conflict: "基线文件不存在或不可读" };
		if (hashBufferSha256(baselineBytes) !== file.expectedHashOrAbsent) {
			return { file, absolute, candidateBytes, baselineBytes, conflict: "磁盘内容已偏离审核基线" };
		}
		return { file, absolute, candidateBytes, baselineBytes };
	}

	/**
	 * 写单文件：update = before-image（operation 目录）→ tmp+rename 原子替换；
	 * create = tmp+link（原子 wx 语义：已存在即失败，不覆盖）。回执逐步落盘。
	 * 返回 null 表示已 applied；否则返回停止原因类别。
	 */
	private async writeOne(root: string, operation: StoredPublishOperation,
		target: ResolvedTarget): Promise<"conflict" | "failed" | "uncertain" | null> {
		const { file, candidateBytes } = target;
		const absolute = await this.resolveTarget(root, file.targetPath);
		const tmp = `${absolute}.pudding-${operation.id}.tmp`;
		const cleanupTmp = () => unlink(tmp).catch(() => undefined);
		try {
			if (file.kind === "image" && file.operation === "update") {
				if (await this.readDiskHash(absolute, "image") !== file.candidateHash) throw Object.assign(new Error("复用原图已变异"), { code: "EBASELINE" });
				await this.deps.journal.appendReceipt(operation.id, file.targetPath, { step: "verify", detail: "原图哈希一致，仅复用，无覆盖写入" }, { status: "applied" });
				return null;
			}
			// TOCTOU 复核：预读之后又漂移 → 停止，不写字节。
			if (file.operation === "create") {
				if (await lstat(absolute).catch(() => null)) throw Object.assign(new Error("目标已存在，create 不覆盖"), { code: "EEXIST" });
			} else {
				const currentHash = await this.readDiskHash(absolute, file.kind);
				if (currentHash !== file.expectedHashOrAbsent) throw Object.assign(new Error("写入前基线漂移"), { code: "EBASELINE" });
				const beforeDir = path.join(this.deps.operationsDir, operation.id, "before", path.dirname(file.targetPath));
				await mkdir(beforeDir, { recursive: true, mode: 0o700 });
				const beforeFile = path.join(this.deps.operationsDir, operation.id, "before", file.targetPath);
				const beforeTmp = `${beforeFile}.tmp`;
				await writeFile(beforeTmp, target.baselineBytes!, { mode: 0o600 });
				await rename(beforeTmp, beforeFile);
				await this.deps.stepHook?.("before_image", file.targetPath);
				await this.deps.journal.appendReceipt(operation.id, file.targetPath,
					{ step: "before_image" }, { beforeImageRef: hashBufferSha256(target.baselineBytes!) });
			}
			await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
			await this.resolveTarget(root, file.targetPath);
			await writeFile(tmp, candidateBytes, { mode: 0o600, flag: "wx" });
			if (file.operation === "create") {
				await this.resolveTarget(root, file.targetPath);
				await link(tmp, absolute);
				await cleanupTmp();
			} else {
				await this.resolveTarget(root, file.targetPath);
				await rename(tmp, absolute);
			}
			await this.deps.stepHook?.("write", file.targetPath);
			await this.deps.journal.appendReceipt(operation.id, file.targetPath,
				{ step: "write", detail: file.candidateHash ?? undefined });
			const written = await this.readDiskHash(absolute, file.kind);
			if (written !== file.candidateHash) {
				await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "uncertain", error: "写后校验失败，结果未知" });
				return "uncertain";
			}
			await this.deps.stepHook?.("verify", file.targetPath);
			await this.deps.journal.appendReceipt(operation.id, file.targetPath, { step: "verify" }, { status: "applied" });
			return null;
		} catch (error) {
			if (error instanceof PublishCrashError) throw error;
			await cleanupTmp();
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as NodeJS.ErrnoException).code;
			// 结果判定：读回目标与候选一致 → 实际已写入；可确定未写入 → failed/conflict；判不出 → uncertain。
			const diskHash = await this.readDiskHash(absolute, file.kind).catch(() => null);
			if (diskHash === file.candidateHash) {
				await this.deps.journal.appendReceipt(operation.id, file.targetPath,
					{ step: "verify", detail: "异常后读回确认已写入" }, { status: "applied" });
				return null;
			}
			if (code === "EEXIST" || code === "EBASELINE") {
				await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "conflict", error: message });
				return "conflict";
			}
			if (diskHash === null || diskHash === file.expectedHashOrAbsent) {
				await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "failed", error: message });
				return "failed";
			}
			await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "uncertain", error: `结果未知：${message}` });
			return "uncertain";
		}
	}

	/** 依赖组提交（T44）：组内全成才回写账本；adopt 既有 API 同时覆盖 create/update。
	 *  frontmatter id/title 从候选字节取，保证身份键与磁盘内容一致。 */
	private async commitGroup(binding: KnowledgeBinding, operation: StoredPublishOperation, batch: PublicationBatch,
		group: string[], actorId: string): Promise<void> {
		const items = [];
		for (const targetPath of group) {
			const file = batch.files.find((entry) => entry.targetPath === targetPath)!;
			const absolute = await this.resolveTarget(await checkedKnowledgeRoot(binding), file.targetPath);
			if (await this.readDiskHash(absolute, file.kind) !== file.candidateHash) throw new Error("依赖组提交前文件或原图已变化");
			if (file.kind === "image") continue;
			const bytes = await this.deps.objects.get(file.candidateHash!);
			const frontmatter = parseNoteFrontmatter(bytes.toString("utf8"));
			const fields = parseNoteFrontmatterFields(bytes.toString("utf8"));
			let reasons: Record<string, string> = {};
			try { reasons = (JSON.parse(batch.validationReceipt) as { reasons?: Record<string, string> }).reasons ?? {}; } catch { /* Legacy compiler receipt. */ }
			items.push({
				relativePath: file.targetPath,
				...(frontmatter.id ? { declaredNoteId: frontmatter.id } : {}),
				...(frontmatter.title ? { title: frontmatter.title } : {}),
				contentHash: file.candidateHash!,
				snapshotRef: file.candidateHash!,
				acceptedBy: actorId,
				summary: reasons[file.targetPath] ?? "审核后发布",
				sourceIds: Array.isArray(fields.sources) ? fields.sources.filter((value): value is string => typeof value === "string") : [],
			});
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const snapshot = await this.deps.acceptance.getSnapshot(binding.id);
			try {
				await this.deps.acceptance.adoptPublished(binding.id, items, snapshot.acceptanceRevision, {
					operationId: operation.id, channel: "agent_publish", batchId: batch.id, batchRevision: batch.revision, decisionId: operation.reviewId });
				break;
			} catch (error) {
				if (attempt === 1 || !(error instanceof Error) || (error as { code?: unknown }).code !== "stale_revision") throw error;
			}
		}
		await this.deps.stepHook?.("group_commit", group[0]!);
		await this.deps.journal.markGroupCommitted(operation.id, group);
	}

	private async settle(batch: PublicationBatch, operationId: string,
		stopReason: { kind: "conflict" | "failed" | "uncertain"; target: string; message: string } | null):
		Promise<{ accepted: boolean; note?: string }> {
		const operation = (await this.deps.journal.get(operationId))!;
		// 未推进到的文件如实标注，不给 UI 留 pending 假象。
		for (const file of operation.files) {
			if (file.status === "pending") {
				await this.deps.journal.updateFile(operationId, file.targetPath, { status: "failed", error: "前序步骤未通过，未执行" });
			}
		}
		const final = (await this.deps.journal.get(operationId))!;
		const allGroups = batch.dependencyGroups.length;
		const committedGroups = final.committedGroups.length;
		if (!stopReason && committedGroups === allGroups) {
			await this.deps.journal.settle(operationId, "published");
			await this.deps.reviews.settlePublish(batch.id, "published");
			return { accepted: true, note: `已发布 ${final.files.length} 个文件` };
		}
		if (stopReason?.kind === "uncertain") {
			await this.deps.journal.settle(operationId, "unknown");
			await this.deps.reviews.settlePublish(batch.id, "conflict", "publish_uncertain");
			return { accepted: true, note: `${stopReason.target} 写入结果未知，已停止后续写入；重启后对账` };
		}
		if (committedGroups > 0) {
			await this.deps.journal.settle(operationId, "partial");
			await this.deps.reviews.settlePublish(batch.id, "partial");
			return { accepted: true, note: `部分发布：${committedGroups}/${allGroups} 个依赖组已提交，${stopReason?.target ?? ""} 未通过` };
		}
		await this.deps.journal.settle(operationId, "conflict");
		await this.deps.reviews.settlePublish(batch.id, "conflict", stopReason?.kind === "conflict" ? "publish_external" : "publish_interrupted");
		return { accepted: true, note: `发布中止：${stopReason?.target ?? ""} ${stopReason?.kind === "conflict" ? "基线冲突" : "写入失败"}，未提交任何依赖组` };
	}

	/**
	 * 启动对账（P09/P11）：扫描 queued/running/unknown 操作，逐文件三态判定。
	 * 只收敛、不做新的前向写入——唯一例外是补做"磁盘与账本证据齐全"的组提交登记；
	 * 补偿回滚仅在磁盘内容 == 本次写入内容时恢复 before-image / 删除新建文件，
	 * 外部冲突只报告不自动改。
	 */
	async reconcileInterrupted(): Promise<StoredPublishOperation[]> {
		const settled: StoredPublishOperation[] = [];
		// Journal and review-store are separate durable stores. Handle both sides of every crash gap.
		for (const operation of await this.deps.journal.list()) {
			const stored = await this.deps.reviews.get(operation.batchId);
			const committed = new Set(operation.committedGroups.flat());
			const uncommittedEffects = operation.files.some((file) => file.status === "applied" && !committed.has(file.targetPath));
			if (!stored || (stored.status !== "approved" && stored.status !== "publishing" &&
				!["queued", "running", "unknown"].includes(operation.state) && !uncommittedEffects)) continue;
			if (stored.status === "approved" && stored.decisionId === operation.reviewId && stored.batch.manifestHash === operation.manifestHash) {
				await this.deps.reviews.markPublishing(stored.batch.id);
			}
			const result = await withKnowledgeMutation(operation.bindingId, () => this.reconcileOne(operation)).catch(() => null);
			const binding = await this.deps.bindings.requireUsable(operation.ownerId, operation.bindingId).catch(() => null);
			if (binding) await this.deps.observation.scan(binding).catch(() => undefined);
			if (result) settled.push(result);
		}
		for (const stored of await this.deps.reviews.list()) {
			if (stored.status !== "approved") continue;
			const review = (await this.deps.reviews.decisionsFor(stored.batch.id)).find((decision) => decision.id === stored.decisionId);
			if (!review) continue;
			await this.onApproved(stored.batch, review).catch(() => undefined);
			const operation = (await this.deps.journal.list()).find((entry) => entry.reviewId === review.id);
			if (operation) settled.push(operation);
		}
		return settled;
	}

	private async classifyFile(root: string, file: PublishFileRecord): Promise<DiskClass> {
		const absolute = await this.resolveTarget(root, file.targetPath);
		const diskHash = await this.readDiskHash(absolute, file.kind);
		if (diskHash !== null && diskHash === file.candidateHash) return "applied";
		if (file.operation === "create" && diskHash === null) return "not_executed";
		if (file.operation === "update" && diskHash !== null && diskHash === file.baselineHash) return "not_executed";
		return "external";
	}

	private async reconcileOne(operation: StoredPublishOperation): Promise<StoredPublishOperation | null> {
		const stored = await this.deps.reviews.get(operation.batchId);
		if (!stored || stored.ownerId !== operation.ownerId || stored.batch.bindingId !== operation.bindingId ||
			stored.batch.manifestHash !== operation.manifestHash || stored.decisionId !== operation.reviewId) return null;
		const binding = await this.deps.bindings.requireUsable(operation.ownerId, operation.bindingId).catch(() => null);
		const root = binding ? await checkedKnowledgeRoot(binding).catch(() => null) : null;
		if (!binding || !root || !await this.bindingMatches(stored.batch, binding)) return null; // 库根不可用：留待下次启动对账
		const batch = stored.batch;
		await assertImageBatchIntegrity(batch, this.deps.objects);
		const classes = new Map<string, DiskClass>();
		for (const file of operation.files) {
			const diskClass = await this.classifyFile(root, file);
			classes.set(file.targetPath, diskClass);
			await this.deps.journal.appendReceipt(operation.id, file.targetPath,
				{ step: "reconcile", detail: diskClass },
				diskClass === "applied" && file.status !== "applied" ? { status: "applied" } :
					diskClass === "external" ? { status: "conflict", error: "磁盘内容与候选/基线均不一致，转人工" } : {});
		}
		// 已提交组补登记：账本内容哈希已等于候选（崩溃发生在 adopt 之后、登记之前）→ 只补 journal，不重复 adopt。
		for (const group of batch.dependencyGroups) {
			const current = (await this.deps.journal.get(operation.id))!;
			if (current.committedGroups.some((committed) => sameMembers(committed, group))) continue;
			if (!group.every((target) => classes.get(target) === "applied")) continue;
			const snapshot = await this.deps.acceptance.getSnapshot(binding.id);
			const inLedger = group.every((target) => {
				const file = batch.files.find((entry) => entry.targetPath === target)!;
				if (file.kind === "image") return classes.get(target) === "applied";
				return [...Object.values(snapshot.entries), ...Object.values(snapshot.controlEntries ?? {})].some((entry) => entry.relativePath === target && entry.contentHash === file.candidateHash);
			});
			if (!inLedger) await this.commitGroup(binding, current, batch, group, current.actorId);
			else for (const target of group) {
				const file = batch.files.find((entry) => entry.targetPath === target)!;
				if (await this.readDiskHash(await this.resolveTarget(root, target), file.kind) !== file.candidateHash) throw new Error("恢复提交前页面或原图已变化");
			}
			await this.deps.journal.markGroupCommitted(operation.id, group);
		}
		let current = (await this.deps.journal.get(operation.id))!;
		const committedTargets = new Set(current.committedGroups.flat());
		// 补偿回滚（P11）：仅未提交组里"磁盘 == 本次写入"的文件允许恢复 before-image / 删除新建。
		// Remove/restore referencing pages before new assets, keeping reuse intact.
		for (const file of [...current.files].sort((a, b) => Number(a.kind === "image") - Number(b.kind === "image"))) {
			if (committedTargets.has(file.targetPath) || classes.get(file.targetPath) !== "applied") continue;
			if (file.kind === "image" && file.operation === "update" && file.baselineHash === file.candidateHash) {
				await this.deps.journal.appendReceipt(operation.id, file.targetPath, { step: "rollback", detail: "原图仅复用，无本次写入可回滚" }, { status: "rolled_back" });
				continue;
			}
			if (file.kind === "image") {
				const latest = (await this.deps.journal.get(operation.id))!;
				const groups = batch.dependencyGroups.filter((group) => group.includes(file.targetPath));
				const unsafePage = groups.flat().some((target) => {
					const page = latest.files.find((entry) => entry.targetPath === target)!;
					return page.kind !== "image" && (classes.get(target) === "external" || page.status === "uncertain");
				});
				if (unsafePage) {
					await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "uncertain", error: "同组页面已被外部修改或无法回滚，保留原图以免断引用，转人工" });
					continue;
				}
			}
			const absolute = await this.resolveTarget(root, file.targetPath);
			if (file.operation === "create") {
				const diskHash = await this.readDiskHash(absolute, file.kind);
				if (diskHash === file.candidateHash) await unlink(absolute).catch(() => undefined);
			} else {
				const beforeFile = path.join(this.deps.operationsDir, operation.id, "before", file.targetPath);
				const beforeBytes = await readFile(beforeFile).catch(() => null);
				const diskHash = await this.readDiskHash(absolute, file.kind);
				if (beforeBytes && file.beforeImageRef && hashBufferSha256(beforeBytes) === file.beforeImageRef && diskHash === file.candidateHash) {
					const tmp = `${absolute}.pudding-rollback-${operation.id}.tmp`;
					await writeFile(tmp, beforeBytes, { mode: 0o600 });
					await rename(tmp, absolute);
				} else {
					// before-image 缺失/损坏或磁盘又漂移：无法安全回滚，标 uncertain 转人工。
					await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "uncertain", error: "无法安全回滚，转人工" });
					continue;
				}
			}
			const after = await this.readDiskHash(absolute, file.kind);
			const rolledBack = file.operation === "create" ? after === null : after === file.baselineHash;
			await this.deps.journal.appendReceipt(operation.id, file.targetPath,
				{ step: "rollback" }, rolledBack ? { status: "rolled_back" } : { status: "uncertain", error: "回滚校验失败，转人工" });
		}
		current = (await this.deps.journal.get(operation.id))!;
		// 未执行文件标注；收敛操作与批次。
		for (const file of current.files) {
			if (file.status === "pending") {
				await this.deps.journal.updateFile(operation.id, file.targetPath, { status: "failed", error: "发布中断，未执行" });
			}
		}
		current = (await this.deps.journal.get(operation.id))!;
		const hasUncertain = current.files.some((file) => file.status === "uncertain");
		const hasExternal = [...classes.values()].includes("external");
		const allGroups = batch.dependencyGroups.length;
		const committedGroups = current.committedGroups.length;
		const opState = hasUncertain ? "unknown" as const :
			committedGroups === allGroups && allGroups > 0 ? "published" as const :
				committedGroups > 0 ? "partial" as const : "conflict" as const;
		const settledOp = await this.deps.journal.settle(operation.id, opState);
		if (stored.status === "publishing" || (stored.status === "conflict" && stored.conflictReason === "publish_uncertain")) {
			await this.deps.reviews.settlePublish(batch.id,
				opState === "published" ? "published" : opState === "partial" ? "partial" : "conflict",
				opState === "unknown" ? "publish_uncertain" : opState === "conflict" ? (hasExternal ? "publish_external" : "publish_interrupted") : undefined, true);
		}
		if (committedGroups > 0) {
			const ledger = await this.deps.acceptance.getSnapshot(binding.id);
			await this.deps.searchIndex.load(binding.id, ledger).catch(() => undefined);
		}
		return settledOp;
	}
}
