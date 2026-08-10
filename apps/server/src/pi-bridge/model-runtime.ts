import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * 进程级共享 ModelRuntime（模型目录 + 凭证）：PiSessionStore、pi worker
 * Driver、provider 管理路由共用同一份，models.json / auth.json 变更后由
 * 写路径调用 reset 强制重建（新会话即刻看到自定义 provider/模型；已创建
 * 的会话保持原模型，与 pi 自身行为一致）。
 */
let promise: Promise<ModelRuntime> | null = null;

export function sharedModelRuntime(): Promise<ModelRuntime> {
	promise ??= ModelRuntime.create();
	return promise;
}

/** models.json / auth.json 外部变更后调用：下一次使用时重建。 */
export function resetSharedModelRuntime(): void {
	promise = null;
}
