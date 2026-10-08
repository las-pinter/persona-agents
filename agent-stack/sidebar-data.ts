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
	McpServerStatus,
	SessionSnapshot,
	SidebarSnapshot,
	WorkspaceFileSnapshot,
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
/** Per-file diff rows kept in the snapshot. Bounds the cross-timer payload. */
const WORKSPACE_FILES_CAP = 50;

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
	files: WorkspaceFileSnapshot[];
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

/** One row parsed from `git status --porcelain`. */
interface StatusFile {
	path: string;
	untracked: boolean;
}

/** One row parsed from `git diff --numstat HEAD`. */
interface DiffStat {
	path: string;
	added: number;
	removed: number;
}

/**
 * Parse `git status --porcelain` v1. The first two columns hold the status;
 * a rename uses the destination path. A short or empty line is skipped.
 */
function parsePorcelain(output: string): StatusFile[] {
	const files: StatusFile[] = [];
	for (const line of output.split("\n")) {
		if (line.length < 4) continue;
		const status = line.slice(0, 2);
		let path = line.slice(3);
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		if (path.length === 0) continue;
		files.push({ path, untracked: status === "??" });
	}
	return files;
}

/** Resolve a numstat rename path (`old => new` or `dir/{old => new}.ts`). */
function normalizeNumstatPath(rawPath: string): string {
	const path = rawPath.trim();
	const braced = path.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
	if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
	const arrow = path.lastIndexOf(" => ");
	if (arrow >= 0) return path.slice(arrow + 4).trim();
	return path;
}

/** Parse `git diff --numstat`. A binary row (`-`) counts as zero lines. */
function parseNumstat(output: string): Map<string, DiffStat> {
	const stats = new Map<string, DiffStat>();
	for (const line of output.split("\n")) {
		if (line.trim().length === 0) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
		const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
		const path = normalizeNumstatPath(parts.slice(2).join("\t"));
		if (path.length === 0) continue;
		stats.set(path, {
			path,
			added: Number.isFinite(added) ? added : 0,
			removed: Number.isFinite(removed) ? removed : 0,
		});
	}
	return stats;
}

/**
 * Merge the status rows with the numstat rows. A status row keeps its order and
 * its untracked flag; numstat supplies added/removed lines. A numstat-only path
 * is tracked. An untracked file has no numstat row, so it stays added/removed 0.
 */
