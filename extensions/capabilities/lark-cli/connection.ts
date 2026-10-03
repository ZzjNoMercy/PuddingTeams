import { randomUUID } from "node:crypto";

/** Host-independent core: storage is supplied by the host, never by a Pi API. */
export interface ConnectionVault {
	read(): Promise<string | undefined>;
	write(value: string): Promise<void>;
}
export interface UserCredential {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	refreshExpiresAt?: number;
	scope: string;
	userName?: string;
	/** Persisted before consuming a one-use refresh token, including crash recovery. */
	refreshState?: "pending";
}
export interface ConnectionCredential {
	appId: string;
	appSecret: string;
	user?: UserCredential;
	bot?: { accessToken: string; expiresAt: number };
}
export interface AuthorizationView {
	id: string;
	state: "pending" | "completed" | "failed" | "expired" | "cancelled";
	verificationUrl?: string;
	qrCodeDataUrl?: string;
	expiresAt: string;
	message?: string;
}
export interface AuthorizationOptions {
	scope?: string;
	domains?: string[];
	exclude?: string[];
	recommend?: boolean;
}
interface PendingAuthorization {
	view: AuthorizationView;
	deviceCode?: string;
	appId: string;
	revision: number;
	interval: number;
	nextPoll: number;
	controller: AbortController;
	poll?: Promise<void>;
	timer: ReturnType<typeof setTimeout>;
}

const ACCOUNTS = "https://accounts.feishu.cn";
const OPEN = "https://open.feishu.cn";
const DEFAULT_SCOPE = "auth:user.id:read offline_access";
const AHEAD = 60_000;
function scopes(value: string): string[] {
	const result = value.split(/[\s,]+/).filter(Boolean);
	if (result.some(s => !/^[a-z0-9_.:]+$/.test(s)) || result.length > 2000) throw new Error("授权范围格式无效");
	return [...new Set(result)];
}
function seconds(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("飞书返回了无效的凭证有效期");
	return value * 1000;
}
class OAuthError extends Error {
	constructor(readonly type: string, readonly code?: number) { super("飞书认证请求未通过，请检查应用配置、权限或重新授权"); }
}

/** One authority per backend data-home (the host already holds its single-writer lease).
 * Both HTTP and CLI entry points call this object. Rotation and reauthorization use
 * the SAME queue; the encrypted record is persisted before a token is handed out.
 */
