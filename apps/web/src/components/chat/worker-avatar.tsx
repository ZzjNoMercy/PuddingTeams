"use client";

import { useState } from "react";
import { BrainIcon } from "lucide-react";
import { useAgentAvatar } from "@/lib/avatars";
import { cn } from "@/lib/utils";

function hashName(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return h;
}

/**
 * Neutral, theme-bound avatar styles (monochrome discipline). Same name always
 * maps to the same style; different names decorrelate background and pattern
 * via separate hash bits. No hardcoded hues.
 */
const AVATAR_THEMES = [
	{ bg: "bg-muted", text: "text-foreground", pattern: "text-foreground/15" },
	{ bg: "bg-secondary", text: "text-secondary-foreground", pattern: "text-secondary-foreground/15" },
	{ bg: "bg-accent", text: "text-accent-foreground", pattern: "text-accent-foreground/15" },
	{ bg: "bg-primary", text: "text-primary-foreground", pattern: "text-primary-foreground/15" },
];

function avatarTheme(name: string) {
	const h = hashName(name);
	return AVATAR_THEMES[h % AVATAR_THEMES.length]!;
}

/**
 * Programmatic default avatar (§11): name hash → neutral theme + geometric
 * pattern, DiceBear/identicon style. Same name always renders the same avatar;
 * different names decorrelate theme and pattern via separate hash bits.
 * Pure SVG, zero dependencies, monochrome.
 */
function DefaultAvatar({ name, size }: { name: string; size: number }) {
	const h = hashName(name);
	const pattern = (h >>> 3) % 4;
	const theme = avatarTheme(name);
	return (
		<span
			className={cn(
				"relative flex h-full w-full items-center justify-center overflow-hidden rounded-full font-semibold",
				theme.bg,
				theme.text,
			)}
			style={{ fontSize: size * 0.38 }}
		>
			<svg
				viewBox="0 0 100 100"
				className={cn("absolute inset-0 h-full w-full", theme.pattern)}
				aria-hidden
			>
				{pattern === 0 && (
					<g fill="currentColor" opacity="0.22">
						<circle cx="84" cy="16" r="28" />
						<circle cx="12" cy="90" r="20" />
					</g>
				)}
				{pattern === 1 && <path d="M0 100 L100 0 L100 100 Z" fill="currentColor" opacity="0.18" />}
				{pattern === 2 && (
					<g fill="currentColor" opacity="0.25">
						<circle cx="20" cy="20" r="8" />
						<circle cx="80" cy="20" r="8" />
						<circle cx="20" cy="80" r="8" />
						<circle cx="80" cy="80" r="8" />
					</g>
				)}
				{pattern === 3 && (
					<circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="11" opacity="0.25" />
				)}
			</svg>
			<span className="relative">{name.slice(0, size < 20 ? 1 : 2).toUpperCase()}</span>
		</span>
	);
}

/**
 * Avatar for a team worker (§11): the uploaded image when one exists
 * (resolved by name via the shared avatar registry), falling back to the
 * programmatic default — also on load error (404 / gone file).
 */
export function WorkerAvatar({
	name,
	size = 24,
	className,
}: {
	name: string;
	size?: number;
	className?: string;
}) {
	const url = useAgentAvatar(name);
	// Record which URL failed rather than resetting a flag in an effect; a new
	// URL (upload/delete bump) automatically tries loading again.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const failed = url !== null && failedUrl === url;
	return (
		<span className={cn("inline-flex shrink-0 rounded-full", className)} style={{ width: size, height: size }} title={name}>
			{url && !failed ? (
				// eslint-disable-next-line @next/next/no-img-element -- dynamic user upload, not a static asset
				<img
					src={url}
					alt={name}
					onError={() => setFailedUrl(url)}
					className="h-full w-full rounded-full object-cover"
				/>
			) : (
				<DefaultAvatar name={name} size={size} />
			)}
		</span>
	);
}

/** Avatar for the pi manager, always present in every room. */
export function ManagerAvatar({ size = 24, className }: { size?: number; className?: string }) {
	// pinned manager（agent 名 "manager"）走同一头像注册表：pi Connector 声明了
	// 包内默认头像（lobehub Pi 图标），注册表装饰 hasDefaultAvatar 后即得 URL。
	const url = useAgentAvatar("manager");
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const failed = url !== null && failedUrl === url;
	return (
		<span
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				className,
			)}
			style={{ width: size, height: size }}
			title="pi manager"
		>
			{url && !failed ? (
				// eslint-disable-next-line @next/next/no-img-element -- connector 包内默认头像，动态 URL
				<img
					src={url}
					alt="pi manager"
					onError={() => setFailedUrl(url)}
					className="h-full w-full rounded-full object-cover"
				/>
			) : (
				<BrainIcon style={{ width: size * 0.55, height: size * 0.55 }} />
			)}
		</span>
	);
}

/**
 * 微信群式九宫格合成头像：圆角方块容器内按 1 / 2×2 / 3×3 网格排布成员
 * 头像（成员多/头像杂时叠放会糊成一团，见列表行）。超过 9 人末格 +N。
 * size 为容器边长，与列表/标题栏其他头像对齐。
 */
export function MemberStack({
	members,
	size = 36,
	className,
}: {
	members: { name: string }[];
	size?: number;
	className?: string;
}) {
	const MAX_CELLS = 9;
	const overflow = members.length > MAX_CELLS ? members.length - MAX_CELLS + 1 : 0;
	const shown = overflow ? members.slice(0, MAX_CELLS - 1) : members;
	const cells = shown.length + (overflow ? 1 : 0);
	const cols = cells <= 1 ? 1 : cells <= 4 ? 2 : 3;
	const pad = Math.round(size * 0.09);
	const gap = Math.max(1, Math.round(size * 0.06));
	const cell = cells <= 1 ? Math.round(size * 0.62) : Math.floor((size - pad * 2 - gap * (cols - 1)) / cols);
	return (
		<span
			className={cn("flex shrink-0 flex-wrap content-center items-center justify-center bg-muted", className)}
			style={{
				width: size,
				height: size,
				padding: cells <= 1 ? 0 : pad,
				gap,
				borderRadius: Math.max(6, Math.round(size * 0.22)),
			}}
			title={members.map((m) => m.name).join("、")}
		>
			{shown.map((m) => (
				<WorkerAvatar key={m.name} name={m.name} size={cell} />
			))}
			{overflow ? (
				<span
					className="flex items-center justify-center rounded-full bg-secondary font-medium text-secondary-foreground"
					style={{ width: cell, height: cell, fontSize: Math.max(8, Math.round(cell * 0.34)) }}
				>
					+{overflow}
				</span>
			) : null}
		</span>
	);
}
