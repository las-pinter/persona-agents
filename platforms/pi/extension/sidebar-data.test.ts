/**
 * Regression harness for the sidebar data collector's git parsers and session
 * usage sums.
 *
 * The module loads under plain Node (type stripping) because the pi runtime
 * import resolves, so no extraction was needed. The pure helpers are
 * module-private, so these tests drive them through the public
 * `createSidebarData` handle with a fake `pi` and `ExtensionContext`. No real
 * git process and no real timers run; every test disposes the data handle.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STUDY_POLL_MS, TREE_POLL_MS, createSidebarData, type SidebarData } from "./sidebar-data.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent, createRootLogPath, MAX_EVENTS_READ } from "./tree-log.ts";
import { findNode } from "./tree-model.ts";
import {
	renderStatusPanel,
	renderTreeLines,
	statusGlyph,
	type McpSnapshot,
	type SessionSnapshot,
	type WorkspaceFileSnapshot,
} from "./sidebar-render.ts";
import { theme } from "./sidebar-render-fixtures.ts";
import { TODOS_EVENT_CHANNEL, TODOS_TURN_ENTRY } from "./todo-tool.ts";

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
function makeFakePi(script: GitScript): ExtensionAPI {
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
function makeFakeCtx(branch: unknown[] = [], cwd = "/repo"): ExtensionContext {
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
async function flush(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Subscribe with a git script, wait for the refresh, and return the files. */
async function readFiles(script: GitScript): Promise<WorkspaceFileSnapshot[]> {
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
function readSession(branch: unknown[]): SessionSnapshot {
	const data = createSidebarData(makeFakePi({}));
	try {
		data.subscribe(makeFakeCtx(branch));
		return data.snapshot().session;
	} finally {
		data.dispose();
	}
}

/** Subscribe with an MCP script and return the server snapshot. */
function readMcp(script: GitScript): McpSnapshot {
	const data = createSidebarData(makeFakePi(script));
	try {
		data.subscribe(makeFakeCtx());
		return data.snapshot().mcp;
	} finally {
		data.dispose();
	}
}

// --- porcelain parsing -------------------------------------------------------

test("a porcelain rename keeps the destination path", async () => {
	const files = await readFiles({ status: { stdout: "R  old.ts -> new.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["new.ts"],
	);
});

test("a porcelain rename with spaces keeps the full destination path", async () => {
	const files = await readFiles({ status: { stdout: "R  old name.ts -> new name.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["new name.ts"],
	);
});

test("a porcelain path with spaces is kept whole", async () => {
	const files = await readFiles({ status: { stdout: " M a path/with spaces.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["a path/with spaces.ts"],
	);
});

test("a porcelain untracked line marks the file untracked", async () => {
	const files = await readFiles({ status: { stdout: "?? scratch file.ts" } });

	assert.deepEqual(files, [{ path: "scratch file.ts", added: 0, removed: 0, untracked: true }]);
});

// --- numstat parsing ---------------------------------------------------------

test("a normal numstat row carries added and removed counts", async () => {
	const files = await readFiles({
		status: { stdout: " M code.ts" },
		numstat: { stdout: "12\t3\tcode.ts" },
	});

	assert.deepEqual(files, [{ path: "code.ts", added: 12, removed: 3, untracked: false }]);
});

test("a binary numstat row counts zero added and removed lines", async () => {
	const files = await readFiles({
		status: { stdout: " M image.png" },
		numstat: { stdout: "-\t-\timage.png" },
	});

	assert.deepEqual(files, [{ path: "image.png", added: 0, removed: 0, untracked: false }]);
});

test("a numstat path with spaces is kept whole", async () => {
	const files = await readFiles({
		status: { stdout: " M a file with spaces.ts" },
		numstat: { stdout: "5\t2\ta file with spaces.ts" },
	});

	assert.equal(files[0]?.path, "a file with spaces.ts");
	assert.equal(files[0]?.added, 5);
	assert.equal(files[0]?.removed, 2);
});

test("an unbraced numstat rename resolves to the new path", async () => {
	const files = await readFiles({
		status: { stdout: "R  old name.ts -> new name.ts" },
		numstat: { stdout: "0\t0\told name.ts => new name.ts" },
	});

	assert.deepEqual(files, [{ path: "new name.ts", added: 0, removed: 0, untracked: false }]);
});

test("a braced numstat rename joins the directory and the new name", async () => {
	const files = await readFiles({
		status: { stdout: "R  dir/old.ts -> dir/new.ts" },
		numstat: { stdout: "0\t0\tdir/{old.ts => new.ts}" },
	});

	assert.deepEqual(
		files.map((file) => file.path),
		["dir/new.ts"],
	);
});

// --- combining status and numstat --------------------------------------------

test("an untracked file with no numstat row keeps untracked and zero stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts\n M code.ts" },
		numstat: { stdout: "3\t0\tcode.ts" },
	});

	assert.equal(files.length, 2);
	assert.deepEqual(files.find((file) => file.path === "scratch.ts"), {
		path: "scratch.ts",
		added: 0,
		removed: 0,
		untracked: true,
	});
	assert.deepEqual(files.find((file) => file.path === "code.ts"), {
		path: "code.ts",
		added: 3,
		removed: 0,
		untracked: false,
	});
});

test("a numstat-only path is added as tracked with zero untracked", async () => {
	const files = await readFiles({
		status: { stdout: " M code.ts" },
		numstat: { stdout: "1\t1\tcode.ts\n2\t0\tonly-in-diff.ts" },
	});

	assert.deepEqual(files.find((file) => file.path === "only-in-diff.ts"), {
		path: "only-in-diff.ts",
		added: 2,
		removed: 0,
		untracked: false,
	});
});

test("an errored numstat keeps the status entries with zero line stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts\n M code.ts" },
		numstat: { code: 1, stdout: "fatal: bad revision 'HEAD'" },
	});

	assert.deepEqual(files, [
		{ path: "scratch.ts", added: 0, removed: 0, untracked: true },
		{ path: "code.ts", added: 0, removed: 0, untracked: false },
	]);
});

