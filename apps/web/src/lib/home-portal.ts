/**
 * 首页浮层（下拉菜单等）的 Portal 容器：--home-* 皮肤变量定义在 .home-shell
 * 作用域内，Radix 默认 portal 到 document.body 会取不到变量（背景/描边投影
 * 全部失效），所以首页皮肤的浮层统一挂进 .home-shell。
 */
export function homePortalContainer(): HTMLElement | undefined {
	if (typeof document === "undefined") return undefined;
	return document.querySelector<HTMLElement>(".home-shell") ?? undefined;
}
