"use client";
import { useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import styles from "./contact-preview.module.css";

export function ContactPreviewDialog({ title, description, onClose, children }: {
 title: string; description: string; onClose: () => void; children: ReactNode;
}) {
 const returnFocus = useRef(typeof document === "undefined" ? null : document.activeElement);
 return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
  <DialogContent className={styles.dialog} onCloseAutoFocus={event => {
   event.preventDefault();
   const target = returnFocus.current;
   if (target?.isConnected && "focus" in target) (target as HTMLElement | SVGElement).focus({ preventScroll: true });
  }}>
   <DialogTitle className="sr-only">{title}</DialogTitle>
   <DialogDescription className="sr-only">{description}</DialogDescription>
   {children}
  </DialogContent>
 </Dialog>;
}