test("an empty numstat keeps the status entries with zero line stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts" },
		numstat: { code: 0, stdout: "" },
	});

	assert.deepEqual(files, [{ path: "scratch.ts", added: 0, removed: 0, untracked: true }]);
});

// --- workspace branch --------------------------------------------------------

test("a changed workspace cwd clears the old branch name", async () => {
	const { pi, piHandlers } = makeCapturingPi({ branch: "main" });
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx([], "/repo"));
		await flush();
		assert.equal(data.snapshot().workspace.branch, "main", "the first read kept no branch");
		piHandlers.get("session_start")?.({}, makeFakeCtx([], "/repo"));
		assert.equal(
			data.snapshot().workspace.branch,
			"main",
			"a session start in the unchanged cwd dropped the branch name",
		);
		piHandlers.get("session_start")?.({}, makeFakeCtx([], "/elsewhere"));
		assert.equal(
			data.snapshot().workspace.branch,
			null,
			"the old branch name outlived its repository",
		);
	} finally {
		data.dispose();
	}
});

// --- MCP status derivation ---------------------------------------------------

test("an mcp__<server>__ tool marks the server connected", () => {
	const mcp = readMcp({ mcpServers: ["context7"], tools: ["mcp__context7__search"] });
	const server = mcp.find((entry) => entry.name === "context7");
	assert.equal(server?.status, "connected");
	assert.equal(server?.connected, true);
});

test("a readable tool list with no matching tool marks the server disconnected", () => {
	const mcp = readMcp({ mcpServers: ["exa"], tools: ["mcp__other__search"] });
	const server = mcp.find((entry) => entry.name === "exa");
	assert.equal(server?.status, "disconnected");
	assert.equal(server?.connected, false);
});

test("a hyphenated server matches its sanitized tool name and is connected", () => {
	const mcp = readMcp({ mcpServers: ["my-server"], tools: ["mcp__my_server__search"] });
	const server = mcp.find((entry) => entry.name === "my-server");
	assert.equal(server?.status, "connected");
	assert.equal(server?.connected, true);
});

test("a non-array tool list marks every server unknown", () => {
	const mcp = readMcp({ mcpServers: ["context7", "exa"], toolsNonArray: "oops" });
	assert.ok(mcp.length > 0);
	assert.ok(mcp.every((entry) => entry.status === "unknown"));
});