export class LarkConnection {
	private queue: Promise<unknown> = Promise.resolve();
	private revision = 0;
	private sessions = new Map<string, PendingAuthorization>();
	private starting?: Promise<AuthorizationView>;
	private refreshUncertain = false;
	constructor(private readonly vault: ConnectionVault, private readonly options: {
		fetch?: typeof fetch;
		now?: () => number;
		qr?: (url: string) => Promise<string>;
	} = {}) {}
	private now() { return this.options.now?.() ?? Date.now(); }
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}
	private async read(): Promise<ConnectionCredential | undefined> {
		const raw = await this.vault.read();
		if (!raw) return undefined;
		let record: ConnectionCredential;
		try { record = JSON.parse(raw) as ConnectionCredential; }
		catch { throw new Error("共享飞书凭证损坏，请检查凭证存储"); }
		if (!record.appId || !record.appSecret) throw new Error("共享飞书凭证损坏，请检查凭证存储");
		return record;
	}
	private async save(record: ConnectionCredential) { await this.vault.write(JSON.stringify(record)); }
	private async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
		try {
			const response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
			const data = await response.json() as Record<string, unknown>;
			if (!response.ok || data.error || (typeof data.code === "number" && data.code !== 0)) throw new OAuthError(typeof data.error === "string" ? data.error : "api_error", typeof data.code === "number" ? data.code : undefined);
			return data;
		} catch (error) {
			if (error instanceof OAuthError) throw error;
			// Never propagate network/server response text: it may contain credentials.
			throw new Error("飞书请求超时或网络不可用，请稍后重试");
		}
	}
	private oauth(record: ConnectionCredential, fields: Record<string, string>, signal?: AbortSignal) {
		return this.request(`${ACCOUNTS}/oauth/v3/token`, {
			method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: record.appId, client_secret: record.appSecret, ...fields }),
		}, signal);
	}
	private token(data: Record<string, unknown>): UserCredential {
		if (typeof data.access_token !== "string" || !data.access_token || (data.token_type && data.token_type !== "Bearer")) throw new Error("飞书未返回可用的共享访问凭证");
		return {
			accessToken: data.access_token, expiresAt: this.now() + seconds(data.expires_in),
			...(typeof data.refresh_token === "string" && data.refresh_token ? { refreshToken: data.refresh_token, refreshExpiresAt: this.now() + seconds(data.refresh_token_expires_in) } : {}),
			scope: typeof data.scope === "string" ? scopes(data.scope).join(" ") : "",
		};
	}
	async settings() {
		await this.queue;
		const record = await this.read();
		return { configured: Boolean(record), appId: record?.appId ?? "", secretConfigured: Boolean(record?.appSecret), scope: record?.user?.scope ?? "", accountName: record?.user?.userName };
	}
	async configure(input: { appId: string; appSecret?: string; confirmReplace?: boolean }) {
		if (typeof input.appId !== "string" || !/^cli_[a-zA-Z0-9]+$/.test(input.appId)) throw new Error("请输入有效的飞书应用 ID");
		if (input.appSecret !== undefined && (typeof input.appSecret !== "string" || !input.appSecret.trim() || input.appSecret.length > 4096)) throw new Error("请输入有效的应用密钥");
		await this.serialize(async () => {
			const old = await this.read();
			const changed = old && old.appId !== input.appId;
			if (changed && !input.confirmReplace) throw new Error("切换应用会清除原应用的共享用户凭证，请确认后保存");
			const secret = input.appSecret?.trim() ?? (!changed ? old?.appSecret : undefined);
			if (!secret) throw new Error("首次配置或切换应用需要应用密钥");
			// Validate BEFORE replacing the working connection; no user authorization.
			const record: ConnectionCredential = { appId: input.appId, appSecret: secret, ...(!changed && old?.user ? { user: old.user } : {}) };
			await this.botToken(record);
			await this.save(record);
			this.revision++;
			this.cancelAll();
			this.refreshUncertain = false;
		});
		return this.settings();
	}
	/** Explicit adoption of an existing encrypted CLI credential; never asks for consent again. */
	async adopt(record: ConnectionCredential) {
		await this.serialize(async () => {
			if (await this.read()) throw new Error("共享连接已配置，不能覆盖；请在设置中显式切换应用");
			if (!/^cli_[a-zA-Z0-9]+$/.test(record.appId) || !record.appSecret) throw new Error("本机应用凭证无效");
			await this.botToken(record);
			await this.save(record);
			this.revision++;
		});
		return this.settings();
	}
	private async botToken(record: ConnectionCredential, force = false): Promise<string> {
		if (!force && record.bot && record.bot.expiresAt > this.now() + AHEAD) return record.bot.accessToken;
		const data = await this.request(`${OPEN}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: record.appId, app_secret: record.appSecret }),
		});
		if (typeof data.tenant_access_token !== "string" || !data.tenant_access_token) throw new Error("无法确认飞书应用连接");
		record.bot = { accessToken: data.tenant_access_token, expiresAt: this.now() + seconds(data.expire) };
		return record.bot.accessToken;
	}
	private async userToken(record: ConnectionCredential, force = false): Promise<string> {
		const user = record.user;
		if (!user) throw new Error("尚未完成用户授权，请在连接状态或 CLI 发起授权");
		if (!force && user.expiresAt > this.now() + AHEAD) return user.accessToken;
		if (this.refreshUncertain || user.refreshState === "pending") throw new Error("凭证更新结果不确定，请重新授权以恢复共享连接");
		if (!user.refreshToken || !user.refreshExpiresAt || user.refreshExpiresAt <= this.now()) throw new Error("用户授权已失效，请重新授权");
		let data: Record<string, unknown>;
		// A restart must not replay an already consumed one-time refresh token.
		user.refreshState = "pending";
		await this.save(record);
		try { data = await this.oauth(record, { grant_type: "refresh_token", refresh_token: user.refreshToken }); }
		catch (error) {
			if (error instanceof OAuthError && ([20026, 20037, 20064, 20073].includes(error.code ?? 0) || error.type === "invalid_grant")) {
				delete user.refreshToken;
				delete user.refreshState;
				user.expiresAt = 0;
				await this.save(record);
			} else if (error instanceof OAuthError) {
				delete user.refreshState;
				await this.save(record);
			} else this.refreshUncertain = true;
			throw error;
		}
		try {
			record.user = { ...this.token(data), ...(user.userName ? { userName: user.userName } : {}) };
			await this.save(record); // rotated refresh token must reach disk before returning
		} catch {
			this.refreshUncertain = true;
			throw new Error("共享凭证未能安全保存，请重新授权；不会再次使用已消费的刷新令牌");
		}
		return record.user.accessToken;
	}
	async accessToken(identity: "user" | "bot", force = false): Promise<string> {
		return this.serialize(async () => {
			const record = await this.read();
			if (!record) throw new Error("请先在设置中配置飞书默认应用或导入本机连接");
			if (identity === "user") return this.userToken(record, force);
			const token = await this.botToken(record, force);
			await this.save(record);
			return token;
		});
	}
	/** Only the authenticated local CLI broker receives this projection. */
	async cliCredential(identity: "user" | "bot" = "user") {
		return this.serialize(async () => {
			const record = await this.read();
			if (!record) throw new Error("请先配置飞书默认应用");
			const token = identity === "user" ? await this.userToken(record) : await this.botToken(record);
			if (identity === "bot") await this.save(record);
			return { appId: record.appId, identity, accessToken: token };
		});
	}
	async status() {
		let error: string | undefined;
		let botReady = false;
		let userRejected = false;
		try {
			if ((await this.settings()).configured) { await this.accessToken("bot"); botReady = true; }
			const record = await this.read();
			if (record?.user) {
				const token = await this.accessToken("user");
				try { await this.request(`${OPEN}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${token}` } }); }
				catch (e) { userRejected = e instanceof OAuthError; throw e; }
			}
		} catch (e) { error = e instanceof Error ? e.message : "飞书连接检查失败"; }
		await this.queue;
		const record = await this.read();
		const userAuthorization = !record?.user ? "missing" as const : record.user.expiresAt > this.now() && !this.refreshUncertain && !userRejected ? "authorized" as const : "expired" as const;
		return {
			id: "default", name: "飞书", description: "平台与 Agent 共用的飞书连接",
			state: !record ? "disconnected" as const : error ? "error" as const : botReady ? "connected" as const : "disconnected" as const,
			userAuthorization, ...(record?.user?.userName ? { accountName: record.user.userName } : {}),
			identity: userAuthorization === "authorized" ? "用户与应用身份" : "应用身份",
			message: !record ? "请在设置 → 飞书默认应用配置或导入已有连接" : error ?? (userAuthorization === "authorized" ? "共享凭证有效" : "应用已连接，用户尚未授权"),
			actions: record ? [{ id: "authorize-user", kind: "authorization" as const, label: userAuthorization === "missing" ? "用户授权" : "重新授权", description: "平台与 CLI 更新同一套共享凭证" }] : [],
			checkedAt: new Date(this.now()).toISOString(),
		};
	}
	private async authorizationScope(record: ConnectionCredential, input: AuthorizationOptions): Promise<string> {
		const set = new Set(scopes(record.user?.scope || DEFAULT_SCOPE));
		for (const s of scopes(input.scope ?? "")) set.add(s);
		if (input.domains?.length || input.recommend) {
			const data = await this.request(`${OPEN}/lark-cli/apis/scopes.json`);
			const catalog = data.scopes as Record<string, { user_scopes?: unknown }> | undefined;
			if (!catalog || typeof catalog !== "object") throw new Error("无法读取官方业务权限列表，请使用 --scope 指定范围");
			const domains = input.recommend || input.domains?.includes("all") ? Object.keys(catalog) : input.domains!;
			for (const domain of domains) {
				const list = catalog[domain]?.user_scopes;
				if (!Array.isArray(list) || list.some(s => typeof s !== "string")) throw new Error("业务域不存在或官方权限列表无效，请使用 --scope");
				for (const s of scopes(list.join(" "))) if (s !== "im:message.send_as_user") set.add(s);
			}
		}
		for (const s of input.exclude ?? []) for (const item of scopes(s)) set.delete(item);
		set.add("offline_access");
		return [...set].sort().join(" ");
	}
	async begin(input: AuthorizationOptions = {}): Promise<AuthorizationView> {
		if (this.starting) throw new Error("正在创建授权入口，请稍后重试");
		this.starting = this.serialize(async () => {
			const record = await this.read();
			if (!record) throw new Error("请先配置飞书默认应用");
			this.cancelAll();
			const scope = await this.authorizationScope(record, input);
			const data = await this.request(`${ACCOUNTS}/oauth/v1/device_authorization`, {
				method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${record.appId}:${record.appSecret}`).toString("base64")}` },
				body: new URLSearchParams({ client_id: record.appId, scope }),
			});
			const verificationUrl = data.verification_uri_complete ?? data.verification_uri;
			if (typeof verificationUrl !== "string" || typeof data.device_code !== "string" || !data.device_code) throw new Error("飞书未返回有效授权入口");
			const url = new URL(verificationUrl);
			if (url.protocol !== "https:" || url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw new Error("飞书返回了非官方授权地址");
			const ttl = Math.min(seconds(data.expires_in), 600_000);
			const view: AuthorizationView = { id: randomUUID(), state: "pending", verificationUrl, expiresAt: new Date(this.now() + ttl).toISOString(), ...(this.options.qr ? { qrCodeDataUrl: await this.options.qr(verificationUrl) } : {}) };
			const session: PendingAuthorization = { view, appId: record.appId, revision: this.revision, deviceCode: data.device_code, interval: typeof data.interval === "number" ? Math.max(1000, data.interval * 1000) : 5000, nextPoll: 0, controller: new AbortController(), timer: setTimeout(() => this.finish(session, "expired", "授权入口已过期，请重新发起"), ttl) };
			session.timer.unref();
			this.sessions.set(view.id, session);
			setTimeout(() => this.sessions.delete(view.id), ttl + 60_000).unref();
			return { ...view };
		}).finally(() => { this.starting = undefined; });
		return this.starting;
	}
	private finish(session: PendingAuthorization, state: AuthorizationView["state"], message: string) {
		if (session.view.state !== "pending") return;
		session.view = { id: session.view.id, state, expiresAt: session.view.expiresAt, message };
		delete session.deviceCode;
		clearTimeout(session.timer);
		session.controller.abort();
	}
	private cancelAll() { for (const s of this.sessions.values()) this.finish(s, "cancelled", "授权流程已取消或替换"); }
	private async poll(session: PendingAuthorization) {
		await this.serialize(async () => {
			if (session.view.state !== "pending") return;
			const record = await this.read();
			if (!record || record.appId !== session.appId || this.revision !== session.revision) { this.finish(session, "cancelled", "应用配置已变更，请重新发起"); return; }
			try {
				const data = await this.oauth(record, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: session.deviceCode! }, session.controller.signal);
				const user = this.token(data);
				if (session.view.state !== "pending" || this.now() >= Date.parse(session.view.expiresAt)) return;
				// Persist immediately: a profile lookup failing must not lose a consumed device code.
				record.user = user;
				await this.save(record);
				this.refreshUncertain = false;
				this.revision++;
				try {
					const profile = await this.request(`${OPEN}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${user.accessToken}` } });
					const name = (profile.data as { name?: unknown } | undefined)?.name;
					if (typeof name === "string") { user.userName = name; await this.save(record); }
				} catch { /* Name enrichment is optional; token issuance already succeeded. */ }
				this.finish(session, "completed", "共享用户凭证已更新，平台与 CLI 均可使用");
			} catch (error) {
				if (session.view.state !== "pending") return;
				if (error instanceof OAuthError && ["authorization_pending", "slow_down"].includes(error.type)) {
					if (error.type === "slow_down") session.interval = Math.min(60_000, session.interval + 5000);
				} else this.finish(session, "failed", error instanceof Error ? error.message : "授权失败，请重试");
			}
			finally { session.nextPoll = this.now() + session.interval; }
		});
	}
	async authorizationStatus(id: string): Promise<AuthorizationView | undefined> {
		const session = this.sessions.get(id);
		if (!session) return undefined;
		if (this.now() >= Date.parse(session.view.expiresAt)) this.finish(session, "expired", "授权入口已过期，请重新发起");
		if (session.view.state === "pending" && !session.poll && this.now() >= session.nextPoll) {
			session.poll = this.poll(session).catch(() => this.finish(session, "failed", "共享凭证处理失败，请重试")).finally(() => { session.poll = undefined; });
		}
		return { ...session.view };
	}
	async cancel(id: string) { const session = this.sessions.get(id); if (session) this.finish(session, "cancelled", "已停止等待，不撤销已有授权"); }
	async logout() { await this.serialize(async () => { const record = await this.read(); if (record) { delete record.user; await this.save(record); } this.revision++; this.cancelAll(); }); }
	close() { this.cancelAll(); }
}
