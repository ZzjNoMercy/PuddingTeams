"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

/** Observe Next client navigations as well as browser history on static routes. */
export function QueryRouteObserver({ onChange }: { onChange: (query: string) => void }) {
	const query = useSearchParams().toString();
	useEffect(() => onChange(query), [onChange, query]);
	return null;
}
