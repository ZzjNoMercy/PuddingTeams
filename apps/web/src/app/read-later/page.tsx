"use client";
import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { ReadLaterApp } from "@/features/read-later/read-later-app";
export default function ReadLaterPage() {
  return (
    <div className="desktop-app-frame m1-app-shell m1-knowledge-shell h-dvh">
      <DesktopTitlebar />
      <div className="desktop-app-body">
        <div
          className="desktop-sidebar-stack desktop-sidebar-nav-only"
          data-app-sidebar-shell
        >
          <NavRail view="read-later" />
        </div>
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <Suspense fallback={<SectionTopbar title="稍后读" />}>
            <ReadLaterApp />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
