"use client";

import { createContext, useContext } from "react";

type WorkerProcessContextValue = {
	openWorkerProcess: (delegationId: string) => void;
};

const WorkerProcessContext = createContext<WorkerProcessContextValue | null>(null);

export const WorkerProcessProvider = WorkerProcessContext.Provider;

export function useWorkerProcessDrawer(): WorkerProcessContextValue {
	const value = useContext(WorkerProcessContext);
	return value ?? { openWorkerProcess: () => undefined };
}
