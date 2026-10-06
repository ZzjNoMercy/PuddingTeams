"use client";

import { useState } from "react";
import { CameraIcon, Trash2Icon } from "lucide-react";
import { deleteViewerAvatar, updateViewerProfile, uploadViewerAvatar, viewerAvatarUrl } from "@/lib/api";
import type { ViewerIdentity } from "@/lib/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase() : Array.from(parts[0] ?? "用户").slice(0, 2).join("").toUpperCase();
}

export function ProfileDialog({
	open,
	onOpenChange,
	identity,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	identity: ViewerIdentity;
	onSaved: (identity: ViewerIdentity) => void;
}) {
	const [displayName, setDisplayName] = useState(identity.user.displayName);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const changeOpen = (next: boolean) => {
		if (next) { setDisplayName(identity.user.displayName); setError(""); setNotice(""); }
		onOpenChange(next);
	};
	const run = async (action: () => Promise<ViewerIdentity>, success: string) => {
		setBusy(true);
		setError("");
		setNotice("");
		try { onSaved(await action()); setNotice(success); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
		finally { setBusy(false); }
	};
	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="home-profile-dialog">
				<DialogHeader>
					<DialogTitle>编辑个人资料</DialogTitle>
					<DialogDescription>自定义侧栏显示的头像和名称，不会修改系统账户或历史记录归属。</DialogDescription>
				</DialogHeader>
				<div className="home-profile-avatar-row">
					<span className="home-profile-avatar" aria-hidden="true">
						{identity.user.avatarVersion !== undefined ? (
							// Local API image; this app uses static export without an image optimizer.
							// eslint-disable-next-line @next/next/no-img-element
							<img src={viewerAvatarUrl(identity.user.avatarVersion)} alt="" />
						) : initials(identity.user.displayName)}
					</span>
					<div className="home-profile-avatar-actions">
						<label className="home-profile-button" htmlFor="viewer-avatar-upload"><CameraIcon size={16} />更换头像</label>
						<input id="viewer-avatar-upload" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} className="sr-only" onChange={(event) => {
							const file = event.currentTarget.files?.[0];
							if (file) void run(() => uploadViewerAvatar(file), "头像已保存");
							event.currentTarget.value = "";
						}} />
						{identity.user.avatarVersion !== undefined ? <button type="button" className="home-profile-button muted" disabled={busy} onClick={() => void run(deleteViewerAvatar, "已移除头像")}><Trash2Icon size={15} />移除</button> : null}
						<small>PNG、JPEG 或 WebP，最大 2 MB。选择后立即保存。</small>
					</div>
				</div>
				<form onSubmit={(event) => { event.preventDefault(); void run(() => updateViewerProfile(displayName), "名称已保存"); }}>
					<label htmlFor="viewer-display-name">显示名称</label>
					<input id="viewer-display-name" autoComplete="nickname" maxLength={40} value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy} />
					<p className="home-profile-account">系统账户：{identity.user.username}</p>
					{error ? <p className="home-profile-feedback error" role="alert">{error}</p> : null}
					{notice ? <p className="home-profile-feedback" role="status">{notice}</p> : null}
					<div className="home-profile-footer"><button type="button" className="home-profile-button muted" onClick={() => changeOpen(false)}>关闭</button><button type="submit" className="home-profile-save" disabled={busy || !displayName.trim() || displayName.trim() === identity.user.displayName}>{busy ? "保存中…" : "保存名称"}</button></div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
