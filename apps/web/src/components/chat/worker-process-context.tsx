"use client";

import { createContext, useContext, type ReactNode } from "react";

type WorkerProcessContextValue = {
	openWorkerProcess: (delegationId: string) => void;
	renderInlineProcess?: (delegationId: string, fallback?: string) => ReactNode;
};

const WorkerProcessContext = createContext<WorkerProcessContextValue | null>(null);

export const WorkerProcessProvider = WorkerProcessContext.Provider;

export function useWorkerProcessDrawer(): WorkerProcessContextValue {
	const value = useContext(WorkerProcessContext);
	return value ?? { openWorkerProcess: () => undefined };
}
