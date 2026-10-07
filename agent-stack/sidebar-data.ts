/**
 * Sidebar data collector — impure.
 *
 * Subscribes once to the pi events that keep a `SidebarSnapshot` fresh, owns the
 * tree/git/MCP polls and the TPS sliding window, and unsubscribes on dispose.
 * The pure renderers in `sidebar-render.ts` read the snapshot; this module
 * imports their view TYPES only (never the compositor or the render functions).
 *
 * Every callback and timer body is wrapped in `try/catch`. Missing data yields a
 * defined default. A bad API call must never crash the TUI.
 *
 * `pi.events` is process-local, so the TODOS data here is the root process's
 * data only. The tree log is the only cross-process source.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { ENV_TREE_LOG } from "./depth.ts";
import { readEvents } from "./tree-log.ts";
import { assembleTree } from "./tree-model.ts";
import { TODOS_EVENT_CHANNEL, reconstructTodosFromEntries } from "./todo-tool.ts";
import type {
	SessionSnapshot,
	SidebarSnapshot,
	WorkspaceSnapshot,
} from "./sidebar-render.ts";

/** Tree-log poll cadence. */
export const TREE_POLL_MS = 500;
/** Git changed-file poll cadence. */
export const GIT_POLL_MS = 2000;
/** MCP poll cadence. */
export const MCP_POLL_MS = 5000;
/** TPS sliding window. */
export const TPS_WINDOW_MS = 2000;
/** A running node older than this is stale, per the plan. */
export const STALE_MS = 5 * 60 * 1000;
/** Git command timeout. */
const GIT_TIMEOUT_MS = 2000;
/** Changed names kept in the snapshot; the renderer shows this many. */
const CHANGED_SHOWN = 4;

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
	/**
	 * Set the git branch. The glue supplies it from the footer factory's
	 * `getGitBranch()`; this module never wires the footer.
	 */
	setBranch(branch: string | null): void;
}

/** One TPS window sample: tokens observed at a time. */
interface TpsSample {
	at: number;
	tokens: number;
}

/** Mutable state held inside the `createSidebarData` closure. */
interface InternalState {
	snapshot: SidebarSnapshot;
	branch: string | null;
	changed: string[];
	changedCount: number;
	todosNextId: number;
	tpsSamples: TpsSample[];
	lastOutputTokens: number;
	mcpJsonServers: string[];
	mcpJsonPath: string;
	unsubs: Array<() => void>;
	timers: Array<ReturnType<typeof setInterval>>;
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
	};
	const workspace: WorkspaceSnapshot = {
		cwd: "",
		branch: null,
		changed: [],
		changedCount: 0,
	};
	return { cwd: "", tree: [], session, workspace, mcp: [], todos: [], tps: 0 };
}

/** The agent directory's `mcp.json`, guarded against a missing helper. */
function resolveMcpJsonPath(): string {
	try {
		return join(getAgentDir(), "mcp.json");
	} catch {
		return join(homedir(), ".pi", "agent", "mcp.json");
	}
}

/** Server names from `mcp.json`. A missing or bad file gives `[]`. */
function readMcpJsonServers(filePath: string): string[] {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return [];
		const servers = (parsed as { mcpServers?: unknown }).mcpServers;
		if (typeof servers !== "object" || servers === null) return [];
		return Object.keys(servers as Record<string, unknown>);
	} catch {
		/* missing or malformed mcp.json is not an error */
		return [];
	}
}

