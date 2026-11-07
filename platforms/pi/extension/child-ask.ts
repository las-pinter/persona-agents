/**
 * Child ask routing: a FIFO queue in front of the one root prompt.
 *
 * A child session has no UI, so its gate cannot render a prompt. The child
 * enqueues a request here instead. The queue renders it with the root surface
 * that the root gate captured, so the shared prompt mounts on the root and the
 * owner answers it. One prompt is visible at a time. The title names the child
 * and the waiting count, and a denied head shows the next request.
 *
 * The deadline counts from arrival, so a request that waits behind another
 * prompt can still time out. A timed-out request leaves the queue and blocks
 * the child. The grant key carries the session, the role, the tool, and the
 * rule. A root grant does not cover a child. A child grant does not cover its
 * sibling.
 *
 * The queue reads the registry that `run-registry.ts` binds, so the gate and
 * the queue share one identity source. No pi runtime import: the renderer is
 * injected, so the test needs no terminal.
 *
 * This file is the facade. The state record, the log line, and the mount live
 * in `child-ask-state.ts`, `child-ask-log.ts`, and `child-ask-mount.ts`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askPanelSlot } from "./ask-panel-slot.ts";
import { recordAsk } from "./ask-record.ts";
import type { ArrivalShownValue } from "./child-ask-log.ts";
import {
	arrivalFlags,
	expiryFlags,
	placeField,
	shortId,
	shownField,
	waitingApart,
	warnAskLine,
} from "./child-ask-log.ts";
import { pump, release } from "./child-ask-mount.ts";
import {
	bindSurface,
	clearAllSurfaces,
	newRequest,
	rootState,
	settle,
	surfacesOf,
	type ChildAskInput,
	type ChildAskOutcome,
	type ChildAskRender,
	type GateRequest,
	type RegistryState,
	type RootState,
} from "./child-ask-state.ts";
import { renderPermissionPrompt, renderRootPermissionPrompt } from "./permission-prompt.ts";
import { boundRunRegistry, sessionDepthOf, UNKNOWN_RUN_REASON, type RunRegistry } from "./run-registry.ts";

export { CHILD_ASK_NO_SURFACE_REASON, childPromptTitle } from "./child-ask-mount.ts";
export type { ChildAskInput, ChildAskOutcome, ChildAskRender } from "./child-ask-state.ts";

/**
 * How long an unanswered child request stays in the queue. One owner answer is
 * human work, so the deadline is 120 s, not a machine-scale instant.
 */
export const CHILD_ASK_DEADLINE_MS = 120_000;

/** The block reason at the child deadline. It names the timeout, not a rule. */
export const CHILD_ASK_DEADLINE_REASON =
	"Blocked: the permission ask timed out after 120 seconds with no answer";

/** The queue options. Both have a production default. */
export interface ChildAskOptions {
	/** Defaults to `renderPermissionPrompt`. */
	render?: ChildAskRender;
	/** Defaults to `CHILD_ASK_DEADLINE_MS`. */
	timeoutMs?: number;
}

/** FIFO queue plus the single visible prompt, one state per registry. */
export class ChildAskQueue {
	private readonly states = new WeakMap<RunRegistry, RegistryState>();
	/** Every state this queue built, so a clear can reach them. */
	private readonly live = new Set<RegistryState>();
	private readonly render: ChildAskRender;
	private readonly timeoutMs: number;

	constructor(options: ChildAskOptions = {}) {
		this.render = options.render ?? renderPermissionPrompt;
		this.timeoutMs = options.timeoutMs ?? CHILD_ASK_DEADLINE_MS;
	}

	/**
	 * The walked depth of one session, or null when no root is reachable. The
	 * walk counts hops, so a record cannot under-report its own depth.
	 */
	depth(sessionId: string): number | null {
		const walk = boundRunRegistry()?.walk(sessionId);
		return walk !== undefined && walk.ok ? walk.depth : null;
	}

	/**
	 * Keep the prompt surface of a root session. A child call carries a child
	 * context, which has no UI, so only a walk that ends at the caller binds it.
	 * A headless root binds nothing, so its children fail closed instead of
	 * stalling on a prompt that the root path would block.
	 */
	noteContext(sessionId: string, ctx: ExtensionContext): void {
		const registry = boundRunRegistry();
		if (!registry) return;
		const walk = registry.walk(sessionId);
		if (!walk.ok || walk.rootSessionId !== sessionId) return;
		if (!ctx.hasUI) return;
		bindSurface(this.states, this.live, registry, walk.rootSessionId, ctx);
	}