function combineWorkspaceFiles(
	statusFiles: StatusFile[],
	diffByPath: Map<string, DiffStat>,
): WorkspaceFileSnapshot[] {
	const files: WorkspaceFileSnapshot[] = [];
	const seen = new Set<string>();
	for (const status of statusFiles) {
		if (seen.has(status.path)) continue;
		seen.add(status.path);
		const diff = diffByPath.get(status.path);
		files.push({
			path: status.path,
			added: diff?.added ?? 0,
			removed: diff?.removed ?? 0,
			untracked: status.untracked,
		});
	}
	for (const [path, diff] of diffByPath) {
		if (seen.has(path)) continue;
		seen.add(path);
		files.push({ path, added: diff.added, removed: diff.removed, untracked: false });
	}
	return files;
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

	/** Push the current git branch, changed list, and file stats into the workspace. */
	function applyWorkspace(): void {
		state.snapshot.workspace = {
			cwd: state.snapshot.workspace.cwd,
			branch: state.branch,
			changed: state.changed.slice(),
			changedCount: state.changedCount,
			files: state.files.slice(),
		};
	}

	/** Mark git as unavailable. The changed list shows the degradation marker. */
	function markGitUnavailable(): void {
		state.changed = ["(git unavailable)"];
		state.changedCount = 1;
		state.files = [];
	}

	/** Sum assistant `usage` over a session branch and find the branch start. */
	function sumBranchUsage(ctx: ExtensionContext): {
		cost: number;
		tokensIn: number;
		tokensOut: number;
		turns: number;
		sessionStartMs: number | null;
	} {
		try {
			const entries = ctx.sessionManager.getBranch();
			let cost = 0;
			let tokensIn = 0;
			let tokensOut = 0;
			let turns = 0;
			let sessionStartMs: number | null = null;
			for (const entry of entries) {
				const parsed = Date.parse(entry.timestamp);
				if (Number.isFinite(parsed) && (sessionStartMs === null || parsed < sessionStartMs)) {
					sessionStartMs = parsed;
				}
				if (entry.type !== "message") continue;
				const message = entry.message as {
					role?: string;
					usage?: {
						input?: number;
						output?: number;
						cost?: { total?: number };
					};
				};
				if (message?.role !== "assistant") continue;
				turns += 1;
				const total = message.usage?.cost?.total;
				if (typeof total === "number" && Number.isFinite(total)) cost += total;
				const input = message.usage?.input;
				if (typeof input === "number" && Number.isFinite(input)) tokensIn += input;
				const output = message.usage?.output;
				if (typeof output === "number" && Number.isFinite(output)) tokensOut += output;
			}
			return { cost, tokensIn, tokensOut, turns, sessionStartMs };
		} catch {
			return { cost: 0, tokensIn: 0, tokensOut: 0, turns: 0, sessionStartMs: null };
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
		const branchUsage = sumBranchUsage(ctx);
		session.cost = branchUsage.cost;
		session.tokensIn = branchUsage.tokensIn;
		session.tokensOut = branchUsage.tokensOut;
		session.turns = branchUsage.turns;
		session.sessionStartMs = branchUsage.sessionStartMs;

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

	/** Poll git status and diff for changed files and per-file line stats. */
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
			const [status, numstat] = await Promise.all([
				pi.exec("git", ["status", "--porcelain"], { cwd, timeout: GIT_TIMEOUT_MS }),
				pi.exec("git", ["diff", "--numstat", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
			]);
			// dispose() bumps the generation; drop a stale write after the await.
			if (myGeneration !== generation) return;
			if (!status || status.code !== 0) {
				markGitUnavailable();
				applyWorkspace();
				return;
			}
			// A numstat failure (for example a repo with no HEAD) still leaves the
			// status list intact; only the per-file line counts are missing.
			const statusFiles = parsePorcelain(String(status.stdout ?? ""));
			const diffByPath =
				numstat && numstat.code === 0 ? parseNumstat(String(numstat.stdout ?? "")) : new Map<string, DiffStat>();
			const files = combineWorkspaceFiles(statusFiles, diffByPath);
			state.changedCount = files.length;
			state.changed = files.slice(0, CHANGED_SHOWN).map((file) => file.path);
			state.files = files.slice(0, WORKSPACE_FILES_CAP);
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
		// True only when the MCP tool list was read successfully. A missing or
		// throwing `getAllTools` leaves this false, so a configured server becomes
		// `unknown` instead of a false `disconnected`.
		let toolsReadable = false;
		try {
			if (typeof pi.getAllTools === "function") {
				const tools = pi.getAllTools();
				// Only an array carries tool entries. A bare string would iterate its
				// characters and wrongly turn `unknown` into `disconnected`.
				if (Array.isArray(tools)) {
					for (const tool of tools) {
						const match = /^mcp__(.+?)__/.exec(tool?.name ?? "");
						if (match) connected.add(match[1]);
					}
					toolsReadable = true;
				}
			}
		} catch {
			/* the tool list is unavailable; every configured server is unknown */
		}

		state.snapshot.mcp = [...configured].sort().map((name) => {
			// pi sanitizes non `[A-Za-z0-9_]` characters in a tool name to `_`, so
			// `my-server` appears as `my_server`. Match the raw name first, then the
			// sanitized name, so a connected server is not painted red.
			const normalized = name.replace(/[^A-Za-z0-9_]/g, "_");
			const isConnected = toolsReadable && (connected.has(name) || connected.has(normalized));
			const status: McpServerStatus = !toolsReadable
				? "unknown"
				: isConnected
					? "connected"
					: "disconnected";
			return { name, configured: true, connected: isConnected, status };
		});
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
