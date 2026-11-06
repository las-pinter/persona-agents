/**
 * Child ask log: one warning line per arrival and one per expiry.
 *
 * The line carries the root, the child, the tool, and the state fields, so a
 * stuck child leaves a trace in the console. The writer catches its own throw,
 * because a broken console must not skip the settle.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateRequest, RootState } from "./child-ask-state.ts";

/**
 * A short stable form of a session id, so one warning line fits a terminal. A
 * cut id ends with the cut marker, so a cut id never reads as a full id.
 */
export function shortId(sessionId: string): string {
	return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}

/**
 * Write one ask warning line. A console that throws must not skip the settle,
 * so this call catches its own throw. The catch stays empty, because a dropped
 * warning line has no second place to go.
 */
export function warnAskLine(line: string): void {
	try {
		console.error(line);
	} catch {
		// A broken console must not turn a blocked child into a stuck child.
	}
}

/**
 * Which request the panel shows for one line: `this` for the named request,
 * `other` for a different visible request, and `none` for no visible request.
 */
function shownField(visible: GateRequest | null, request: GateRequest): string {
	if (visible === request) return "this";
	return visible ? "other" : "none";
}

/**
 * The state fields both ask warnings carry. The count comes from the caller,
 * because the two lines count apart: an arrival prints `queued=`, an expiry
 * prints `waiting=`. A line never claims a panel for the request it names.
 */
export function askFlags(
	surfaces: Map<string, ExtensionContext> | undefined,
	state: RootState,
	request: GateRequest,
	count: string,
): string {
	const shown = shownField(state.visible, request);
	const surface = surfaces?.has(state.rootSessionId) ? "yes" : "no";
	return `${count} shown=${shown} parked=${state.parked.size} surface=${surface}`;
}

/** Requests still waiting on one root, apart from the request named. */
export function waitingApart(state: RootState, request: GateRequest): number {
	return state.queue.filter((entry) => entry !== request).length;
}
