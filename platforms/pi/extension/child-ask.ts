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
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askPanelSlot } from "./ask-panel-slot.ts";
import {
	DENIED_BY_USER_REASON,
	renderPermissionPrompt,
	renderRootPermissionPrompt,
	type PermissionChoice,
	type PromptModel,
} from "./permission-prompt.ts";
import {
	boundRunRegistry,
	UNKNOWN_RUN_REASON,
	type RunRecord,
	type RunRegistry,
} from "./run-registry.ts";

/**
 * How long an unanswered child request stays in the queue. One owner answer is
 * human work, so the deadline is 120 s, not a machine-scale instant.
 */
export const CHILD_ASK_DEADLINE_MS = 120_000;

/** The block reason at the child deadline. It names the timeout, not a rule. */
export const CHILD_ASK_DEADLINE_REASON =
	"Blocked: the permission ask timed out after 120 seconds with no answer";

/** The block reason when the root has no captured prompt surface. */
export const CHILD_ASK_NO_SURFACE_REASON = "Blocked: the root session has no prompt surface";

/**
 * The prompt title for a child request. Only the head is shown, so the
 * position is always 1, and the total shrinks as requests are answered.
 */
export function childPromptTitle(childName: string, total: number): string {
	return `Permission required for ${childName} (1 of ${total} waiting)`;
}

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

/** The queue options. Both have a production default. */
export interface ChildAskOptions {
	/** Defaults to `renderPermissionPrompt`. */
	render?: ChildAskRender;
	/** Defaults to `CHILD_ASK_DEADLINE_MS`. */
	timeoutMs?: number;
}

interface GateRequest {
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
interface RootState {
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
interface RegistryState {
	registry: RunRegistry;
	roots: Map<string, RootState>;
	/** The prompt surface of each root, kept after its queue drains. */
	surfaces: Map<string, ExtensionContext>;
}

/** Drop a stale title before the queue sets the child-specific one. */
function titled(model: PromptModel, title: string): PromptModel {
	return { ...model, title };
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

	/** The record for one session, so the gate can tell a child from a root. */
	record(sessionId: string): Readonly<RunRecord> | undefined {
		return boundRunRegistry()?.get(sessionId);
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
		this.stateOf(registry).surfaces.set(walk.rootSessionId, ctx);
	}

	/**
	 * Add one request to its root queue and resolve when the owner answers or
	 * the deadline passes. The promise never rejects, so the gate always gets a
	 * verdict.
	 */
	enqueue(input: ChildAskInput): Promise<ChildAskOutcome> {
		const registry = boundRunRegistry();
		if (!registry) return Promise.resolve({ kind: "block", reason: UNKNOWN_RUN_REASON });
		const walk = registry.walk(input.sessionId);
		if (!walk.ok) {
			const reason =
				walk.failure === "unknown-session"
					? UNKNOWN_RUN_REASON
					: `Blocked: broken parent chain at session ${walk.failureId}`;
			return Promise.resolve({ kind: "block", reason });
		}
		const state = this.state(registry, walk.rootSessionId);
		return new Promise<ChildAskOutcome>((resolve) => {
			const request: GateRequest = {
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
			// The deadline starts now, so time behind another prompt also counts.
			const timer = setTimeout(() => this.expire(state, request), this.timeoutMs);
			request.timer = timer;
			state.queue.push(request);
			// Batch requests that arrive in one tick, so the title counts them all.
			queueMicrotask(() => this.pump(state));
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

	private stateOf(registry: RunRegistry): RegistryState {
		let state = this.states.get(registry);
		if (!state) {
			state = { registry, roots: new Map(), surfaces: new Map() };
			this.states.set(registry, state);
			this.live.add(state);
		}
		return state;
	}

	/**
	 * Drop every captured surface. A surface is one gate generation's context, so
	 * a later install or a later test must not render on it. A root binds its
	 * surface again on its next gated call. A state with no root left keeps
	 * nothing, so it is dropped at once.
	 */
	clearSurfaces(): void {
		for (const state of this.live) {
			state.surfaces.clear();
			if (state.roots.size > 0) continue;
			this.states.delete(state.registry);
			this.live.delete(state);
		}
	}

	private state(registry: RunRegistry, rootSessionId: string): RootState {
		const roots = this.stateOf(registry).roots;
		let state = roots.get(rootSessionId);
		if (!state) {
			state = { registry, rootSessionId, queue: [], visible: null, parked: new Set() };
			roots.set(rootSessionId, state);
		}
		return state;
	}

	/** Show the head, or fail it closed when the root has no surface yet. */
	private pump(state: RootState): void {
		if (state.visible || state.parked.size > 0) return;
		const surfaces = this.stateOf(state.registry).surfaces;
		while (state.queue.length > 0) {
			const head = state.queue[0];
			if (head.settled) {
				state.queue.shift();
				continue;
			}
			const ctx = surfaces.get(state.rootSessionId);
			if (!ctx) {
				this.settle(state, head, { kind: "block", reason: CHILD_ASK_NO_SURFACE_REASON });
				continue;
			}
			// A root ask can own the panel slot. This wait is bounded by the request's
			// own deadline, so the wait never outlasts the ask that waits for a panel.
			void this.show(state, head, ctx);
			return;
		}
		this.release(state);
	}

	/**
	 * Take the shared panel slot, mount one prompt, and hand the slot back on
	 * every exit. The slot stops a root ask from mounting beside this panel. A
	 * request that times out while it waits for the slot never mounts here.
	 */
	private async show(state: RootState, head: GateRequest, ctx: ExtensionContext): Promise<void> {
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
					choice = await this.render(ctx, model, head.cancel.signal);
				} catch {
					choice = "deny";
				}
				this.answer(state, head, choice);
			} finally {
				releaseSlot();
			}
		} finally {
			state.parked.delete(head);
			this.pump(state);
		}
	}

	/** Drop a state with no work left, so the roots map does not grow per root. */
	private release(state: RootState): void {
		if (state.visible || state.queue.length > 0) return;
		const roots = this.stateOf(state.registry).roots;
		// A stale mount can outlive its own root entry, so only drop this exact state.
		if (roots.get(state.rootSessionId) === state) roots.delete(state.rootSessionId);
	}

	/** Turn one owner choice into a verdict, then show the next request. */
	private answer(state: RootState, request: GateRequest, choice: PermissionChoice): void {
		// A timeout may already have advanced the queue. A late panel answer is stale.
		if (state.visible !== request) return;
		state.visible = null;
		if (choice === "always-allow") {
			request.remember(request.key);
			this.settle(state, request, { kind: "allow", alwaysAllow: true });
		} else if (choice === "allow-once") {
			this.settle(state, request, { kind: "allow", alwaysAllow: false });
		} else {
			this.settle(state, request, { kind: "block", reason: DENIED_BY_USER_REASON });
		}
		this.pump(state);
	}

	/** Drop one request from the queue, clear its timer, and resolve it once. */
	private settle(state: RootState, request: GateRequest, outcome: ChildAskOutcome): void {
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

	/** The deadline path. The child is blocked, and the next request shows. */
	private expire(state: RootState, request: GateRequest): void {
		if (request.settled) return;
		this.settle(state, request, { kind: "block", reason: CHILD_ASK_DEADLINE_REASON });
		// Close the visible panel, so the next request is the only one on screen.
		request.cancel.abort();
		// A parked mount clears itself in its own finally. This path never clears
		// the parked count, so a later expire cannot start a second mount.
		this.pump(state);
		// The visible panel closes on its own microtask, so drop the drained root
		// here. A stale mount that resumes later cannot delete a newer state.
		this.release(state);
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
