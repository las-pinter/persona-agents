/**
 * Child ask routing: a FIFO queue in front of the one root prompt.
 *
 * A child session has no UI, so its gate cannot render a prompt. The child
 * enqueues a request here instead. The root gate renders it with the root
 * context. One prompt is visible at a time. The title names the child and the
 * waiting count, and a denied head shows the next request.
 *
 * The deadline counts from arrival, so a request that waits behind another
 * prompt can still time out. A timed-out request leaves the queue and blocks
 * the child. The grant key carries the session, the role, the tool, and the
 * rule. A root grant does not cover a child. A child grant does not cover its
 * sibling.
 *
 * The queue reads the run registry the gate binds. With no bound registry the
 * gate takes its current root path, so a process without children is
 * unchanged. No pi runtime import: the renderer is injected, so the test needs
 * no terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DENIED_BY_USER_REASON,
	renderPermissionPrompt,
	type PermissionChoice,
	type PromptModel,
} from "./permission-prompt.ts";
import {
	UNKNOWN_RUN_REASON,
	type RunRecord,
	type RunRegistry,
} from "./run-registry.ts";

/** How long an unanswered request stays in the queue. */
export const CHILD_ASK_TIMEOUT_MS = 120_000;

/** The block reason after the deadline. The owner sees the same text. */
export const CHILD_ASK_TIMEOUT_REASON = "Blocked: the permission request timed out after 120 s";

/** The block reason when the root has no captured prompt surface. */
export const CHILD_ASK_NO_SURFACE_REASON = "Blocked: the root session has no prompt surface";

/**
 * The grant key. One answer covers one session, role, tool, and rule.
 * A key that lacks one part would lend the grant to a sibling or the root.
 */
export function grantKey(sessionId: string, role: string, toolName: string, ruleId: string): string {
	return `${sessionId}|${role}|${toolName}|${ruleId}`;
}

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

/** Everything a child enqueues. The gate fills the rule and the grant key. */
export interface ChildAskInput {
	/** The child session id. It scopes the grant and finds the root. */
	sessionId: string;
	/** The child agent name, shown in the title. */
	role: string;
	toolName: string;
	/** The rule identity inside the grant key. The compiled match is one rule. */
	ruleId: string;
	/** The full grant key the gate will test on the next call. */
	key: string;
	/** The prompt model, without the child-specific title. */
	model: PromptModel;
	/** Stores the key when the owner picks always-allow. */
	remember: (key: string) => void;
}

/** The renderer and the clock. Both have a production default. */
export interface ChildAskDeps {
	registry: RunRegistry;
	/** Defaults to the real prompt. */
	render?: (
		ctx: ExtensionContext,
		model: PromptModel,
		signal: AbortSignal,
	) => Promise<PermissionChoice>;
	/** Defaults to `CHILD_ASK_TIMEOUT_MS`. */
	timeoutMs?: number;
}

interface GateRequest {
	sessionId: string;
	role: string;
	toolName: string;
	ruleId: string;
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
	rootSessionId: string;
	queue: GateRequest[];
	/** The request whose prompt is on screen, or null. */
	visible: GateRequest | null;
}

/** Drop a stale title before the queue sets the child-specific one. */
function titled(model: PromptModel, title: string): PromptModel {
	return { ...model, title };
}

/** FIFO queue plus the single visible prompt, one state per root session. */
export class ChildAskQueue {
	private readonly roots = new Map<string, RootState>();
	/** The prompt surface of each root, kept after its queue drains. */
	private readonly surfaces = new Map<string, ExtensionContext>();
	private readonly registry: RunRegistry;
	private readonly render: NonNullable<ChildAskDeps["render"]>;
	private readonly timeoutMs: number;

	constructor(deps: ChildAskDeps) {
		this.registry = deps.registry;
		this.render = deps.render ?? renderPermissionPrompt;
		this.timeoutMs = deps.timeoutMs ?? CHILD_ASK_TIMEOUT_MS;
	}

	/** The record for one session, so the gate can tell a child from a root. */
	record(sessionId: string): Readonly<RunRecord> | undefined {
		return this.registry.get(sessionId);
	}

	/** True when this queue answers from the given registry. */
	serves(registry: RunRegistry): boolean {
		return this.registry === registry;
	}

	/**
	 * The walked depth of one session, or null when no root is reachable. The
	 * walk counts hops, so a record cannot under-report its own depth.
	 */
	depth(sessionId: string): number | null {
		const walk = this.registry.walk(sessionId);
		return walk.ok ? walk.depth : null;
	}

