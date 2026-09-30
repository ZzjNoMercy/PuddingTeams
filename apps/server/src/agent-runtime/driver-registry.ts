import type { AgentDriver, DriverTransport } from "./types.js";

/** 按 Connector binding config 构造 Driver 的工厂（同一 Connector 可多实例）。 */
export type DriverFactory = (config: Record<string, unknown>, transport: DriverTransport) => AgentDriver;

/**
 * DriverRegistry：Driver SPI 的注册与选择（方案 §3.1）。
 *
 * 具体 Driver 来自 Connector Extension 包；PuddingTeams 核心只内置第一方
 * PuddingClaw Driver 的注册入口。注册分两种：无状态的 Driver 单例
 * （register）与按 binding config 构造实例的工厂（registerFactory，
 * §9.3.7 同一 Connector 多 Agent 实例）。
 */
export class DriverRegistry {
	private readonly drivers = new Map<string, AgentDriver>();
	private readonly factories = new Map<string, DriverFactory>();
	private readonly owners = new Map<string, string>();
	private readonly factoryEpochs = new Map<string, symbol>();
	private readonly instanceOrigins = new WeakMap<AgentDriver, { connectorId: string; ownerId: string; epoch: symbol }>();

	register(driver: AgentDriver, ownerId = driver.id): void {
		this.drivers.set(driver.id, driver);
		this.owners.set(driver.id, ownerId);
	}

	/** 注册按 config 构造 Driver 的工厂（key 为 ConnectorContribution.id）。 */
	registerFactory(connectorId: string, factory: DriverFactory, ownerId = connectorId): void {
		this.factories.set(connectorId, factory);
		this.owners.set(connectorId, ownerId);
		this.factoryEpochs.set(connectorId, Symbol(connectorId));
	}

	/** Unregister（Connector 卸载/更新时由宿主调用）。 */
	unregister(id: string): boolean {
		this.factories.delete(id);
		this.factoryEpochs.delete(id);
		this.owners.delete(id);
		return this.drivers.delete(id);
	}

	get(id: string): AgentDriver | undefined {
		return this.drivers.get(id);
	}

	/** 按 binding config 构造 Driver：优先工厂，退回已注册的单例。 */
	create(
		connectorId: string,
		transport: DriverTransport,
		config: Record<string, unknown> = {},
		ownerId?: string,
	): AgentDriver | undefined {
		if (ownerId !== undefined && this.owners.get(connectorId) !== ownerId) return undefined;
		const factory = this.factories.get(connectorId);
		if (factory) {
			const driver = factory(config, transport);
			const epoch = this.factoryEpochs.get(connectorId);
			const owner = this.owners.get(connectorId);
			if (epoch && owner) this.instanceOrigins.set(driver, { connectorId, ownerId: owner, epoch });
			return driver;
		}
		return this.drivers.get(connectorId);
	}

	/** A replacement registration invalidates every instance from the old factory. */
	isCurrentFactoryInstance(connectorId: string, ownerId: string, factory: DriverFactory, driver: AgentDriver): boolean {
		const origin = this.instanceOrigins.get(driver);
		return this.factories.get(connectorId) === factory && this.owners.get(connectorId) === ownerId &&
			origin?.connectorId === connectorId && origin.ownerId === ownerId && origin.epoch === this.factoryEpochs.get(connectorId);
	}

	list(): AgentDriver[] {
		return [...this.drivers.values()];
	}
}
