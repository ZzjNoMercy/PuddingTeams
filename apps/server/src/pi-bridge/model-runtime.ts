import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * 进程级共享 ModelRuntime（模型目录 + 凭证）：PiSessionStore、pi worker
 * Driver、provider 管理路由共用同一份，models.json / auth.json 变更后由
 * 写路径调用 reset 强制重建（新会话即刻看到自定义 provider/模型；已创建
 * 的会话保持原模型，与 pi 自身行为一致）。
 *
 * 凭证解耦（§10.6）：authPath 指向 PUDDINGTEAMS_HOME/secrets/auth.json，
 * provider key 与 pi CLI 的 ~/.pi/agent/auth.json 完全隔离——平台里增删
 * key 不影响独立使用的 pi，pi 里配的 key 也不会出现在平台。模型目录层
 * （models.json 自定义 provider）仍与 pi CLI 共享。启动时必须先于首次
 * 使用调用 configureSharedModelRuntime；未配置则回退 SDK 默认（pi 全局
 * agentDir），仅供测试/工具进程使用。
 */
let promise: Promise<ModelRuntime> | null = null;
let authPath: string | undefined;

export function configureSharedModelRuntime(options: { authPath: string }): void {
	if (promise) throw new Error("sharedModelRuntime 已创建，configureSharedModelRuntime 必须先于首次使用");
	authPath = options.authPath;
}

export function sharedModelRuntime(): Promise<ModelRuntime> {
	promise ??= ModelRuntime.create(authPath ? { authPath } : undefined);
	return promise;
}

/** models.json / auth.json 外部变更后调用：下一次使用时重建。 */
export function resetSharedModelRuntime(): void {
	promise = null;
}
