import os from "node:os";
import type { FastifyInstance } from "fastify";

export interface ViewerIdentity {
	mode: "local" | "authenticated";
	user: {
		id: string;
		username: string;
		displayName: string;
	};
	tenant: {
		id: string;
		name: string;
	};
}

/** Local-first identity adapter. The API shape already separates user and
 * tenant so a future authenticated provider can replace this implementation
 * without changing navigation consumers or telemetry dimensions. */
export function localViewerIdentity(username = os.userInfo().username): ViewerIdentity {
	const normalized = username.trim() || "local-user";
	return {
		mode: "local",
		user: {
			id: `local:${normalized}`,
			username: normalized,
			displayName: normalized,
		},
		tenant: {
			id: "local",
			name: "本机",
		},
	};
}

export function registerIdentityRoutes(
	app: FastifyInstance,
	identityProvider: () => ViewerIdentity = localViewerIdentity,
): void {
	app.get("/api/identity", async () => identityProvider());
}
