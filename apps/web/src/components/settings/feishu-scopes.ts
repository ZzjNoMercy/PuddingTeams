/** 飞书授权 scope 的展示拆分：按业务域分组、按读写风险分类。仅服务设置页展示，不参与授权决策。 */
export type ScopeRisk = "read" | "write" | "danger";

const DOMAIN_LABEL: Record<string, string> = {
	application: "应用快捷指令",
	approval: "审批",
	attendance: "考勤",
	auth: "身份",
	base: "多维表格",
	board: "画板",
	calendar: "日历",
	contact: "通讯录",
	docs: "云文档",
	docx: "旧版文档",
	drive: "云空间",
	im: "即时通讯",
	mail: "邮箱",
	mindnote: "思维笔记",
	minutes: "妙记",
	offline_access: "令牌续期",
	okr: "OKR",
	profile: "个人资料",
	search: "搜索",
	sheets: "电子表格",
	slides: "幻灯片",
	space: "知识空间",
	spark: "妙搭",
	task: "任务",
	vc: "视频会议",
	wiki: "知识库",
};

const DANGER_ACTION = /(^|:)(delete|transfer|manage|moderate|recall|destroy|remove|clear)($|:)/;
const WRITE_ACTION = /(^|:)(write|write_only|update|create|copy|move|import|upload|send|apply|reply|add|set|enable|disable|start|stop|patch)($|:)/;

export function scopeRisk(scope: string): ScopeRisk {
	if (DANGER_ACTION.test(scope)) return "danger";
	if (WRITE_ACTION.test(scope)) return "write";
	return "read";
}

/** scope 的业务域即第一个冒号之前的部分；无冒号的（如 offline_access）自成一组。 */
export function scopeDomain(scope: string): string {
	const at = scope.indexOf(":");
	return at < 0 ? scope : scope.slice(0, at);
}

/** 组内省略业务域前缀，只留动作部分，避免重复。 */
export function scopeAction(scope: string, domain: string): string {
	return scope === domain ? scope : scope.slice(domain.length + 1);
}

export function domainLabel(domain: string): string {
	return DOMAIN_LABEL[domain] ?? domain;
}

export type ScopeGroup = {
	domain: string;
	label: string;
	scopes: string[];
	write: number;
	danger: number;
};

const RISK_ORDER: Record<ScopeRisk, number> = { danger: 0, write: 1, read: 2 };

/** 域内先按风险排序（删除/管理在前），同风险按字母序；域间按数量降序，同数量按域名稳定排序。 */
export function groupScopes(scope: string): ScopeGroup[] {
	const byDomain = new Map<string, Set<string>>();
	for (const item of scope.split(/\s+/).filter(Boolean)) {
		const domain = scopeDomain(item);
		const set = byDomain.get(domain);
		if (set) set.add(item);
		else byDomain.set(domain, new Set([item]));
	}
	return [...byDomain].map(([domain, items]) => {
		const scopes = [...items].sort((a, b) => RISK_ORDER[scopeRisk(a)] - RISK_ORDER[scopeRisk(b)] || a.localeCompare(b));
		return {
			domain,
			label: domainLabel(domain),
			scopes,
			write: scopes.filter(item => scopeRisk(item) === "write").length,
			danger: scopes.filter(item => scopeRisk(item) === "danger").length,
		};
	}).sort((a, b) => b.scopes.length - a.scopes.length || a.domain.localeCompare(b.domain));
}

export function scopeTotal(groups: ScopeGroup[]): number {
	return groups.reduce((sum, group) => sum + group.scopes.length, 0);
}
