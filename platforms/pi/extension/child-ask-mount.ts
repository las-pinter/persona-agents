/**
 * Child ask mount: pump the queue, mount one prompt on the shared panel slot,
 * and turn the owner choice into a verdict.
 *
 * The mount takes the slot before it renders, so a root ask never mounts
 * beside a child panel. Every exit hands the slot back.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askPanelSlot } from "./ask-panel-slot.ts";
import { recordAsk } from "./ask-record.ts";
import {
	chooseHead,
	settle,
	stateOf,
	type ChildAskRender,
	type GateRequest,
	type RegistryState,
	type RootState,
} from "./child-ask-state.ts";
import {
	DENIED_BY_USER_REASON,
	type PermissionChoice,
	type PromptModel,
} from "./permission-prompt.ts";
import { sessionDepthOf, type RunRegistry } from "./run-registry.ts";

/** The block reason when the root has no captured prompt surface. */
export const CHILD_ASK_NO_SURFACE_REASON = "Blocked: the root session has no prompt surface";

/**
 * The prompt title for a child request. Only the head is shown, so the
 * position is always 1, and the total shrinks as requests are answered.
 */
export function childPromptTitle(childName: string, total: number): string {
	return `Permission required for ${childName} (1 of ${total} waiting)`;
}

/** Drop a stale title before the queue sets the child-specific one. */
function titled(model: PromptModel, title: string): PromptModel {
	return { ...model, title };
}

/** Show the head, or fail it closed when the root has no surface yet. */
export function pump(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	render: ChildAskRender,
	state: RootState,
): void {
	if (state.visible || state.parked.size > 0) return;
	const surfaces = stateOf(states, live, state.registry).surfaces;
	for (let head = chooseHead(state); head !== null; head = chooseHead(state)) {
		const ctx = surfaces.get(state.rootSessionId);
		if (!ctx) {
			settle(state, head, { kind: "block", reason: CHILD_ASK_NO_SURFACE_REASON });
			continue;
		}
		// A root ask can own the panel slot. This wait is bounded by the request's
		// own deadline, so the wait never outlasts the ask that waits for a panel.
		void show(states, live, render, state, head, ctx);
		return;
	}
	release(states, live, state);
}

/**
 * Take the shared panel slot, mount one prompt, and hand the slot back on
 * every exit. The slot stops a root ask from mounting beside this panel. A
 * request that times out while it waits for the slot never mounts here.
 */
async function show(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	render: ChildAskRender,
	state: RootState,
	head: GateRequest,
	ctx: ExtensionContext,
): Promise<void> {
	// Count the mount before it can wait, so a settle in another path sees it.
	state.parked.add(head);
	try {
		const releaseSlot = await askPanelSlot.acquire();
		try {
			// The deadline may have passed while this request waited for the slot.
			if (head.settled) return;
			state.visible = head;
			const model = titled(head.model, childPromptTitle(head.role, state.queue.length));
			let choice: PermissionChoice;
			try {
				choice = await render(ctx, model, head.cancel.signal);
			} catch {
				choice = "deny";
			}
			answer(states, live, render, state, head, choice);
		} finally {
			releaseSlot();
		}
	} finally {
		state.parked.delete(head);
		pump(states, live, render, state);
	}
}

/** Drop a state with no work left, so the roots map does not grow per root. */
export function release(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	state: RootState,
): void {
	if (state.visible || state.queue.length > 0) return;
	const roots = stateOf(states, live, state.registry).roots;
	// A stale mount can outlive its own root entry, so only drop this exact state.
	if (roots.get(state.rootSessionId) === state) roots.delete(state.rootSessionId);
}

/** Turn one owner choice into a verdict, then show the next request. */
function answer(
	states: WeakMap<RunRegistry, RegistryState>,
	live: Set<RegistryState>,
	render: ChildAskRender,
	state: RootState,
	request: GateRequest,
	choice: PermissionChoice,
): void {
	// A timeout may already have advanced the queue. A late panel answer is stale.
	if (state.visible !== request) return;
	state.visible = null;
	if (choice === "always-allow") {
		request.remember(request.key);
		settle(state, request, { kind: "allow", alwaysAllow: true });
	} else if (choice === "allow-once") {
		settle(state, request, { kind: "allow", alwaysAllow: false });
	} else {
		settle(state, request, { kind: "block", reason: DENIED_BY_USER_REASON });
	}
	// One settled child ask writes one record, in the ask plumbing and not the gate.
	recordAsk({
		tool: request.toolName,
		role: request.role,
		verdict: choice === "deny" ? "deny" : "allow",
		runId: request.sessionId,
		depth: sessionDepthOf(request.sessionId) ?? 0,
		askId: request.askId,
		phase: "settle",
	});
	pump(states, live, render, state);
}