	/**
	 * Keep the prompt surface of a root session. A child call carries a child
	 * context, which has no UI, so only a walk that ends at the caller binds it.
	 * A headless root binds nothing, so its children fail closed instead of
	 * stalling on a prompt that the root path would block.
	 */
	noteContext(sessionId: string, ctx: ExtensionContext): void {
		const walk = this.registry.walk(sessionId);
		if (!walk.ok || walk.rootSessionId !== sessionId) return;
		if (!ctx.hasUI) return;
		this.surfaces.set(walk.rootSessionId, ctx);
	}

	/**
	 * Add one request to its root queue and resolve when the owner answers or
	 * the deadline passes. The promise never rejects, so the gate always gets a
	 * verdict.
	 */
	enqueue(input: ChildAskInput): Promise<ChildAskOutcome> {
		const walk = this.registry.walk(input.sessionId);
		if (!walk.ok) {
			const reason =
				walk.failure === "unknown-session"
					? UNKNOWN_RUN_REASON
					: `Blocked: broken parent chain at session ${walk.failureId}`;
			return Promise.resolve({ kind: "block", reason });
		}
		const state = this.state(walk.rootSessionId);
		return new Promise<ChildAskOutcome>((resolve) => {
			const request: GateRequest = {
				sessionId: input.sessionId,
				role: input.role,
				toolName: input.toolName,
				ruleId: input.ruleId,
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

	/** Live root states. A drained root is dropped, so the map cannot grow. */
	rootCount(): number {
		return this.roots.size;
	}

	/** Requests still waiting on one root, including the visible head. */
	waiting(rootSessionId: string): number {
		return this.roots.get(rootSessionId)?.queue.length ?? 0;
	}

	/** The child session whose prompt is visible, or null. */
	visible(rootSessionId: string): string | null {
		return this.roots.get(rootSessionId)?.visible?.sessionId ?? null;
	}

	private state(rootSessionId: string): RootState {
		let state = this.roots.get(rootSessionId);
		if (!state) {
			state = { rootSessionId, queue: [], visible: null };
			this.roots.set(rootSessionId, state);
		}
		return state;
	}

	/** Show the head, or fail it closed when the root has no surface yet. */
	private pump(state: RootState): void {
		if (state.visible) return;
		while (state.queue.length > 0) {
			const head = state.queue[0];
			if (head.settled) {
				state.queue.shift();
				continue;
			}
			const ctx = this.surfaces.get(state.rootSessionId);
			if (!ctx) {
				this.settle(state, head, { kind: "block", reason: CHILD_ASK_NO_SURFACE_REASON });
				continue;
			}
			state.visible = head;
			const model = titled(head.model, childPromptTitle(head.role, state.queue.length));
			let shown: Promise<PermissionChoice>;
			try {
				shown = this.render(ctx, model, head.cancel.signal);
			} catch {
				this.answer(state, head, "deny");
				return;
			}
			void shown.then(
				(choice) => this.answer(state, head, choice),
				() => this.answer(state, head, "deny"),
			);
			return;
		}
		this.release(state);
	}

	/** Drop a state with no work left, so the roots map does not grow per root. */
	private release(state: RootState): void {
		if (state.visible || state.queue.length > 0) return;
		this.roots.delete(state.rootSessionId);
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
		this.settle(state, request, { kind: "block", reason: CHILD_ASK_TIMEOUT_REASON });
		// Close the visible panel, so the next request is the only one on screen.
		request.cancel.abort();
		this.pump(state);
	}
}

/** The queue the gate uses, or null when no registry is bound. */
let routing: ChildAskQueue | null = null;

/**
 * Bind the registry the gate reads for session identity, and optionally the
 * renderer or the deadline. A null registry returns the gate to the root path.
 * A repeat bind of the same registry keeps the queue and its options.
 */
export function bindChildAskRegistry(
	registry: RunRegistry | null,
	options: Omit<ChildAskDeps, "registry"> = {},
): void {
	if (!registry) {
		routing = null;
		return;
	}
	if (routing?.serves(registry) && Object.keys(options).length === 0) return;
	routing = new ChildAskQueue({ registry, ...options });
}

/** The bound queue. The gate calls this on every tool call. */
export function childAskQueue(): ChildAskQueue | null {
	return routing;
}

/**
 * The walked depth of one session from the bound registry, or null. A caller
 * uses it to tell a child session from the root without a second registry.
 */
export function sessionDepthOf(sessionId: string): number | null {
	return routing ? routing.depth(sessionId) : null;
}
