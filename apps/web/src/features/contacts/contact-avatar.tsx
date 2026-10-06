"use client";
import { useEffect, useRef, useState } from "react";
import { CameraIcon, CheckIcon, ImagePlusIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { builtinContactAvatarUrl, contactAvatarUrl, listContactAvatarOptions, saveContactAvatar, type ContactAvatarOption, type ContactSummary } from "@/lib/contacts";
import styles from "./contacts.module.css";

export function ContactAvatar({ vault, person, large = false }: { vault: string; person: ContactSummary; large?: boolean }) {
 const src = contactAvatarUrl(vault, person), [failed, setFailed] = useState<string>();
 return <span className={`${styles.avatar} ${large ? styles.large : ""}`}>
  {src && failed !== src ? /* Local Wiki files use the authorized asset endpoint, not Next image optimization. */
   // eslint-disable-next-line @next/next/no-img-element
   <img src={src} alt="" onError={() => setFailed(src)} /> : Array.from(person.name).slice(-2).join("")}
 </span>;
}

export function ContactAvatarEditor({ vault, person, onClose, onSaved }: { vault: string; person: ContactSummary; onClose: () => void; onSaved: (warning?: string) => void }) {
 const picker = useRef<HTMLInputElement>(null);
 const [image, setImage] = useState<string | null | undefined>(), [preview, setPreview] = useState<string>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
 const [options, setOptions] = useState<ContactAvatarOption[]>([]), [optionsError, setOptionsError] = useState(""), [optionsLoading, setOptionsLoading] = useState(true), [optionsRetry, setOptionsRetry] = useState(0);
 const [builtinId, setBuiltinId] = useState<string>(), [category, setCategory] = useState("全部");
 const active = useRef(true), selection = useRef(0);
 useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
 useEffect(() => {
  let current = true;
  void listContactAvatarOptions().then(items => { if (current) setOptions(items); }).catch(() => { if (current) setOptionsError("内置头像暂时无法加载，你也可以上传自己的图片。"); }).finally(() => { if (current) setOptionsLoading(false); });
  return () => { current = false; };
 }, [optionsRetry]);
 const currentOption = image === undefined && !builtinId ? options.find(option => person.avatar?.endsWith(`/${option.hash}.png`))?.id : undefined;
 const selectedOption = builtinId ?? currentOption;
 async function choose(file?: File) {
  if (!file) return;
  const serial = ++selection.current;
  setError(""); setImage(undefined); setPreview(undefined); setBuiltinId(undefined);
  if (!file.size || file.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("请选择 2 MB 以内的 JPG、PNG 或 WebP 图片"); return; }
  setReading(true);
  try {
   const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片读取失败，请重新选择")); reader.readAsDataURL(file); });
   await new Promise<void>((resolve, reject) => { const decoded = new Image(); decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error("这张图片无法打开，请选择其他图片")); decoded.src = data; });
   if (active.current && serial === selection.current) { setImage(data.slice(data.indexOf(",") + 1)); setPreview(data); }
  } catch (cause) { if (active.current && serial === selection.current) setError(cause instanceof Error ? cause.message : "图片读取失败"); }
  finally { if (active.current && serial === selection.current) setReading(false); }
 }
 async function save() {
  if (image === undefined && !builtinId || busy || reading) return;
  setBusy(true); setError("");
  try { const result = await saveContactAvatar(vault, person, builtinId ? { builtinId } : { image: image! }); if (active.current) onSaved(result.syncWarning); }
  catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "头像保存失败"); }
  finally { if (active.current) setBusy(false); }
 }
 return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className={styles.avatarDialog} showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
  <DialogHeader><DialogTitle>选择头像</DialogTitle><DialogDescription>选择内置头像，或上传头像</DialogDescription></DialogHeader>
  <div className={styles.avatarPreview}>
   {preview ? /* Local user-selected preview. */
    // eslint-disable-next-line @next/next/no-img-element
    <img src={preview} alt="新头像预览" /> : image === null ? <span>{Array.from(person.name).slice(-2).join("")}</span> : <ContactAvatar vault={vault} person={person} large />}
  </div>
  <button className={styles.avatarReset} disabled={busy || reading || image === null || !person.avatar && !preview} onClick={() => { selection.current++; setImage(null); setBuiltinId(undefined); setPreview(undefined); setError(""); }}>恢复默认</button>
  <section className={styles.avatarLibrary} aria-label="内置头像">
   <h3>内置头像</h3>
   {optionsLoading ? <p role="status" className={styles.avatarHint}>正在加载头像…</p> : optionsError ? <p role="alert" className={styles.avatarError}>{optionsError}<button disabled={busy} onClick={() => { setOptionsLoading(true); setOptionsError(""); setOptionsRetry(value => value + 1); }}>重试</button></p> : <>
    <div className={styles.avatarCategories} aria-label="头像分类">{["全部", ...new Set(options.map(option => option.category))].map(value => <button key={value} disabled={busy || reading} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</div>
    <div className={styles.avatarGrid}>{options.filter(option => category === "全部" || option.category === category).map(option => <button key={option.id} className={styles.avatarOption} aria-label={`选择${option.label}头像`} aria-pressed={selectedOption === option.id} disabled={busy || reading} onClick={() => { selection.current++; setBuiltinId(option.id); setImage(undefined); setPreview(builtinContactAvatarUrl(option)); setError(""); }}>
     {/* Bundled local images served by the same backend in development and releases. */}
     {/* eslint-disable-next-line @next/next/no-img-element */}
     <img src={builtinContactAvatarUrl(option)} alt="" loading="lazy" /><span>{option.label}</span>{selectedOption === option.id && <CheckIcon size={13} className={styles.avatarSelected} />}
    </button>)}</div>
   </>}
  </section>
  <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="选择头像图片" disabled={busy || reading} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
  <button className={styles.avatarChoose} disabled={busy || reading} onClick={() => picker.current?.click()}><ImagePlusIcon size={17} />{reading ? "正在读取图片…" : "上传头像"}</button>
  <p className={styles.avatarHint}>JPG、PNG 或 WebP，最大 2 MB</p>
  {error && <p role="alert" className={styles.avatarError}>{error}</p>}
  <div className={styles.avatarFooter}><button disabled={busy} onClick={onClose}>取消</button><button disabled={busy || reading || image === undefined && !builtinId} onClick={() => void save()}>{busy ? "正在保存…" : "保存头像"}</button></div>
 </DialogContent></Dialog>;
}

export function AvatarEditButton({ vault, person, onClick }: { vault: string; person: ContactSummary; onClick: () => void }) {
 return <button className={styles.avatarEdit} aria-label={`编辑${person.name}的头像`} title="编辑头像" onClick={onClick}><ContactAvatar vault={vault} person={person} large /><span className={styles.avatarCamera}><CameraIcon size={11} /></span></button>;
}
