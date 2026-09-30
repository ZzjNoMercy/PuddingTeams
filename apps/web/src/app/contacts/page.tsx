"use client";
import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { ContactsApp } from "@/features/contacts/contacts-app";
export default function ContactsPage() {
 return <div className="desktop-app-frame m1-app-shell h-dvh"><DesktopTitlebar /><div className="desktop-app-body"><div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell><NavRail view="contacts" /></div><main className="flex min-w-0 flex-1 flex-col bg-background"><Suspense fallback={<SectionTopbar title="通讯录" />}><ContactsApp /></Suspense></main></div></div>;
}