test("an errored tool list marks the server unknown", () => {
	const mcp = readMcp({ mcpServers: ["exa"], toolsError: true });
	const server = mcp.find((entry) => entry.name === "exa");
	assert.equal(server?.status, "unknown");
	assert.equal(server?.connected, false);
});

test("an absent getAllTools marks the server unknown", () => {
	const mcp = readMcp({ mcpServers: ["exa"], noGetAllTools: true });
	const server = mcp.find((entry) => entry.name === "exa");
	assert.equal(server?.status, "unknown");
});

// --- session usage sums ------------------------------------------------------

test("two assistant messages sum tokens and count turns", () => {
	const session = readSession([
		{ type: "meta", timestamp: "2026-01-01T00:00:00.000Z" },
		{
			type: "message",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.01 } } },
		},
		{
			type: "message",
			timestamp: "2026-01-01T00:00:10.000Z",
			message: { role: "assistant", usage: { input: 200, output: 40, cost: { total: 0.02 } } },
		},
	]);

	assert.equal(session.tokensIn, 300);
	assert.equal(session.tokensOut, 60);
	assert.equal(session.turns, 2);
	assert.equal(session.sessionStartMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("the earliest entry sets the session start even when it is not a message", () => {
	const session = readSession([
		{ type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
		{ type: "meta", timestamp: "2026-01-01T00:00:00.000Z" },
	]);

	assert.equal(session.sessionStartMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("a user message is not counted as an assistant turn", () => {
	const session = readSession([
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{
			type: "message",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0 } } },
		},
	]);

	assert.equal(session.turns, 1);
	assert.equal(session.tokensIn, 7);
	assert.equal(session.tokensOut, 3);
});

// --- todo turn marker plumbing -----------------------------------------------

/** A fake pi whose event bus exposes the registered TODOS handler. */
function makeEventBusPi(): { pi: ExtensionAPI; handlers: Map<string, (data: unknown) => void> } {
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

test("a todo payload with showTurnMarker true sets the snapshot marker", () => {
	const { pi, handlers } = makeEventBusPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		assert.equal(data.snapshot().todosTurnMarker, false, "the default is no marker");

		handlers.get(TODOS_EVENT_CHANNEL)?.({
			todos: [{ id: "1", text: "a", done: false }],
			nextId: 2,
			showTurnMarker: true,
		});
		assert.equal(data.snapshot().todosTurnMarker, true);

		handlers.get(TODOS_EVENT_CHANNEL)?.({ todos: [], nextId: 1 });
		assert.equal(data.snapshot().todosTurnMarker, false, "a payload without the flag clears it");
	} finally {
		data.dispose();
	}
});

test("refreshTodosFromEntries carries the reconstructed turn marker", () => {
	const branch = [
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
	const data = createSidebarData(makeFakePi({}));
	try {
		data.subscribe(makeFakeCtx(branch));
		assert.equal(data.snapshot().todosTurnMarker, true);
		assert.deepEqual(data.snapshot().todos, [{ id: "1", text: "a", done: false }]);
	} finally {
		data.dispose();
	}
});

/** A fake pi that captures the `pi.on` handlers, so tests can fire session events. */
function makeCapturingPi(script: GitScript = {}): {
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
function markedBranch(): unknown[] {
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

test("a failed todo refresh clears the todos and the turn marker", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx(markedBranch()));
		assert.equal(data.snapshot().todosTurnMarker, true, "the marker is set before the failure");

		const throwingCtx = {
			...makeFakeCtx([]),
			sessionManager: {
				getBranch: () => {
					throw new Error("branch-boom");
				},
			},
		} as unknown as ExtensionContext;
		piHandlers.get("session_start")?.({}, throwingCtx);

		assert.deepEqual(data.snapshot().todos, [], "the failed refresh clears the list");
		assert.equal(data.snapshot().todosTurnMarker, false, "the failed refresh clears the marker");
	} finally {
		data.dispose();
	}
});

test("agent_end does not clear the turn marker", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx(markedBranch()));
		assert.equal(data.snapshot().todosTurnMarker, true);

		// An empty branch would clear the marker if agent_end refreshed the todos.
		piHandlers.get("agent_end")?.({}, makeFakeCtx([]));

		assert.equal(data.snapshot().todosTurnMarker, true, "the marker survives the end of the turn");
	} finally {
		data.dispose();
	}
});

