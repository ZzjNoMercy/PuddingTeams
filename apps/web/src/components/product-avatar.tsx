import { cn } from "@/lib/utils";

export const PRODUCT_AVATAR_SRC = "/puddingteams-avatar.png";

/** PuddingTeams 的统一品牌头像；用于产品标识和 Manager 默认回退。 */
export function ProductAvatar({
	size = 32,
	className,
	label = "PuddingTeams",
	shape = "circle",
}: {
	size?: number;
	className?: string;
	label?: string;
	shape?: "circle" | "square";
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 overflow-hidden",
				shape === "circle" ? "rounded-full" : "rounded-[30%]",
				className,
			)}
			style={{ width: size, height: size }}
			title={label}
		>
			{/* eslint-disable-next-line @next/next/no-img-element -- shared static brand asset */}
			<img src={PRODUCT_AVATAR_SRC} alt={label} className="h-full w-full object-cover" />
		</span>
	);
}
