/**
 * Sidebar data collector — impure.
 *
 * Subscribes once to the pi events that keep a `SidebarSnapshot` fresh, owns the
 * shared state, and clears every listener and timer on dispose. The snapshot
 * areas live in five source modules, one source each: `sidebar-data-session.ts`
 * (session, TPS, TODOS), `sidebar-data-tree.ts` (tree rows and ask log),
 * `sidebar-data-git.ts` (workspace fields and git poll), `sidebar-data-mcp.ts`
 * (MCP list and usage), and `sidebar-data-study.ts` (STUDY STATUS).
 * `sidebar-data-guard.ts` holds the two error guards. Each source module starts
 * its own poll; this module calls the starters and clears them in `teardown`.
 *
 * The pure renderers in `sidebar-panels.ts` read the snapshot; this module
 * imports their view TYPES from `sidebar-types.ts` only (never the compositor or
 * the render functions).
 *
 * Every callback and timer body is wrapped in `try/catch`. Missing data yields a
 * defined default. A bad API call must never crash the TUI.
 *
 * The child loader carries no extension set, so the TODOS data here is the root
 * process's data only. The tree log is the only cross-process source.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAskLog, type AskLog } from "./ask-record.ts";
import { createMcpTally, type McpTally } from "./mcp-usage.ts";
import { guard, guardAsync } from "./sidebar-data-guard.ts";
import { refreshGit, startGitPoll } from "./sidebar-data-git.ts";
import {
	noteRootToolCall,
	refreshMcpFromDisk,
	resetMcpUsage,
	startMcpPoll,
} from "./sidebar-data-mcp.ts";
import {
	applyTodoPayload,
	feedTps,
	refreshSession,
	refreshTodosFromEntries,
	resetOutputTokens,
} from "./sidebar-data-session.ts";
import { emptyStatus, refreshStudy, startStudyPoll } from "./sidebar-data-study.ts";
import { refreshTree, startTreePoll } from "./sidebar-data-tree.ts";
import { resolveMcpJsonPath } from "./sidebar-sources.ts";
import type {
	SessionSnapshot,
	SidebarSnapshot,
	WorkspaceFileSnapshot,
	WorkspaceSnapshot,
} from "./sidebar-types.ts";
import { TODOS_EVENT_CHANNEL } from "./todo-tool.ts";

/** The public handle returned by `createSidebarData`. */
export interface SidebarData {
	/**
	 * A shallow copy of the current snapshot. Always fully defined. Nested
	 * values stay shared, so the caller must not mutate the result.
	 */
	snapshot(): SidebarSnapshot;
	/** Register the pi listeners and timers once. Returns an unsubscribe. */
	subscribe(ctx: ExtensionContext): () => void;
	/** Clear every timer and unsubscribe every listener. Idempotent. */
	dispose(): void;
}

/** One TPS window sample: tokens observed at a time. */
interface TpsSample {
	at: number;
	tokens: number;
}

/** Mutable state the collector holds and passes to the duty modules. */
export interface InternalState {
	snapshot: SidebarSnapshot;
	branch: string | null;
	changed: string[];
	changedCount: number;
	files: WorkspaceFileSnapshot[];
	todosNextId: number;
	tpsSamples: TpsSample[];
	lastOutputTokens: number;
	mcpJsonServers: string[];
	mcpJsonPath: string;
	/** Root MCP tool starts, counted in this process. */
	rootMcpUsage: Record<string, number>;
	/** Root tool-call ids already counted, so a repeated start is ignored. */
	rootCallIds: Set<string>;
	/** Session-wide subagent MCP usage, folded from the shared tree log. */
	mcpTally: McpTally;
	/** The newest ask queue events, rebuilt from the same log read. */
	askLog: AskLog;
	/**
	 * Study names that were open earlier in this process, so a closed study
	 * keeps its row. Process-wide by design: a restart is the boundary, so a
	 * session start does not clear it.
	 */
	seenStudies: Set<string>;
	unsubs: Array<() => void>;
	timers: Array<ReturnType<typeof setInterval>>;
	// Bumped on every subscribe and dispose. A stale unsubscribe must not tear
	// down a newer subscription.
	generation: number;
}

/** A fully defined snapshot before the first event. */
function emptySnapshot(): SidebarSnapshot {
	const session: SessionSnapshot = {
		model: null,
		thinkingLevel: null,
		contextTokens: null,
		contextWindow: null,
		contextPercent: null,
		cost: null,
		tps: null,
		tokensIn: 0,
		tokensOut: 0,
		turns: 0,
		sessionStartMs: null,
	};
	const workspace: WorkspaceSnapshot = {
		cwd: "",
		branch: null,
		changed: [],
		changedCount: 0,
		files: [],
	};
	return {
		cwd: "",
		tree: [],
		session,
		workspace,
		mcp: [],
		todos: [],
		todosTurnMarker: false,
		tps: 0,
		status: emptyStatus(),
		askLog: [],
	};
}