// --- MCP usage counting ------------------------------------------------------

test("a root MCP tool start increments that server's count", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "mcp__context7__search" }, makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "mcp__context7__find" }, makeFakeCtx());
		assert.equal(data.snapshot().mcpUsage?.context7, 2);
	} finally {
		data.dispose();
	}
});

test("a repeated root MCP tool call id counts once", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		const start = { toolName: "mcp__context7__search", toolCallId: "call-1" };
		piHandlers.get("tool_execution_start")?.(start, makeFakeCtx());
		piHandlers.get("tool_execution_start")?.(start, makeFakeCtx());
		assert.equal(data.snapshot().mcpUsage?.context7, 1, "the duplicate start is ignored");
	} finally {
		data.dispose();
	}
});

test("a non-MCP tool start does not increment any count", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "read" }, makeFakeCtx());
		assert.deepEqual(data.snapshot().mcpUsage, {});
	} finally {
		data.dispose();
	}
});

test("an errored tool end does not change the MCP count", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "mcp__context7__search" }, makeFakeCtx());
		assert.equal(data.snapshot().mcpUsage?.context7, 1, "the count is set before the end");

		piHandlers.get("tool_execution_end")?.(
			{ toolName: "mcp__context7__search", error: "boom" },
			makeFakeCtx(),
		);
		assert.equal(data.snapshot().mcpUsage?.context7, 1, "a failed call stays counted");
	} finally {
		data.dispose();
	}
});

test("a new session resets the MCP usage counts", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "mcp__context7__search" }, makeFakeCtx());
		assert.equal(data.snapshot().mcpUsage?.context7, 1, "the count is set before the reset");

		piHandlers.get("session_start")?.({}, makeFakeCtx());
		assert.deepEqual(data.snapshot().mcpUsage, {}, "the new session starts at zero");
	} finally {
		data.dispose();
	}
});

test("a re-subscribe clears the MCP usage counts", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		piHandlers.get("tool_execution_start")?.({ toolName: "mcp__context7__search" }, makeFakeCtx());
		assert.equal(data.snapshot().mcpUsage?.context7, 1, "the count is set before the re-subscribe");

		data.subscribe(makeFakeCtx());
		assert.deepEqual(data.snapshot().mcpUsage, {}, "the re-subscribe starts at zero");
	} finally {
		data.dispose();
	}
});

/** Write a temp tree log that holds one finished subagent, and return its path. */
function writeFinishedSubagentLog(usage: Record<string, number>, clear: boolean): string {
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
function removeLog(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* the temp file may be gone */
	}
}

/** Restore the tree-log env after a test. */
function restoreTreeLogEnv(previous: string | undefined): void {
	if (previous === undefined) delete process.env[ENV_TREE_LOG];
	else process.env[ENV_TREE_LOG] = previous;
}

test("a clear after a finished subagent does not drop its MCP count", (t) => {
	const { pi } = makeCapturingPi();
	const data = createSidebarData(pi);
	const previous = process.env[ENV_TREE_LOG];
	delete process.env[ENV_TREE_LOG];
	const logPath = writeFinishedSubagentLog({ context7: 2 }, true);
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(makeFakeCtx());
		process.env[ENV_TREE_LOG] = logPath;
		t.mock.timers.tick(TREE_POLL_MS);
		assert.equal(findNode(data.snapshot().tree, "child"), undefined, "the clear prunes the finished child");
		assert.equal(data.snapshot().mcpUsage?.context7, 2, "the finished subagent stays counted");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		restoreTreeLogEnv(previous);
		removeLog(logPath);
	}
});

