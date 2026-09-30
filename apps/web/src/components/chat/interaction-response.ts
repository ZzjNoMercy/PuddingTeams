import type { InteractionRequestView, InteractionView } from "@/lib/api";

export function choicesFor(request: InteractionRequestView): string[] {
	return (request.options ?? []).filter((option) => option !== "reject");
}

export function selectedScopeFor(request: InteractionRequestView, byRequest: Record<string, string>): string | undefined {
	const choices = choicesFor(request);
	return choices.includes(byRequest[request.requestId] ?? "") ? byRequest[request.requestId] : choices[0];
}

export function answerFor(request: InteractionRequestView, byRequest: Record<string, string>): string {
	const selected = byRequest[request.requestId] ?? "";
	const choices = choicesFor(request);
	return choices.length > 0 ? choices.includes(selected) ? selected : "" : selected.trim();
}

export function canApproveRequests(requests: InteractionRequestView[]): boolean {
	return requests.length > 0 && requests.every((request) => !request.options?.includes("reject") || choicesFor(request).length > 0);
}

export function buildInteractionResponses(
	requests: InteractionRequestView[],
	kind: InteractionView["kind"],
	action: "approve" | "reject" | "answer" | "confirm",
	scopeByRequest: Record<string, string>,
	valueByRequest: Record<string, string>,
	chosenScope?: string,
	value?: unknown,
): Array<{ requestId: string; action: string; scope?: string; value?: unknown }> {
	return requests.map((request) => {
		const answer = answerFor(request, valueByRequest);
		return {
			requestId: request.requestId,
			action,
			scope: action === "approve"
				? chosenScope ?? (kind === "permission" ? selectedScopeFor(request, scopeByRequest) : undefined)
				: action === "answer" || action === "confirm" ? choicesFor(request).length > 0 ? answer || undefined : undefined : undefined,
			value: value !== undefined ? value : action === "answer" || action === "confirm" ? answer || undefined : undefined,
		};
	});
}
