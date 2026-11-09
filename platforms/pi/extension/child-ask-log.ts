/**
 * Child ask log: the pure field builders for one arrival line and one expiry
 * line.
 *
 * The line carries the root, the child, the tool, and the state fields, so a
 * stuck child leaves a trace in the extension log ring and the LOG panel. The
 * writer sits in `child-ask.ts`, which records before it settles.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateRequest, RootState } from "./child-ask-state.ts";

/**
 * A short stable form of a session id, so one log row fits a terminal. A
 * cut id ends with the cut marker, so a cut id never reads as a full id.
 */
export function shortId(sessionId: string): string {
	return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}

/** The `shown` values: the named request's own panel, another panel, or none. */
export type ShownValue = "this" | "other" | "none";

/**
 * The `shown` value of an arrival line: never `this`, because `enqueue` writes
 * the line before the pump mounts a panel.
 */
export type ArrivalShownValue = Exclude<ShownValue, "this">;

/** The `place` values: the mount began, or the request never left the queue. */
export type PlaceValue = "slot" | "queue";

/**
 * Which request the panel shows: `other` for a different visible request and
 * `none` for no visible request. An expiry line can also print `this`, because
 * a mounted panel is the request's own.
 */
export function shownField(visible: GateRequest | null, request: GateRequest): ShownValue {
	if (visible === request) return "this";
	return visible ? "other" : "none";
}

/**
 * Where one request stood when its deadline passed. `slot` means its mount
 * began: the request waited for the panel slot or held it. `queue` means the
 * mount never began. The two values need different fixes.
 */
export function placeField(state: RootState, request: GateRequest): PlaceValue {
	return state.parked.has(request) ? "slot" : "queue";
}

/** The fields both ask warnings carry: the parked count and the surface. */
function tailFlags(
	surfaces: Map<string, ExtensionContext> | undefined,
	state: RootState,
): string {
	const surface = surfaces?.has(state.rootSessionId) ? "yes" : "no";
	return `parked=${state.parked.size} surface=${surface}`;
}

/** The fields of one arrival line: the queue count and the panel on screen. */
export function arrivalFlags(
	surfaces: Map<string, ExtensionContext> | undefined,
	state: RootState,
	shown: ArrivalShownValue,
	queued: number,
): string {
	return `queued=${queued} shown=${shown} ${tailFlags(surfaces, state)}`;
}

/**
 * The fields of one expiry line: how many wait, the panel on screen, and where
 * the request stood.
 */
export function expiryFlags(
	surfaces: Map<string, ExtensionContext> | undefined,
	state: RootState,
	shown: ShownValue,
	place: PlaceValue,
	waiting: number,
): string {
	return `waiting=${waiting} shown=${shown} place=${place} ${tailFlags(surfaces, state)}`;
}

/** Requests still waiting on one root, apart from the request named. */
export function waitingApart(state: RootState, request: GateRequest): number {
	return state.queue.filter((entry) => entry !== request).length;
}
