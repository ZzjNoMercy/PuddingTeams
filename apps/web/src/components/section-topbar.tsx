"use client";

import Link from "next/link";
import { ChevronRightIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { toggleAppSidebar, useAppSidebarHidden } from "@/components/desktop-titlebar";

export interface SectionCrumb {
	label: string;
	/** 末级忽略 href，一律渲染纯文本（当前位置）。 */
	href?: string;
}

/** 与原型顶部一致的侧栏开关，工作台和各模块共用。 */
export function SectionSidebarToggle() {
	const sidebarHidden = useAppSidebarHidden();
	const Icon = sidebarHidden ? PanelLeftOpenIcon : PanelLeftCloseIcon;
	return (
		<button
			type="button"
			className="m1-section-sidebar-toggle"
			aria-label={sidebarHidden ? "展开侧边栏" : "收起侧边栏"}
			aria-expanded={!sidebarHidden}
			aria-controls="app-primary-navigation"
			onClick={toggleAppSidebar}
		>
			<Icon size={17} aria-hidden="true" />
		</button>
	);
}

/** 页面位置栏：侧栏开关 + 当前页面/面包屑，具体页面标题仍留在内容层。 */
export function SectionTopbar({ title, crumbs }: { title?: string; crumbs?: SectionCrumb[] }) {
	const location: SectionCrumb[] = crumbs?.length ? crumbs : title ? [{ label: title }] : [];
	return (
		<header className="m1-section-topbar">
			<SectionSidebarToggle />
			{location.length > 0 ? (
				<nav aria-label="当前位置" className="m1-section-crumbs">
					{location.map((crumb, index) => {
						const last = index === location.length - 1;
						return (
							<span key={`${index}-${crumb.label}`} className="m1-section-crumb">
								{index > 0 ? <ChevronRightIcon size={13} aria-hidden="true" className="m1-section-crumb-sep" /> : null}
								{crumb.href && !last ? (
									<Link href={crumb.href}>{crumb.label}</Link>
								) : (
									<span {...(last ? { "aria-current": "page" as const } : {})}>{crumb.label}</span>
								)}
							</span>
						);
					})}
				</nav>
			) : null}
		</header>
	);
}
