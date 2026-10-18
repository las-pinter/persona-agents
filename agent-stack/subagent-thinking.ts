/**
 * Subagent thinking state.
 *
 * Tracks per-run thinking timing and renders the thinking indicator lines,
 * with no process or tool concerns.
 */

import { formatDuration, formatTokens } from "./duration.ts";

/** Live thinking state for one subagent run. */
export interface ThinkingState {
	thinking: boolean;
	thinkingStartedAt: number | null;
	thinkingMs: number;
}

export const INITIAL_THINKING: ThinkingState = { thinking: false, thinkingStartedAt: null, thinkingMs: 0 };

export type ThinkingEventType = "thinking_start" | "thinking_delta" | "thinking_end";

/** True for the three assistant content-block events that mark thinking. */
export function isThinkingEventType(type: unknown): type is ThinkingEventType {
	return type === "thinking_start" || type === "thinking_delta" || type === "thinking_end";
}

/** Pure per-run thinking reducer: start opens a stretch, end folds it into the total. */
export function reduceThinking(state: ThinkingState, eventType: ThinkingEventType, nowMs: number): ThinkingState {
	switch (eventType) {
		case "thinking_start":
			if (state.thinking) return state;
			return { thinking: true, thinkingStartedAt: nowMs, thinkingMs: state.thinkingMs };
		case "thinking_delta":
			// A delta with no start opens a stretch, so the total still counts.
			return state.thinking ? state : { thinking: true, thinkingStartedAt: nowMs, thinkingMs: state.thinkingMs };
		case "thinking_end": {
			if (!state.thinking) return state;
			const startedAt = state.thinkingStartedAt ?? nowMs;
			return {
				thinking: false,
				thinkingStartedAt: null,
				thinkingMs: state.thinkingMs + Math.max(0, nowMs - startedAt),
			};
		}
	}
}

/**
 * Build the per-run thinking handler. A delta skips the repaint because the
 * run ticker repaints; start and end emit at once.
 */
export function makeThinkingEventHandler(
	getState: () => ThinkingState | undefined,
	setState: (state: ThinkingState) => void,
	emit: () => void,
	now: () => number,
): (eventType: ThinkingEventType) => void {
	return (eventType) => {
		setState(reduceThinking(getState() ?? INITIAL_THINKING, eventType, now()));
		if (eventType === "thinking_delta") return;
		emit();
	};
}

/** Live elapsed for a run: completed stretches plus the active stretch. */
export function thinkingElapsedMs(state: ThinkingState | undefined, nowMs: number): number {
	const total = state?.thinkingMs ?? 0;
	if (!state?.thinking || state.thinkingStartedAt === null) return total;
	return total + Math.max(0, nowMs - state.thinkingStartedAt);
}

/** Render the thinking indicator lines for one run, or null when no thinking happened. */
export function formatThinkingIndicator(
	state: ThinkingState | undefined,
	reasoningTokens: number | undefined,
	nowMs: number,
): string | null {
	const s = state ?? INITIAL_THINKING;
	// Gate on a positive count: a thinking-only run must not print "0 reasoning".
	const reasoning =
		typeof reasoningTokens === "number" && reasoningTokens > 0
			? ` · ${formatTokens(reasoningTokens)} reasoning`
			: "";
	const lines: string[] = [];
	if (s.thinking) lines.push(`🧠 thinking… ${formatDuration(thinkingElapsedMs(s, nowMs))}`);
	if (s.thinkingMs > 0 || reasoning !== "") {
		lines.push(`🧠 think ${formatDuration(s.thinkingMs)}${reasoning}`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}
