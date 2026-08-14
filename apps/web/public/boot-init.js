// 首帧初始化：hydration 前执行，防主题 FOUC 与导航展开闪动。
// 由 layout.tsx 以 <script async src="/boot-init.js"> 引入（React 19 提升到 head）。
// - dark class：localStorage 主题 / 系统偏好
// - data-nav="expanded"：导航展开偏好（缺省收起）；NavRail 的布局/文字全由
//   CSS 按此属性驱动，React 渲染与状态无关，SSR/客户端 HTML 恒一致。
(function () {
	try {
		var t = localStorage.getItem("puddingteams-theme");
		var dark = t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
		if (dark) document.documentElement.classList.add("dark");
		if (localStorage.getItem("puddingteams:nav-collapsed") === "0") {
			document.documentElement.dataset.nav = "expanded";
		}
	} catch {}
})();
