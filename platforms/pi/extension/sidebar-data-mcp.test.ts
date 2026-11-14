/**
 * Sidebar data tests for the MCP server state: the connected mark from a tool
 * name, one `mcp.json` read per refresh, and the per-server call count.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data-mcp.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { ENV_TREE_LOG } from "./depth.ts";
import { MCP_POLL_MS, TREE_POLL_MS, createSidebarData } from "./sidebar-data.ts";
import {
	makeCapturingPi,
	makeFakeCtx,
	makeFakePi,
	readMcp,
	removeLog,
	restoreTreeLogEnv,
	writeFinishedSubagentLog,
	writeOldRootStartLog,
} from "./sidebar-data-fixtures.ts";
import { theme } from "./sidebar-render-fixtures.ts";
import { renderTreeLines } from "./sidebar-render.ts";
import { stateGlyph } from "./sidebar-theme.ts";
import { findNode } from "./tree-model.ts";

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

test("one mcp.json read serves one MCP refresh", (t) => {
	const original = fs.readFileSync;
	let reads = 0;
	fs.readFileSync = ((...args: unknown[]) => {
		if (String(args[0]).endsWith("mcp.json")) reads += 1;
		return (original as unknown as (...rest: unknown[]) => unknown)(...args);
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	const data = createSidebarData(makeFakePi({}));
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(makeFakeCtx());
		assert.equal(reads, 1, "the first paint read mcp.json more than once");
		t.mock.timers.tick(MCP_POLL_MS);
		assert.equal(reads, 2, "one MCP poll read mcp.json more than once");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		fs.readFileSync = original;
		syncBuiltinESMExports();
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
		assert.notEqual(stateGlyph(theme, child.status, 0), "?", "the child icon is not the orphan mark");
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
