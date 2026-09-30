"use client";

import { useEffect, useState } from "react";
import { listModels, MODELS_CHANGED_EVENT } from "@/lib/api";
import { THINKING_LEVELS, thinkingLevelsFor, type ModelSummary } from "@/lib/types";

/**
 * 模型目录读取，供**所有**模型/思考强度选择器共用（聊天 composer、工作台新工作、
 * Manager 配置、Pi Worker 配置）。
 *
 * 思考强度必须同源：`ModelSummary.thinkingLevels` 来自各模型 `thinkingLevelMap`，
 * 并经服务端平台能力表（`pi-bridge/thinking-capabilities.ts`）修正上游目录与官方
 * API 文档不一致的模型。新增选择器请从这里取档位，不要另写常量——历史上归一化
 * 枚举被复制成多份且长度不一（Connector schema 少了 `max`），manager 表单与
 * worker 表单因此给出不同选项。
 */
export interface ModelCatalog {
	/** 目录未就绪时为 null，用于区分「还没读到」与「读到但为空」。 */
	models: ModelSummary[] | null;
	modelsError: string | null;
	/** 按 ref 查模型；目录未就绪或未命中时为 undefined。 */
	find: (modelRef?: string | null) => ModelSummary | undefined;
	/** 某 ref 的可选 thinking 档位；未选定/未命中时回退归一化全集。 */
	levelsFor: (modelRef?: string | null) => string[];
	/** 某 ref 的档位是否真正分级；未命中时按 true（不臆断、不提示）。 */
	gradedFor: (modelRef?: string | null) => boolean;
	/** 档位是否随目录变化刷新（Provider 增删/改 key 后需要）。 */
	subscribe: () => () => void;
	reload: () => void;
}

export function useModelCatalog(): ModelCatalog {
	const [models, setModels] = useState<ModelSummary[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		let cancelled = false;
		listModels()
			.then((items) => { if (!cancelled) { setModels(items); setModelsError(null); } })
			.catch((error: unknown) => { if (!cancelled) setModelsError(error instanceof Error ? error.message : String(error)); });
		return () => { cancelled = true; };
	}, [nonce]);
	useEffect(() => {
		const reload = () => setNonce((current) => current + 1);
		window.addEventListener(MODELS_CHANGED_EVENT, reload);
		return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
	}, []);
	const find = (modelRef?: string | null) => (modelRef && models ? models.find((m) => m.id === modelRef) : undefined);
	return {
		models,
		modelsError,
		find,
		levelsFor: (modelRef) => thinkingLevelsFor(find(modelRef)),
		gradedFor: (modelRef) => find(modelRef)?.thinkingGraded !== false,
		subscribe: () => () => undefined,
		reload: () => setNonce((current) => current + 1),
	};
}

export { THINKING_LEVELS, thinkingLevelsFor };
export type { ModelSummary };
