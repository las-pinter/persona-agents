/**
 * Shared fixtures for the sidebar data collector tests.
 *
 * The fakes build a scripted git and MCP host, a synthetic context, and the
 * fake branch and tree-log writers. The study helpers build a temp home tree
 * and read the rendered status panel.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV_TREE_LOG } from "./depth.ts";
import { createSidebarData, type SidebarData } from "./sidebar-data.ts";
import { renderStatusPanel } from "./sidebar-panels.ts";
import { theme } from "./sidebar-render-fixtures.ts";
import type {
	McpSnapshot,
	SessionSnapshot,
	WorkspaceFileSnapshot,
} from "./sidebar-types.ts";
import { TODOS_TURN_ENTRY } from "./todo-tool.ts";
import { appendEvent, createRootLogPath, MAX_EVENTS_READ } from "./tree-log.ts";

/** A scripted response for the two git calls the collector makes. */
interface GitScript {
	status?: { code?: number; stdout?: string };
	numstat?: { code?: number; stdout?: string };
	/** The branch `git branch --show-current` reports. */
	branch?: string;
	/** Configured MCP server names reported by `getMcpServers`. */
	mcpServers?: string[];
	/** MCP tool names reported by `getAllTools`. */
	tools?: string[];
	/** A non-array `getAllTools` result, to prove it is not treated as readable. */
	toolsNonArray?: string;
	/** When true, `getAllTools` throws to simulate an unreadable list. */
	toolsError?: boolean;
	/** When true, `getAllTools` is absent to simulate an unavailable list. */
	noGetAllTools?: boolean;
	/** When true, the fake pi carries no `exec` to simulate a missing helper. */
	noExec?: boolean;
}

function execResult(code: number, stdout: string): ExecResult {
	return { stdout, stderr: "", code, killed: false };
}

/** A fake pi whose `exec` answers the git calls and who reports MCP state. */
export function makeFakePi(script: GitScript): ExtensionAPI {
	const noopUnsub = (): void => {};
	const pi: Record<string, unknown> = {
		exec: async (_command: string, args: string[]): Promise<ExecResult> => {
			if (args[0] === "status") return execResult(script.status?.code ?? 0, script.status?.stdout ?? "");
			if (args[0] === "diff") return execResult(script.numstat?.code ?? 0, script.numstat?.stdout ?? "");
			if (args[0] === "branch") return execResult(0, script.branch ?? "");
			return execResult(0, "");
		},
		on: noopUnsub,
		events: { on: noopUnsub, emit: () => {} },
		getMcpServers: () => (script.mcpServers ?? []).map((name) => ({ name })),
	};
	if (script.noExec) delete pi.exec;
	if (!script.noGetAllTools) {
		pi.getAllTools = () => {
			if (script.toolsError) throw new Error("tools-boom");
			if (script.toolsNonArray !== undefined) return script.toolsNonArray;
			return (script.tools ?? []).map((name) => ({ name }));
		};
	}
	return pi as unknown as ExtensionAPI;
}

/** A fake context with a fixed cwd and a synthetic session branch. */
export function makeFakeCtx(branch: unknown[] = [], cwd = "/repo"): ExtensionContext {
	const ctx = {
		cwd,
		model: { id: "test-model" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: null, contextWindow: null, percent: null }),
		sessionManager: { getBranch: () => branch },
	};
	return ctx as unknown as ExtensionContext;
}

/** Let the fire-and-forget git refresh finish. */
export async function flush(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Subscribe with a git script, wait for the refresh, and return the files. */
export async function readFiles(script: GitScript): Promise<WorkspaceFileSnapshot[]> {
	const data = createSidebarData(makeFakePi(script));
	try {
		data.subscribe(makeFakeCtx());
		await flush();
		return data.snapshot().workspace.files;
	} finally {
		data.dispose();
	}
}

/** Subscribe with a synthetic branch and return the summed session snapshot. */
export function readSession(branch: unknown[]): SessionSnapshot {
	const data = createSidebarData(makeFakePi({}));
	try {
		data.subscribe(makeFakeCtx(branch));
		return data.snapshot().session;
	} finally {
		data.dispose();
	}
}

/** Subscribe with an MCP script and return the server snapshot. */
export function readMcp(script: GitScript): McpSnapshot {
	const data = createSidebarData(makeFakePi(script));
	try {
		data.subscribe(makeFakeCtx());
		return data.snapshot().mcp;
	} finally {
		data.dispose();
	}
}

/** A fake pi whose event bus exposes the registered TODOS handler. */
export function makeEventBusPi(): { pi: ExtensionAPI; handlers: Map<string, (data: unknown) => void> } {
	const handlers = new Map<string, (data: unknown) => void>();
	const base = makeFakePi({}) as unknown as Record<string, unknown>;
	base.events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			handlers.set(channel, handler);
			return () => {};
		},
		emit: () => {},
	};
	return { pi: base as unknown as ExtensionAPI, handlers };
}

