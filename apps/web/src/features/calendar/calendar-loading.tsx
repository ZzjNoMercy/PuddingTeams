import { LoaderCircleIcon } from "lucide-react";
import styles from "./calendar.module.css";

export function CalendarLoading({ local, external }: { local: boolean; external: boolean }) {
	if (!local && !external) return null;
	return <div className={styles.loadingOverlay} role="status" aria-live="polite" aria-atomic="true">
		<div className={styles.loadingIndicator}>
			<LoaderCircleIcon size={36} className={styles.loadingSpinner} aria-hidden="true" />
			<span>{external ? "正在读取外部日程…" : "正在加载日历…"}</span>
		</div>
	</div>;
}
