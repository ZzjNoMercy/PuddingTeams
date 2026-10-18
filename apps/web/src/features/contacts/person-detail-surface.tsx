"use client";
import type { ReactNode } from "react";
import { ContactPreviewDialog } from "./contact-preview-dialog";
import styles from "./contacts.module.css";
import preview from "./contact-preview.module.css";

export function PersonDetailSurface({ modal, open, title, onClose, back, header, children }: {
 modal: boolean; open: boolean; title: string; onClose: () => void; back: ReactNode; header: ReactNode; children: ReactNode;
}) {
 if (!modal) return <article className={styles.detail}>{back}{header}{children}</article>;
 if (!open) return null;
 return <ContactPreviewDialog title={title} description="人物档案、往来记录与关联资料" onClose={onClose}>
  <div className={`${styles.page} ${preview.profile}`}>
   {header && <header className={preview.profileHeader}>{header}</header>}
   <article className={preview.profileBody}>{children}</article>
  </div>
 </ContactPreviewDialog>;
}