/** Write a temp log whose root start sits before the read window, then a clear. */
function writeOldRootStartLog(): string {
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

test("an old root start keeps a fresh child on its branch after a clear", (t) => {
	const { pi } = makeCapturingPi();
	const data = createSidebarData(pi);
	const previous = process.env[ENV_TREE_LOG];
	delete process.env[ENV_TREE_LOG];
	const logPath = writeOldRootStartLog();
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(makeFakeCtx());
		process.env[ENV_TREE_LOG] = logPath;
		t.mock.timers.tick(TREE_POLL_MS);

		const child = findNode(data.snapshot().tree, "child");
		assert.ok(child, "the fresh child is in the tree");
		assert.equal(child?.orphan, false, "the old root start keeps the child attached");

		const childLine = renderTreeLines(data.snapshot().tree, theme, 0).find((line) =>
			line.includes("implementer"),
		);
		assert.ok(childLine?.startsWith("└─ "), "the child line starts with the branch glyph");
		assert.notEqual(statusGlyph(theme, child, 0), "?", "the child icon is not the orphan mark");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		restoreTreeLogEnv(previous);
		removeLog(logPath);
	}
});

test("a session start stays at zero through a later tree refresh", (t) => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	const previous = process.env[ENV_TREE_LOG];
	delete process.env[ENV_TREE_LOG];
	const logPath = writeFinishedSubagentLog({ context7: 2 }, false);
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(makeFakeCtx());
		process.env[ENV_TREE_LOG] = logPath;
		piHandlers.get("session_start")?.({}, makeFakeCtx());
		assert.deepEqual(data.snapshot().mcpUsage, {}, "the reset is immediate");
		t.mock.timers.tick(TREE_POLL_MS);
		assert.deepEqual(data.snapshot().mcpUsage, {}, "the later refresh does not resurrect the count");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		restoreTreeLogEnv(previous);
		removeLog(logPath);
	}
});

// --- study status ------------------------------------------------------------

/** The project folder name for the fake context's `/repo` cwd. */
const NOTES_STUDIES = "agent-notes/project-notes/repo/studies";