/** Build the data module. */
export function createSidebarData(pi: ExtensionAPI): SidebarData {
	const state: InternalState = {
		snapshot: emptySnapshot(),
		branch: null,
		changed: [],
		changedCount: 0,
		todosNextId: 1,
		tpsSamples: [],
		lastOutputTokens: 0,
		mcpJsonServers: [],
		mcpJsonPath: resolveMcpJsonPath(),
		unsubs: [],
		timers: [],
	};
	// Bumped on every subscribe and dispose. A stale unsubscribe must not tear
	// down a newer subscription.
	let generation = 0;

	/** Run a callback and swallow every error. */
	function guard(fn: () => void): void {
		try {
			fn();
		} catch {
			/* a panel must never crash pi */
		}
	}

	/** Run an async callback and swallow every error. */
	function guardAsync(fn: () => Promise<void>): void {
		void (async () => {
			try {
				await fn();
			} catch {
				/* a panel must never crash pi */
			}
		})();
	}

	/** Subscribe to one pi event. An unknown event is skipped, never fatal. */
	function onPi(subscribeToEvent: () => () => void): void {
		try {
			const unsub = subscribeToEvent();
			if (typeof unsub === "function") state.unsubs.push(unsub);
		} catch {
			/* this pi version has no such event; skip it */
		}
	}

	/** Push the current git branch and changed list into the workspace snapshot. */
	function applyWorkspace(): void {
		state.snapshot.workspace = {
			cwd: state.snapshot.workspace.cwd,
			branch: state.branch,
			changed: state.changed.slice(),
			changedCount: state.changedCount,
		};
	}

	/** Mark git as unavailable. The changed list shows the degradation marker. */
	function markGitUnavailable(): void {
		state.changed = ["(git unavailable)"];
		state.changedCount = 1;
	}

	/** Sum `AssistantMessage.usage` cost over a session branch. Never throws. */
	function sumBranchCost(ctx: ExtensionContext): number {
		try {
			const entries = ctx.sessionManager.getBranch();
			let cost = 0;
			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const message = entry.message as {
					role?: string;
					usage?: { cost?: { total?: number } };
				};
				if (message?.role !== "assistant") continue;
				const total = message.usage?.cost?.total;
				if (typeof total === "number" && Number.isFinite(total)) cost += total;
			}
			return cost;
		} catch {
			return 0;
		}
	}

	/** Recompute the TPS sliding window and write it into the snapshot. */
	function updateTps(now: number): void {
		const cutoff = now - TPS_WINDOW_MS;
		state.tpsSamples = state.tpsSamples.filter((sample) => sample.at >= cutoff);
		let tps = 0;
		if (state.tpsSamples.length > 0) {
			const total = state.tpsSamples.reduce((sum, sample) => sum + sample.tokens, 0);
			const oldest = state.tpsSamples[0].at;
			const seconds = Math.max(1, (now - oldest) / 1000);
			tps = total / seconds;
		}
		state.snapshot.tps = tps;
		state.snapshot.session.tps = tps;
	}

	/** Read one context into the session snapshot. */
	function refreshSession(ctx: ExtensionContext): void {
		const session = { ...state.snapshot.session };
		try {
			session.model = ctx.model?.id ?? null;
		} catch {
			session.model = null;
		}
		session.thinkingLevel = ctx.thinkingLevel ?? null;

		let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
		try {
			usage = ctx.getContextUsage();
		} catch {
			usage = undefined;
		}
		session.contextTokens = usage?.tokens ?? null;
		session.contextWindow = usage?.contextWindow ?? null;
		session.contextPercent = usage?.percent ?? null;
		session.cost = sumBranchCost(ctx);

		state.snapshot.session = session;
		const cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
		state.snapshot.cwd = cwd;
		state.snapshot.workspace.cwd = cwd;
		updateTps(Date.now());
		applyWorkspace();
	}

	/** Read the shared tree log into the snapshot. */
	function refreshTree(): void {
		const logPath = process.env[ENV_TREE_LOG];
		if (!logPath) {
			state.snapshot.tree = [];
			return;
		}
		const events = readEvents(logPath);
		state.snapshot.tree = assembleTree(events, Date.now(), STALE_MS);
	}

	/** Poll `git status --porcelain` for the changed-file summary. */
	async function refreshGit(): Promise<void> {
		const myGeneration = generation;
		const cwd = state.snapshot.workspace.cwd || state.snapshot.cwd;
		if (!cwd) return;
		if (typeof pi.exec !== "function") {
			markGitUnavailable();
			applyWorkspace();
			return;
		}
		try {
			const result = await pi.exec("git", ["status", "--porcelain"], {
				cwd,
				timeout: GIT_TIMEOUT_MS,
			});
			// dispose() bumps the generation; drop a stale write after the await.
			if (myGeneration !== generation) return;
			if (!result || result.code !== 0) {
				markGitUnavailable();
				applyWorkspace();
				return;
			}
			const names: string[] = [];
			for (const line of String(result.stdout ?? "").split("\n")) {
				if (line.trim().length === 0) continue;
				let path = line.slice(3).trim();
				const arrow = path.indexOf(" -> ");
				if (arrow >= 0) path = path.slice(arrow + 4);
				if (path.length > 0) names.push(path);
			}
			state.changedCount = names.length;
			state.changed = names.slice(0, CHANGED_SHOWN);
		} catch {
			if (myGeneration !== generation) return;
			markGitUnavailable();
		}
		applyWorkspace();
	}

	/** Refresh the MCP server list from `mcp.json` and `pi.getMcpServers()`. */
	function refreshMcp(): void {
		// Re-read `mcp.json` on every poll: a new server must appear without reload.
		state.mcpJsonServers = readMcpJsonServers(state.mcpJsonPath);
		const configured = new Set<string>(state.mcpJsonServers);
		try {
			if (typeof pi.getMcpServers === "function") {
				for (const server of pi.getMcpServers() ?? []) {
					if (server && typeof server.name === "string") configured.add(server.name);
				}
			}
		} catch {
			/* keep the configured set from mcp.json */
		}

		const connected = new Set<string>();
		try {
			if (typeof pi.getAllTools === "function") {
				for (const tool of pi.getAllTools() ?? []) {
					const match = /^mcp__(.+?)__/.exec(tool?.name ?? "");
					if (match) connected.add(match[1]);
				}
			}
		} catch {
			/* no connection state is available; every server stays unconnected */
		}

		state.snapshot.mcp = [...configured]
			.sort()
			.map((name) => ({ name, configured: true, connected: connected.has(name) }));
	}

	/** Apply one `persona-agents/todos/v1` payload. Bad data is ignored. */
	function applyTodoPayload(data: unknown): void {
		if (typeof data !== "object" || data === null) return;
		const payload = data as { todos?: unknown; nextId?: unknown };
		if (!Array.isArray(payload.todos)) return;
		const todos: Array<{ id: string; text: string; done: boolean }> = [];
		for (const item of payload.todos) {
			if (typeof item !== "object" || item === null) continue;
			const candidate = item as { id?: unknown; text?: unknown; done?: unknown };
			if (candidate.id === undefined || candidate.text === undefined) continue;
			todos.push({
				id: String(candidate.id),
				text: String(candidate.text),
				done: candidate.done === true,
			});
		}
		state.snapshot.todos = todos;
		if (typeof payload.nextId === "number" && Number.isFinite(payload.nextId)) {
			state.todosNextId = payload.nextId;
		}
	}

	/** Rebuild TODOS from session entries, for `/reload` and resume. */
	function refreshTodosFromEntries(ctx: ExtensionContext): void {
		try {
			const reconstructed = reconstructTodosFromEntries(ctx.sessionManager.getBranch());
			state.snapshot.todos = reconstructed.todos.map((todo) => ({
				id: todo.id,
				text: todo.text,
				done: todo.done,
			}));
			state.todosNextId = reconstructed.nextId;
		} catch {
			state.snapshot.todos = [];
		}
	}

	/** Feed one `message_update` into the TPS window. */
	function feedTps(event: { assistantMessageEvent?: unknown }): void {
		const evt = event?.assistantMessageEvent as
			| { type?: string; delta?: unknown; partial?: { usage?: { output?: unknown } } }
			| undefined;
		let deltaTokens = 0;
		const output = evt?.partial?.usage?.output;
		if (typeof output === "number" && Number.isFinite(output)) {
			const diff = output - state.lastOutputTokens;
			if (diff > 0) {
				deltaTokens = diff;
				state.lastOutputTokens = output;
			}
		}
		if (deltaTokens === 0) {
			// Char/4 fallback when usage is absent or not yet streaming.
			if (
				(evt?.type === "text_delta" ||
					evt?.type === "thinking_delta" ||
					evt?.type === "toolcall_delta") &&
				typeof evt.delta === "string"
			) {
				deltaTokens = evt.delta.length / 4;
			}
		}
		if (deltaTokens > 0) {
			state.tpsSamples.push({ at: Date.now(), tokens: deltaTokens });
		}
		updateTps(Date.now());
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
		const myGeneration = (generation += 1);

		// Initial reads so the first paint has real data.
		guard(() => refreshSession(ctx));
		guard(() => refreshTodosFromEntries(ctx));
		guard(() => {
			state.mcpJsonServers = readMcpJsonServers(state.mcpJsonPath);
		});
		guard(() => refreshMcp());
		guard(() => refreshTree());
		guardAsync(() => refreshGit());

		// Session freshness. One listener per event; a missing event is skipped.
		onPi(() =>
			pi.on("session_start", (_event, eventCtx) =>
				guard(() => {
					refreshTodosFromEntries(eventCtx);
					refreshSession(eventCtx);
				}),
			),
		);
		onPi(() =>
			pi.on("session_info_changed", (_event, eventCtx) => guard(() => refreshSession(eventCtx))),
		);
		onPi(() =>
			pi.on("session_tree", (_event, eventCtx) =>
				guard(() => refreshTodosFromEntries(eventCtx)),
			),
		);
		onPi(() =>
			pi.on("model_select", (_event, eventCtx) => guard(() => refreshSession(eventCtx))),
		);
		onPi(() =>
			pi.on("thinking_level_select", (_event, eventCtx) =>
				guard(() => refreshSession(eventCtx)),
			),
		);
		onPi(() => pi.on("turn_start", (_event, eventCtx) => guard(() => refreshSession(eventCtx))));
		onPi(() => pi.on("turn_end", (_event, eventCtx) => guard(() => refreshSession(eventCtx))));
		onPi(() =>
			pi.on("message_start", (_event, eventCtx) =>
				guard(() => {
					state.lastOutputTokens = 0;
					refreshSession(eventCtx);
				}),
			),
		);
		onPi(() =>
			pi.on("message_update", (event, _eventCtx) => guard(() => feedTps(event))),
		);
		onPi(() => pi.on("message_end", (_event, eventCtx) => guard(() => refreshSession(eventCtx))));
		onPi(() => pi.on("agent_start", (_event, eventCtx) => guard(() => refreshSession(eventCtx))));
		onPi(() => pi.on("agent_end", (_event, eventCtx) => guard(() => refreshSession(eventCtx))));
		onPi(() =>
			pi.on("tool_execution_start", (_event, eventCtx) => guard(() => refreshSession(eventCtx))),
		);
		onPi(() =>
			pi.on("tool_execution_update", (_event, eventCtx) =>
				guard(() => refreshSession(eventCtx)),
			),
		);
		onPi(() =>
			pi.on("tool_execution_end", (_event, eventCtx) => guard(() => refreshSession(eventCtx))),
		);
		onPi(() =>
			pi.on("mcp_servers_change", () => guard(() => refreshMcp())),
		);

		// TODOS channel: process-local. A bad payload is ignored.
		try {
			const unsub = pi.events.on(TODOS_EVENT_CHANNEL, (data) =>
				guard(() => applyTodoPayload(data)),
			);
			if (typeof unsub === "function") state.unsubs.push(unsub);
		} catch {
			/* the event bus is unavailable; TODOS stays empty */
		}

		// Polls. Each body is guarded.
		state.timers.push(setInterval(() => guard(() => refreshTree()), TREE_POLL_MS));
		state.timers.push(setInterval(() => guardAsync(() => refreshGit()), GIT_POLL_MS));
		state.timers.push(setInterval(() => guard(() => refreshMcp()), MCP_POLL_MS));

		return () => {
			if (myGeneration === generation) teardown();
		};
	}

	return {
		// A shallow copy: the caller must not mutate the internal snapshot.
		snapshot: () => ({ ...state.snapshot }),
		subscribe,
		dispose: () => {
			generation += 1;
			teardown();
		},
		setBranch: (branch: string | null) => {
			state.branch = branch;
			applyWorkspace();
		},
	};
}