/** A fake pi that captures the `pi.on` handlers, so tests can fire session events. */
export function makeCapturingPi(script: GitScript = {}): {
	pi: ExtensionAPI;
	piHandlers: Map<string, (event: unknown, ctx: unknown) => void>;
} {
	const piHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const base = makeFakePi(script) as unknown as Record<string, unknown>;
	base.on = (event: string, handler: (event: unknown, ctx: unknown) => void) => {
		piHandlers.set(event, handler);
		return () => {};
	};
	return { pi: base as unknown as ExtensionAPI, piHandlers };
}

/** A branch that reconstructs to a single open todo and an active turn marker. */
export function markedBranch(): unknown[] {
	return [
		{
			type: "custom",
			customType: TODOS_TURN_ENTRY,
			data: {
				todos: [{ id: "1", text: "a", done: false }],
				nextId: 2,
				turn: 3,
				showTurnMarker: true,
			},
		},
	];
}

/** Write a temp tree log that holds one finished subagent, and return its path. */
export function writeFinishedSubagentLog(usage: Record<string, number>, clear: boolean): string {
	const logPath = createRootLogPath();
	const at = new Date().toISOString();
	appendEvent(logPath, { v: 1, type: "start", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "idle", at });
	appendEvent(logPath, { v: 1, type: "start", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "running", at });
	appendEvent(logPath, { v: 1, type: "end", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "done", at, mcpUsage: usage });
	if (clear) {
		const clearAt = new Date(Date.parse(at) + 1000).toISOString();
		appendEvent(logPath, { v: 1, type: "clear", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "running", at: clearAt });
	}
	return logPath;
}

/** Remove a temp log, ignoring a missing file. */
export function removeLog(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* the temp file may be gone */
	}
}

/** Restore the tree-log env after a test. */
export function restoreTreeLogEnv(previous: string | undefined): void {
	if (previous === undefined) delete process.env[ENV_TREE_LOG];
	else process.env[ENV_TREE_LOG] = previous;
}

/** Write a temp log whose root start sits before the read window, then a clear. */
export function writeOldRootStartLog(): string {
	const logPath = createRootLogPath();
	const base = Date.now() - 100_000;
	const stamp = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
	appendEvent(logPath, { v: 1, type: "start", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "idle", at: stamp(0) });
	for (let index = 0; index < MAX_EVENTS_READ + 5; index++) {
		appendEvent(logPath, { v: 1, type: "update", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "idle", at: stamp(index + 1) });
	}
	appendEvent(logPath, { v: 1, type: "clear", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "running", at: stamp(3000) });
	appendEvent(logPath, { v: 1, type: "start", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "running", at: stamp(3001) });
	appendEvent(logPath, { v: 1, type: "update", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "running", at: stamp(3002), toolCount: 2 });
	return logPath;
}

/** The project folder name for the fake context's `/repo` cwd. */
export const NOTES_STUDIES = "agent-notes/project-notes/repo/studies";

/** A `status.md` body in the documented shape. */
export function studyStatusFile(stage: string, updated: string): string {
	const lines = [
		"# Study — Status",
		"",
		`- **Stage:** ${stage}`,
		`- **Updated:** ${updated}`,
		"- **Owner:** planner",
	];
	return `${lines.join("\n")}\n`;
}

/** Write a temp home with the given relative files. The caller removes it. */
export function makeNotesHome(files: Record<string, string>): string {
	const home = mkdtempSync(join(tmpdir(), "study-notes-"));
	for (const [relative, body] of Object.entries(files)) {
		const full = join(home, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return home;
}

/** Run `fn` with `HOME` pointed at `home`, then restore the old value. */
export function withHome<T>(home: string, fn: () => T): T {
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
}

/** Subscribe against a home tree and return the rendered STUDY STATUS lines. */
export async function readStatusPanel(
	script: GitScript,
	home: string,
	cwd = "/repo",
	now = Date.now(),
): Promise<string[]> {
	// An empty log, so an ask record from another test cannot paint a LOG row.
	const previous = process.env[ENV_TREE_LOG];
	const logDir = mkdtempSync(join(tmpdir(), "status-log-"));
	process.env[ENV_TREE_LOG] = join(logDir, "tree.ndjson");
	const data = createSidebarData(makeFakePi(script));
	try {
		withHome(home, () => data.subscribe(makeFakeCtx([], cwd)));
		await flush();
		return renderStatusPanel(data.snapshot().status, 80, theme, now).map((line) => line.trimEnd());
	} finally {
		data.dispose();
		restoreTreeLogEnv(previous);
		rmSync(logDir, { recursive: true, force: true });
	}
}

/** The study names the snapshot lists, in panel order. */
export function studyNames(data: SidebarData): string[] {
	return (data.snapshot().status?.studies ?? []).map((row) => row.name);
}
