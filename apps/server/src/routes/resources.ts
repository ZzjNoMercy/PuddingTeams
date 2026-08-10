import type { FastifyInstance, FastifyReply } from "fastify";
import {
	ResourceLibraryError,
	createSkill,
	createTemplate,
	deleteSkill,
	deleteTemplate,
	importSkill,
	importTemplate,
	listSkills,
	listTemplates,
	readSkill,
	readTemplate,
	updateSkill,
	updateTemplate,
	type SkillInput,
	type TemplateInput,
} from "../pi-bridge/resource-library.js";

/**
 * pi 资源库管理 API（§10.5）：操作 pi 全局目录（getAgentDir()）下的
 * skills/ 与 prompts/。错误码：400 校验失败 / 404 不存在 / 409 重名；
 * 写操作响应带 list 复扫的 diagnostics。
 */
export function registerResourcesRoutes(app: FastifyInstance): void {
	function sendError(reply: FastifyReply, err: unknown): unknown {
		if (err instanceof ResourceLibraryError) return reply.code(err.status).send({ error: err.message });
		const msg = err instanceof Error ? err.message : String(err);
		return reply.code(400).send({ error: msg });
	}

	function parseSkillInput(body: Partial<Record<string, unknown>> | null | undefined): SkillInput {
		if (!body || typeof body.content !== "string") {
			throw new ResourceLibraryError(400, "body must be { content: string, description?, disableModelInvocation? }");
		}
		if (body.description !== undefined && typeof body.description !== "string") {
			throw new ResourceLibraryError(400, "description 必须是字符串");
		}
		if (body.disableModelInvocation !== undefined && typeof body.disableModelInvocation !== "boolean") {
			throw new ResourceLibraryError(400, "disableModelInvocation 必须是布尔值");
		}
		return {
			content: body.content,
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(typeof body.disableModelInvocation === "boolean" ? { disableModelInvocation: body.disableModelInvocation } : {}),
		};
	}

	function parseTemplateInput(body: Partial<Record<string, unknown>> | null | undefined): TemplateInput {
		if (!body || typeof body.content !== "string") {
			throw new ResourceLibraryError(400, "body must be { content: string, description?, argumentHint? }");
		}
		if (body.description !== undefined && typeof body.description !== "string") {
			throw new ResourceLibraryError(400, "description 必须是字符串");
		}
		if (body.argumentHint !== undefined && typeof body.argumentHint !== "string") {
			throw new ResourceLibraryError(400, "argumentHint 必须是字符串");
		}
		return {
			content: body.content,
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(typeof body.argumentHint === "string" ? { argumentHint: body.argumentHint } : {}),
		};
	}

	function parseImportPath(body: Partial<Record<string, unknown>> | null | undefined): string {
		if (!body || typeof body.path !== "string" || !body.path.trim()) {
			throw new ResourceLibraryError(400, "body must be { path: string }");
		}
		return body.path;
	}

	// ---- skills ----

	app.get("/api/resources/skills", async () => listSkills());

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/resources/skills", async (req, reply) => {
		try {
			if (typeof req.body?.name !== "string") throw new ResourceLibraryError(400, "body must be { name, content, ... }");
			const skill = await createSkill(req.body.name, parseSkillInput(req.body));
			const { diagnostics } = await listSkills();
			return reply.code(201).send({ skill, diagnostics });
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.get<{ Params: { name: string } }>("/api/resources/skills/:name", async (req, reply) => {
		try {
			return { skill: await readSkill(req.params.name) };
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.put<{ Params: { name: string }; Body: Partial<Record<string, unknown>> }>(
		"/api/resources/skills/:name",
		async (req, reply) => {
			try {
				const skill = await updateSkill(req.params.name, parseSkillInput(req.body));
				const { diagnostics } = await listSkills();
				return { skill, diagnostics };
			} catch (err) {
				return sendError(reply, err);
			}
		},
	);

	app.delete<{ Params: { name: string } }>("/api/resources/skills/:name", async (req, reply) => {
		try {
			await deleteSkill(req.params.name);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/resources/skills/import", async (req, reply) => {
		try {
			const skill = await importSkill(parseImportPath(req.body));
			const { diagnostics } = await listSkills();
			return reply.code(201).send({ skill, diagnostics });
		} catch (err) {
			return sendError(reply, err);
		}
	});

	// ---- templates ----

	app.get("/api/resources/templates", async () => listTemplates());

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/resources/templates", async (req, reply) => {
		try {
			if (typeof req.body?.name !== "string") throw new ResourceLibraryError(400, "body must be { name, content, ... }");
			const template = await createTemplate(req.body.name, parseTemplateInput(req.body));
			const { diagnostics } = await listTemplates();
			return reply.code(201).send({ template, diagnostics });
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.get<{ Params: { name: string } }>("/api/resources/templates/:name", async (req, reply) => {
		try {
			return { template: await readTemplate(req.params.name) };
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.put<{ Params: { name: string }; Body: Partial<Record<string, unknown>> }>(
		"/api/resources/templates/:name",
		async (req, reply) => {
			try {
				const template = await updateTemplate(req.params.name, parseTemplateInput(req.body));
				const { diagnostics } = await listTemplates();
				return { template, diagnostics };
			} catch (err) {
				return sendError(reply, err);
			}
		},
	);

	app.delete<{ Params: { name: string } }>("/api/resources/templates/:name", async (req, reply) => {
		try {
			await deleteTemplate(req.params.name);
			return reply.code(204).send();
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/resources/templates/import", async (req, reply) => {
		try {
			const template = await importTemplate(parseImportPath(req.body));
			const { diagnostics } = await listTemplates();
			return reply.code(201).send({ template, diagnostics });
		} catch (err) {
			return sendError(reply, err);
		}
	});
}
