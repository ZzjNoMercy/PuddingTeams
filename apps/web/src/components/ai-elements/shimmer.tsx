"use client";

import { type CSSProperties, type ElementType, memo, useMemo } from "react";
import { cn } from "@/lib/utils";

export type TextShimmerProps = {
	children: string;
	as?: ElementType;
	className?: string;
	duration?: number;
	spread?: number;
};

// CSS-only version of deer-flow's motion-based TextShimmer.
const ShimmerComponent = ({
	children,
	as: Component = "p",
	className,
	duration = 2,
	spread = 2,
}: TextShimmerProps) => {
	const dynamicSpread = useMemo(
		() => (children?.length ?? 0) * spread,
		[children, spread],
	);

	const style = {
		"--spread": `${dynamicSpread}px`,
		backgroundImage:
			"var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
		backgroundPosition: "100% center",
		animation: `text-shimmer ${duration}s linear infinite`,
	} as CSSProperties;

	return (
		<Component
			className={cn(
				"relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
				"[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
				className,
			)}
			style={style}
		>
			{children}
		</Component>
	);
};

export const Shimmer = memo(ShimmerComponent);