/** Build the data module. */
export function createSidebarData(pi: ExtensionAPI): SidebarData {
	const state: InternalState = {
		snapshot: emptySnapshot(),
		branch: null,
		changed: [],
		changedCount: 0,
		files: [],
		todosNextId: 1,
		tpsSamples: [],
		lastOutputTokens: 0,
		mcpJsonServers: [],
		mcpJsonPath: resolveMcpJsonPath(),
		rootMcpUsage: {},
		rootCallIds: new Set<string>(),
		mcpTally: createMcpTally(),
		askLog: createAskLog(),
		seenStudies: new Set<string>(),
		unsubs: [],
		timers: [],
		generation: 0,
	};

	/** Subscribe to one pi event. An unknown event is skipped, never fatal. */
	function onPi(subscribeToEvent: () => () => void): void {
		try {
			const unsub = subscribeToEvent();
			if (typeof unsub === "function") state.unsubs.push(unsub);
		} catch {
			/* this pi version has no such event; skip it */
		}
	}

	/** Clear every timer and unsubscribe every listener. */
	function teardown(): void {
		for (const timer of state.timers) {
			try {
				clearInterval(timer);
			} catch {
				/* already cleared */
			}
		}
		state.timers = [];
		for (const unsub of state.unsubs) {
			try {
				unsub();
			} catch {
				/* already unsubscribed */
			}
		}
		state.unsubs = [];
	}

	/** Register the pi listeners and start the polls. Idempotent. */
	function subscribe(ctx: ExtensionContext): () => void {
		teardown();
		const myGeneration = (state.generation += 1);

		// Initial reads so the first paint has real data.
		resetMcpUsage(state);
		guard(() => refreshSession(state, ctx));
		guard(() => refreshTodosFromEntries(state, ctx));
		guard(() => refreshMcpFromDisk(state, pi));
		guard(() => refreshTree(state));
		guard(() => refreshStudy(state));
		guardAsync(() => refreshGit(state, pi));

		// Session freshness. One listener per event; a missing event is skipped.
		onPi(() =>
			pi.on("session_start", (_event, eventCtx) =>
				guard(() => {
					// A new session zeroes the tally; the current log counts as seen.
					resetMcpUsage(state);
					refreshTodosFromEntries(state, eventCtx);
					refreshSession(state, eventCtx);
				}),
			),
		);
		onPi(() =>
			pi.on("session_info_changed", (_event, eventCtx) =>
				guard(() => refreshSession(state, eventCtx)),
			),
		);
		onPi(() =>
			pi.on("session_tree", (_event, eventCtx) =>
				guard(() => refreshTodosFromEntries(state, eventCtx)),
			),
		);
		onPi(() =>
			pi.on("model_select", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("thinking_level_select", (_event, eventCtx) =>
				guard(() => refreshSession(state, eventCtx)),
			),
		);
		onPi(() =>
			pi.on("turn_start", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("turn_end", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("message_start", (_event, eventCtx) =>
				guard(() => {
					resetOutputTokens(state);
					refreshSession(state, eventCtx);
				}),
			),
		);
		onPi(() =>
			pi.on("message_update", (event, _eventCtx) => guard(() => feedTps(state, event))),
		);
		onPi(() =>
			pi.on("message_end", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("agent_start", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("agent_end", (_event, eventCtx) => guard(() => refreshSession(state, eventCtx))),
		);
		onPi(() =>
			pi.on("tool_execution_start", (event, eventCtx) =>
				guard(() => {
					// A repeated call id counts once; the refresh stays skipped.
					if (noteRootToolCall(state, event)) refreshSession(state, eventCtx);
				}),
			),
		);
		onPi(() =>
			pi.on("tool_execution_update", (_event, eventCtx) =>
				guard(() => refreshSession(state, eventCtx)),
			),
		);
		onPi(() =>
			pi.on("tool_execution_end", (_event, eventCtx) =>
				guard(() => refreshSession(state, eventCtx)),
			),
		);
		onPi(() =>
			pi.on("mcp_servers_change", () => guard(() => refreshMcpFromDisk(state, pi))),
		);

		// TODOS channel: process-local. A bad payload is ignored.
		try {
			const unsub = pi.events.on(TODOS_EVENT_CHANNEL, (data) =>
				guard(() => applyTodoPayload(state, data)),
			);
			if (typeof unsub === "function") state.unsubs.push(unsub);
		} catch {
			/* the event bus is unavailable; TODOS stays empty */
		}

		// Polls. One timer per source module; each body is guarded there.
		startTreePoll(state);
		startGitPoll(state, pi);
		startMcpPoll(state, pi);
		startStudyPoll(state);

		return () => {
			if (myGeneration === state.generation) teardown();
		};
	}

	return {
		// A shallow copy: the caller must not mutate the internal snapshot.
		snapshot: () => ({ ...state.snapshot }),
		subscribe,
		dispose: () => {
			state.generation += 1;
			teardown();
		},
	};
}