	/**
	 * Add one request to its root queue and resolve when the owner answers or
	 * the deadline passes. Every verdict resolves, so the gate gets a verdict.
	 * A fault in the state build rejects, and no verdict path rejects.
	 */
	async enqueue(input: ChildAskInput): Promise<ChildAskOutcome> {
		const registry = boundRunRegistry();
		if (!registry) return { kind: "block", reason: UNKNOWN_RUN_REASON };
		const walk = registry.walk(input.sessionId);
		if (!walk.ok) {
			const reason =
				walk.failure === "unknown-session"
					? UNKNOWN_RUN_REASON
					: `Blocked: broken parent chain at session ${walk.failureId}`;
			return { kind: "block", reason };
		}
		const state = rootState(this.states, this.live, registry, walk.rootSessionId);
		return new Promise<ChildAskOutcome>((resolve) => {
			const request: GateRequest = newRequest(input, resolve);
			// The deadline starts now, so time behind another prompt also counts.
			const timer = setTimeout(() => this.expire(state, request), this.timeoutMs);
			request.timer = timer;
			state.queue.push(request);
			// Read the fields first, so a queued request shows on the line.
			const root = shortId(state.rootSessionId);
			const flags = arrivalFlags(
				surfacesOf(this.states, registry),
				state,
				// The pump mounts this request later, so the panel is another or none.
				shownField(state.visible, request) as ArrivalShownValue,
				state.queue.length,
			);
			const line = `agent-stack: child ask queued root=${root} child=${request.role} tool=${request.toolName} ${flags}`;
			// A silent queue hides a child that waits for an owner who never sees it.
			warnAskLine(line);
			// Batch requests that arrive in one tick, so the title counts them all.
			queueMicrotask(() => pump(this.states, this.live, this.render, state));
		});
	}

	/** Live root states of the bound registry, so a drained root is dropped. */
	rootCount(): number {
		const registry = boundRunRegistry();
		return registry ? (this.states.get(registry)?.roots.size ?? 0) : 0;
	}

	/** Requests still waiting on one root, including the visible head. */
	waiting(rootSessionId: string): number {
		return this.rootsOf()?.get(rootSessionId)?.queue.length ?? 0;
	}

	/** The child session whose prompt is visible, or null. */
	visible(rootSessionId: string): string | null {
		return this.rootsOf()?.get(rootSessionId)?.visible?.sessionId ?? null;
	}

	/** The live roots of the bound registry, or undefined when none is bound. */
	private rootsOf(): Map<string, RootState> | undefined {
		const registry = boundRunRegistry();
		return registry ? this.states.get(registry)?.roots : undefined;
	}

	/**
	 * Drop every captured surface. A surface is one gate generation's context, so
	 * a later install or a later test must not render on it. A root binds its
	 * surface again on its next gated call. A state with no root left keeps
	 * nothing, so it is dropped at once.
	 */
	clearSurfaces(): void {
		clearAllSurfaces(this.states, this.live);
	}

	/** The deadline path. The child is blocked, and the next request shows. */
	private expire(state: RootState, request: GateRequest): void {
		if (request.settled) return;
		// Read the position first, so the line names where this request stood.
		const root = shortId(state.rootSessionId);
		const flags = expiryFlags(
			surfacesOf(this.states, state.registry),
			state,
			shownField(state.visible, request),
			placeField(state, request),
			waitingApart(state, request),
		);
		const line = `agent-stack: child ask expired with no answer before the deadline root=${root} child=${request.role} tool=${request.toolName} ${flags}`;
		// One expired ask writes one record, before the settle frees the request.
		recordAsk({
			tool: request.toolName,
			role: request.role,
			verdict: "expired",
			runId: request.sessionId,
			depth: sessionDepthOf(request.sessionId) ?? 0,
		});
		// The verdict goes first, so a blocking console write never delays it.
		settle(state, request, { kind: "block", reason: CHILD_ASK_DEADLINE_REASON });
		warnAskLine(line);
		// Close the visible panel, so the next request is the only one on screen.
		request.cancel.abort();
		// A parked mount clears itself in its own finally. This path never clears
		// the parked count, so a later expire cannot start a second mount.
		pump(this.states, this.live, this.render, state);
		// The visible panel closes on its own microtask, so drop the drained root
		// here. A stale mount that resumes later cannot delete a newer state.
		release(this.states, this.live, state);
	}
}

/** The queue the gate uses, or null before an install. */
let routing: ChildAskQueue | null = null;

/**
 * Bind the queue with its options. A second bind replaces the first, so a test
 * starts from a known deadline and renderer. The registry comes from
 * `run-registry.ts`; this bind never names one.
 */
export function bindChildAsk(options: ChildAskOptions = {}): void {
	// The root wrapper takes the slot, and the child queue takes it too. A child
	// render that also takes it would wait on itself forever.
	if (options.render === renderRootPermissionPrompt) {
		throw new Error(
			"bindChildAsk: renderRootPermissionPrompt is the root renderer, so a child ask would deadlock",
		);
	}
	routing = new ChildAskQueue(options);
}

/** Drop the queue and its state, so a test leaves nothing behind. */
export function unbindChildAsk(): void {
	routing?.clearSurfaces();
	routing = null;
	// A panel left mounted by a test would block the next test's first ask.
	askPanelSlot.reset();
}

/** The bound queue. The gate calls this on every tool call. */
export function childAskQueue(): ChildAskQueue | null {
	return routing;
}
