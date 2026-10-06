"use client";

import { useEffect } from "react";
import { installFocusModality } from "@/lib/focus-modality";

export function FocusModality() {
	useEffect(() => installFocusModality(document), []);
	return null;
}
