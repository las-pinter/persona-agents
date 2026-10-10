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
 * Run: npm test -- agent-stack/sidebar-data.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSidebarData } from "./sidebar-data.ts";
import { TODOS_EVENT_CHANNEL, TODOS_TURN_ENTRY } from "./todo-tool.ts";
import type { McpSnapshot, SessionSnapshot, WorkspaceFileSnapshot } from "./sidebar-render.ts";

/** A scripted response for the two git calls the collector makes. */
interface GitScript {
	status?: { code?: number; stdout?: string };
	numstat?: { code?: number; stdout?: string };
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
			return execResult(0, "");
		},
		on: noopUnsub,
		events: { on: noopUnsub, emit: () => {} },
		getMcpServers: () => (script.mcpServers ?? []).map((name) => ({ name })),
	};
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
function makeFakeCtx(branch: unknown[] = []): ExtensionContext {
	const ctx = {
		cwd: "/repo",
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
function makeCapturingPi(): {
	pi: ExtensionAPI;
	piHandlers: Map<string, (event: unknown, ctx: unknown) => void>;
} {
	const piHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const base = makeFakePi({}) as unknown as Record<string, unknown>;
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
