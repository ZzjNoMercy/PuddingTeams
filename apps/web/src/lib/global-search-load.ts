import type { AgentConfig, ManagerWorkIndexItem, RoomSummary } from "./types";

type SearchLoaders = {
	rooms: () => Promise<RoomSummary[]>;
	agents: () => Promise<AgentConfig[]>;
	works: () => Promise<ManagerWorkIndexItem[]>;
};

export type SearchLoadEvent =
	| { source: "rooms"; ok: true; value: RoomSummary[] }
	| { source: "agents"; ok: true; value: AgentConfig[] }
	| { source: "works"; ok: true; value: ManagerWorkIndexItem[] }
	| { source: keyof SearchLoaders; ok: false; error: unknown };

/** Report each independent source as soon as it settles, ignoring invalidated requests. */
export async function loadSearchSources(loaders: SearchLoaders, isCurrent: () => boolean, onSettled: (event: SearchLoadEvent) => void): Promise<void> {
	const settle = async (source: keyof SearchLoaders): Promise<void> => {
		let value: RoomSummary[] | AgentConfig[] | ManagerWorkIndexItem[];
		try {
			value = await loaders[source]();
		} catch (error) {
			if (isCurrent()) onSettled({ source, ok: false, error });
			return;
		}
		if (isCurrent()) onSettled({ source, ok: true, value } as SearchLoadEvent);
	};
	await Promise.all([settle("rooms"), settle("agents"), settle("works")]);
}
