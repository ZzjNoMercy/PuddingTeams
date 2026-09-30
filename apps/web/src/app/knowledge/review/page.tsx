"use client";

import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { KnowledgeReviewApp } from "@/features/knowledge/review-app";

export default function KnowledgeReviewPage() {
	return (
		<div className="desktop-app-frame m1-app-shell m1-knowledge-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="review" />
				</div>
				<Suspense>
					<KnowledgeReviewApp />
				</Suspense>
			</div>
		</div>
	);
}