/** A `status.md` body in the documented shape. */
function studyStatusFile(stage: string, updated: string): string {
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
function makeNotesHome(files: Record<string, string>): string {
	const home = mkdtempSync(join(tmpdir(), "study-notes-"));
	for (const [relative, body] of Object.entries(files)) {
		const full = join(home, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return home;
}

/** Run `fn` with `HOME` pointed at `home`, then restore the old value. */
function withHome<T>(home: string, fn: () => T): T {
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
async function readStatusPanel(
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
function studyNames(data: SidebarData): string[] {
	return (data.snapshot().status?.studies ?? []).map((row) => row.name);
}

test("an active study paints one row with its brief count and age", async () => {
	const files: Record<string, string> = {
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
		[`${NOTES_STUDIES}/2026-01-05-alpha/briefs/notes.txt`]: "not a brief",
	};
	for (const name of ["01-one.md", "02-two.md", "03-three.md", "04-four.md"]) {
		files[`${NOTES_STUDIES}/2026-01-05-alpha/briefs/${name}`] = "brief";
	}
	const home = makeNotesHome(files);
	try {
		const now = Date.parse("2026-01-05T00:00:00.000Z");
		const lines = await readStatusPanel({}, home, "/repo", now);
		assert.equal(lines[0], " STUDY STATUS");
		assert.equal(lines[1], "● alpha · 4 · 0s");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the panel lists every open study, newest updated first", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("active", "2026-01-01"),
		[`${NOTES_STUDIES}/2026-02-01-beta/status.md`]: studyStatusFile("done", "2026-02-01"),
		[`${NOTES_STUDIES}/2026-03-01-gamma/status.md`]: studyStatusFile("active", "2026-03-01"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-03-01T00:00:00.000Z"));
		assert.equal(lines[1], "● gamma · 0 · 0s");
		assert.equal(lines[2], "● alpha · 0 · 1416h00m");
		assert.equal(lines.length, 3, "the closed study paints no row");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("two blocked studies keep the updated order and the warning glyph", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("blocked", "2026-01-01"),
		[`${NOTES_STUDIES}/2026-03-01-gamma/status.md`]: studyStatusFile("blocked", "2026-03-01"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-03-01T00:00:00.000Z"));
		assert.equal(lines[1], "⚠ gamma · 0 · 0s");
		assert.equal(lines[2], "⚠ alpha · 0 · 1416h00m");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the archived studies folder is not listed", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("active", "2026-01-01"),
		[`${NOTES_STUDIES}/legacy_studies/2026-01-05-old/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-01T00:00:00.000Z"));
		assert.deepEqual(lines.slice(1), ["● alpha · 0 · 0s"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a pi without exec keeps the study row and marks git", () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	const data = createSidebarData(makeFakePi({ noExec: true }));
	try {
		withHome(home, () => data.subscribe(makeFakeCtx()));
		assert.deepEqual(studyNames(data), ["alpha"]);
		assert.deepEqual(data.snapshot().workspace.changed, ["(git unavailable)"]);
	} finally {
		data.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test("an empty notes tree paints the empty line", async () => {
	const home = makeNotesHome({ "agent-notes/.keep": "" });
	try {
		const lines = await readStatusPanel({}, home);
		assert.deepEqual(lines, [" STUDY STATUS", "no study tracked"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a status file without a stage paints the unknown glyph", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]:
			"# Alpha — Status\n\n- **Updated:** 2026-01-05\n- **Owner:** planner\n",
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-05T00:00:00.000Z"));
		assert.deepEqual(lines, [" STUDY STATUS", "? alpha · 0 · 0s"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a status file without an updated date prints the fallback age", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]:
			"# Alpha — Status\n\n- **Stage:** active\n- **Owner:** planner\n",
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-05T00:00:00.000Z"));
		assert.deepEqual(lines, [" STUDY STATUS", "● alpha · 0 · -"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a study folder with no status file paints no row", async () => {
	const home = makeNotesHome({ [`${NOTES_STUDIES}/2026-01-05-alpha/briefs/01-one.md`]: "brief" });
	try {
		const lines = await readStatusPanel({}, home);
		assert.deepEqual(lines, [" STUDY STATUS", "no study tracked"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a failed git read keeps the study rows", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	try {
		const lines = await readStatusPanel({ status: { code: 1, stdout: "" } }, home);
		assert.equal(lines[1]?.startsWith("● alpha · 0 · "), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the study reader reads only the home notes tree, not the cwd", async () => {
	const home = makeNotesHome({
		["agent-notes/project-notes/myrepo/studies/2026-01-05-alpha/status.md"]: studyStatusFile(
			"active",
			"2026-01-05",
		),
	});
	const cwdRoot = makeNotesHome({
		["myrepo/agent-notes/project-notes/myrepo/studies/2026-02-01-decoy/status.md"]: studyStatusFile(
			"active",
			"2026-02-01",
		),
	});
	try {
		const lines = await readStatusPanel({}, home, join(cwdRoot, "myrepo"));
		assert.equal(lines[1]?.startsWith("● alpha · 0 · "), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwdRoot, { recursive: true, force: true });
	}
});

test("the study poll picks up a new study", (t) => {
	const home = makeNotesHome({});
	const data = createSidebarData(makeFakePi({}));
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		withHome(home, () => {
			data.subscribe(makeFakeCtx());
			assert.deepEqual(studyNames(data), []);
			const studyDir = join(home, NOTES_STUDIES, "2026-03-01-beta");
			mkdirSync(studyDir, { recursive: true });
			writeFileSync(join(studyDir, "status.md"), studyStatusFile("blocked", "2026-03-01"));
			t.mock.timers.tick(STUDY_POLL_MS);
			assert.deepEqual(studyNames(data), ["beta"]);
			assert.equal(data.snapshot().status?.studies?.[0].stage, "blocked");
		});
	} finally {
		data.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a study that turns done mid-session keeps its row", (t) => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	const data = createSidebarData(makeFakePi({}));
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		withHome(home, () => {
			data.subscribe(makeFakeCtx());
			assert.deepEqual(studyNames(data), ["alpha"]);
			writeFileSync(
				join(home, NOTES_STUDIES, "2026-01-05-alpha", "status.md"),
				studyStatusFile("done", "2026-01-06"),
			);
			t.mock.timers.tick(STUDY_POLL_MS);
			assert.deepEqual(studyNames(data), ["alpha"], "the closed study keeps its row");
			assert.equal(data.snapshot().status?.studies?.[0].stage, "done");
		});
	} finally {
		data.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a restart drops a study that is already done", () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("done", "2026-01-06"),
	});
	const data = createSidebarData(makeFakePi({}));
	try {
		withHome(home, () => data.subscribe(makeFakeCtx()));
		assert.deepEqual(studyNames(data), [], "a fresh process state starts empty");
	} finally {
		data.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});
