"use client";

import { Toaster } from "sonner";
import { useTheme } from "./theme-provider";

/** sonner Toaster bound to the app theme (light/dark/system). */
export function AppToaster() {
	const { theme } = useTheme();
	return <Toaster theme={theme} position="bottom-right" />;
}
