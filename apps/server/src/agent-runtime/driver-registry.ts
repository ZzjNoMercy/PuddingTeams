import type { AgentDriver } from "./types.js";

/**
 * DriverRegistry：Driver SPI 的注册与选择（方案 §3.1）。
 *
 * 具体 Driver 来自 Connector Extension 包；PuddingTeams 核心只内置第一方
 * PuddingClaw Driver 的注册入口。
 */
export class DriverRegistry {
	private readonly drivers = new Map<string, AgentDriver>();

	register(driver: AgentDriver): void {
		this.drivers.set(driver.id, driver);
	}

	/** Unregister（Connector 卸载/更新时由宿主调用）。 */
	unregister(id: string): boolean {
		return this.drivers.delete(id);
	}

	get(id: string): AgentDriver | undefined {
		return this.drivers.get(id);
	}

	list(): AgentDriver[] {
		return [...this.drivers.values()];
	}
}
