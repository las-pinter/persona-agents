/**
 * Child ask state: the request record and the per-registry bookkeeping.
 *
 * The queue keeps one state per registry, because a surface captured for an
 * earlier session must never answer a later one. The request record below is
 * the one copy that the deadline, the queue, and the mount share, so the stale
 * check reads the same `settled` field in all three places.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionChoice, PromptModel } from "./permission-prompt.ts";
import type { RunRegistry } from "./run-registry.ts";

/** What one request resolves to. An allow never carries a block reason. */
export type ChildAskOutcome =
	| { kind: "allow"; alwaysAllow: boolean }
	| { kind: "block"; reason: string };

/** Everything a child enqueues. The gate fills the grant key and the model. */
export interface ChildAskInput {
	/** The child session id. It scopes the grant and finds the root. */
	sessionId: string;
	/** The child agent name, shown in the title. */
	role: string;
	toolName: string;
	/** The full grant key the gate will test on the next call. */
	key: string;
	/** The prompt model, without the child-specific title. */
	model: PromptModel;
	/** Stores the key when the owner picks always-allow. */
	remember: (key: string) => void;
}

/** The prompt renderer. The default is the real shared prompt. */
export type ChildAskRender = (
	ctx: ExtensionContext,
	model: PromptModel,
	signal: AbortSignal,
) => Promise<PermissionChoice>;

/** One request. The queue, the timer, and the mount all read this record. */
export interface GateRequest {
	sessionId: string;
	role: string;
	toolName: string;
	key: string;
	model: PromptModel;
	remember: (key: string) => void;
	resolve: (outcome: ChildAskOutcome) => void;
	/** Closes the visible panel when the deadline passes. */
	cancel: AbortController;
	timer: ReturnType<typeof setTimeout> | null;
	settled: boolean;
}

/** One root and the requests that wait on it. */
export interface RootState {
	registry: RunRegistry;
	rootSessionId: string;
	queue: GateRequest[];
	/** The request whose prompt is on screen, or null. */
	visible: GateRequest | null;
	/** Requests with a mount that runs or waits for the shared panel slot. */
	parked: Set<GateRequest>;
}

/**
 * The queue and the surfaces of one registry. A new registry starts empty, so
 * a surface captured for an earlier session never answers a later one.
 */
export interface RegistryState {
	registry: RunRegistry;
	roots: Map<string, RootState>;
	/** The prompt surface of each root, kept after its queue drains. */
	surfaces: Map<string, ExtensionContext>;
}

/** The state of one registry, built on first use. */
export function stateOf(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	registry: RunRegistry,
): RegistryState {
	let state = states.get(registry);
	if (!state) {
		state = { registry, roots: new Map(), surfaces: new Map() };
		states.set(registry, state);
		live.add(state);
	}
	return state;
}

/** The state of one root under its registry, built on first use. */
export function rootState(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	registry: RunRegistry,
	rootSessionId: string,
): RootState {
	const roots = stateOf(states, live, registry).roots;
	let state = roots.get(rootSessionId);
	if (!state) {
		state = { registry, rootSessionId, queue: [], visible: null, parked: new Set() };
		roots.set(rootSessionId, state);
	}
	return state;
}

/** The surfaces of one registry, or undefined before its first state. */
export function surfacesOf(
	states: WeakMap<RunRegistry, RegistryState>,
	registry: RunRegistry,
): Map<string, ExtensionContext> | undefined {
	return states.get(registry)?.surfaces;
}

/** Keep the prompt surface of one root, so its queue renders on that surface. */
export function bindSurface(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	registry: RunRegistry,
	rootSessionId: string,
	ctx: ExtensionContext,
): void {
	stateOf(states, live, registry).surfaces.set(rootSessionId, ctx);
}

/**
 * Drop every captured surface. A surface is one gate generation's context, so
 * a later install or a later test must not render on it. A root binds its
 * surface again on its next gated call. A state with no root left keeps
 * nothing, so it is dropped at once.
 */
export function clearAllSurfaces(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
): void {
	for (const state of live) {
		state.surfaces.clear();
		if (state.roots.size > 0) continue;
		states.delete(state.registry);
		live.delete(state);
	}
}

/** Build one request, with the fields the gate supplied and a fresh cancel. */
export function newRequest(
	input: ChildAskInput,
	resolve: (outcome: ChildAskOutcome) => void,
): GateRequest {
	return {
		sessionId: input.sessionId,
		role: input.role,
		toolName: input.toolName,
		key: input.key,
		model: input.model,
		remember: input.remember,
		resolve,
		cancel: new AbortController(),
		timer: null,
		settled: false,
	};
}

/**
 * Choose the head of one queue, or null when nothing is left to show. A
 * settled head has no verdict left to give, so it leaves the queue here.
 */
export function chooseHead(state: RootState): GateRequest | null {
	for (;;) {
		const head = state.queue[0];
		if (head === undefined) return null;
		if (!head.settled) return head;
		state.queue.shift();
	}
}

/** Drop one request from the queue, clear its timer, and resolve it once. */
export function settle(
	state: RootState,
	request: GateRequest,
	outcome: ChildAskOutcome,
): void {
	if (request.settled) return;
	request.settled = true;
	if (request.timer !== null) {
		clearTimeout(request.timer);
		request.timer = null;
	}
	const index = state.queue.indexOf(request);
	if (index >= 0) state.queue.splice(index, 1);
	if (state.visible === request) state.visible = null;
	request.resolve(outcome);
}
