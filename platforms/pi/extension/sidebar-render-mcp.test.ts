/**
 * Offline tests for MCP usage counting and the MCP sidebar rows.
 *
 * Runs under plain Node (type stripping). The MCP counter helpers and the MCP
 * panel tests live together here rather than in `sidebar-render.test.ts`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type McpSnapshot,
	type SidebarSnapshot,
	type SidebarTheme,
	renderMcpPanel,
	treeSignature,
} from "./sidebar-render.ts";
import {
	countMcpTool,
	createMcpTally,
	createSubagentMcpCounter,
	incrementMcpCount,
	lookupMcpCount,
	mergeMcpUsage,
	parseMcpServerName,
	totalMcpCount,
} from "./mcp-usage.ts";
import type { RunEvent } from "./tree-log.ts";

const theme: SidebarTheme = {
	bold: (text) => text,
	dim: (text) => text,
	fg: (_color, text) => text,
};

/** Lines are right-padded to the column width; trim for content checks. */
function content(lines: string[]): string[] {
	return lines.map((line) => line.trimEnd());
}

/** A minimal valid snapshot, so `treeSignature` accepts it. */
function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		cwd: "/repo",
		tree: [],
		session: {
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
		},
		workspace: { cwd: "/repo", branch: null, changed: [], changedCount: 0, files: [] },
		mcp: [],
		todos: [],
		tps: 0,
		...overrides,
	};
}

// --- counter parse and increment -------------------------------------------

test("parseMcpServerName reads the server from an mcp tool name", () => {
	assert.equal(parseMcpServerName("mcp__context7__search"), "context7");
});

test("parseMcpServerName returns null for a non-MCP name", () => {
	assert.equal(parseMcpServerName("bash"), null);
	assert.equal(parseMcpServerName(undefined), null);
});

test("countMcpTool increments a root MCP tool start", () => {
	const counts = countMcpTool({}, "mcp__context7__search");
	assert.deepEqual(counts, { context7: 1 });
});

test("countMcpTool increments a child MCP tool start and accumulates", () => {
	let counts = countMcpTool({}, "mcp__exa__search");
	counts = countMcpTool(counts, "mcp__exa__find");
	counts = countMcpTool(counts, "mcp__context7__search");
	assert.deepEqual(counts, { exa: 2, context7: 1 });
});

test("countMcpTool ignores a non-MCP tool and returns the same record", () => {
	const counts = { context7: 1 };
	assert.equal(countMcpTool(counts, "read"), counts);
});

test("createSubagentMcpCounter counts one start and ignores a repeated call id", () => {
	const counter = createSubagentMcpCounter();
	counter.count({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp__exa__search" });
	counter.count({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp__exa__search" });
	assert.deepEqual(counter.usage(), { exa: 1 });
});

test("createSubagentMcpCounter ignores a non-start event and a non-MCP tool", () => {
	const counter = createSubagentMcpCounter();
	counter.count({ type: "message_end", toolCallId: "m1", toolName: "mcp__exa__x" });
	counter.count({ type: "tool_execution_start", toolCallId: "m2", toolName: "read" });
	assert.deepEqual(counter.usage(), {});
});

test("mergeMcpUsage adds two maps and never mutates the input", () => {
	const root = { context7: 1 };
	const merged = mergeMcpUsage(root, { context7: 2, exa: 1 });
	assert.deepEqual(merged, { context7: 3, exa: 1 });
	assert.deepEqual(root, { context7: 1 });
});

test("incrementMcpCount never mutates the input record", () => {
	const counts = { a: 1 };
	const next = incrementMcpCount(counts, "a");
	assert.deepEqual(counts, { a: 1 });
	assert.deepEqual(next, { a: 2 });
});

test("lookupMcpCount matches the sanitized server name", () => {
	assert.equal(lookupMcpCount({ my_server: 3 }, "my-server"), 3);
});

test("totalMcpCount sums every server", () => {
	assert.equal(totalMcpCount({ a: 1, b: 2, c: 4 }), 7);
});

// --- ambiguous and near-miss tool names ------------------------------------

test("parseMcpServerName returns null when the server segment is missing or empty", () => {
	for (const name of ["mcp__", "mcp__x", "mcp_tool", "mcp____tool", "Mcp__a__b"]) {
		assert.equal(parseMcpServerName(name), null, name);
	}
});

test("parseMcpServerName keeps an underscore inside the server name", () => {
	assert.equal(parseMcpServerName("mcp__my_server__lookup"), "my_server");
});

test("countMcpTool ignores an mcp-like name with no server segment", () => {
	const counts = { context7: 1 };
	for (const name of ["mcp__", "mcp__x", "mcp_tool", "mcp____tool"]) {
		assert.equal(countMcpTool(counts, name), counts, name);
	}
});

test("the subagent counter dedupes a call id even when the tool name changes", () => {
	const counter = createSubagentMcpCounter();
	counter.count({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp__exa__search" });
	counter.count({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp__context7__search" });
	assert.deepEqual(counter.usage(), { exa: 1 });
});

test("the subagent counter counts every start that has no call id", () => {
	const counter = createSubagentMcpCounter();
	counter.count({ type: "tool_execution_start", toolName: "mcp__exa__search" });
	counter.count({ type: "tool_execution_start", toolName: "mcp__exa__find" });
	assert.deepEqual(counter.usage(), { exa: 2 });
});

test("the subagent counter keeps a count after a failed tool end", () => {
	const counter = createSubagentMcpCounter();
	counter.count({ type: "tool_execution_start", toolCallId: "call-1", toolName: "mcp__exa__search" });
	counter.count({ type: "tool_execution_end", toolCallId: "call-1", toolName: "mcp__exa__search", error: "boom" });
	assert.deepEqual(counter.usage(), { exa: 1 });
});

// --- MCP badge and total ----------------------------------------------------

test("an MCP server row shows an x-prefixed usage badge", () => {
	const mcp: McpSnapshot = [
		{ name: "context7", configured: true, connected: true, status: "connected" },
	];
	const lines = content(renderMcpPanel(mcp, 60, theme, { context7: 12 }));
	assert.ok(lines.some((line) => line.includes("● context7 x12")));
});

test("an MCP server row shows x0 when it has no usage", () => {
	const mcp: McpSnapshot = [
		{ name: "exa", configured: true, connected: false, status: "disconnected" },
	];
	const lines = content(renderMcpPanel(mcp, 60, theme, {}));
	assert.ok(lines.some((line) => line.includes("○ exa x0")));
});

test("the MCP total sums every server, including rows beyond the visible cap", () => {
	const mcp: McpSnapshot = Array.from({ length: 5 }, (_, index) => ({
		name: `s${index}`,
		configured: true,
		connected: true,
		status: "connected" as const,
	}));
	const usage = { s0: 1, s1: 2, s2: 3, s3: 4, s4: 5 };

	const lines = content(renderMcpPanel(mcp, 60, theme, usage));

	assert.equal(lines.filter((line) => line.includes("● s")).length, 4, "only four server rows show");
	assert.ok(lines.includes("… +1 more"));
	assert.ok(lines.includes("total x15"));
});

test("the MCP total row fits the column width", () => {
	const mcp: McpSnapshot = [{ name: "context7", configured: true, connected: true, status: "connected" }];
	const lines = renderMcpPanel(mcp, 20, theme, { context7: 12345 });
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 20, `line exceeds 20: ${JSON.stringify(line)}`);
	}
});

test("a long server name and a large count clip cleanly to a narrow width", () => {
	const name = "a-very-long-server-name-that-will-not-fit";
	const mcp: McpSnapshot = [{ name, configured: true, connected: true, status: "connected" }];
	const width = 24;
	const lines = renderMcpPanel(mcp, width, theme, { [name]: 123456789 });

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
	}
	const row = lines.find((line) => line.includes("a-very-long"));
	assert.ok(row, "the row keeps the start of the server name");
	assert.ok(row.includes("…"), "the row clips with an ellipsis");
});

test("the total counts usage that belongs only to hidden servers", () => {
	const mcp: McpSnapshot = Array.from({ length: 6 }, (_, index) => ({
		name: `s${index}`,
		configured: true,
		connected: true,
		status: "connected" as const,
	}));
	const lines = content(renderMcpPanel(mcp, 60, theme, { s4: 7, s5: 2 }));

	assert.equal(lines.filter((line) => line.includes("● s")).length, 4, "only four server rows show");
	assert.ok(lines.includes("… +2 more"));
	assert.ok(lines.includes("total x9"));
	assert.ok(!lines.some((line) => line.includes("● s4") || line.includes("● s5")));
});

test("the total includes usage for a server with no configured row", () => {
	const mcp: McpSnapshot = [{ name: "exa", configured: true, connected: true, status: "connected" }];
	const lines = content(renderMcpPanel(mcp, 60, theme, { exa: 1, orphan: 4 }));
	assert.ok(lines.includes("total x5"));
});

test("the total shows for an empty server list when a usage map is supplied", () => {
	const lines = content(renderMcpPanel([], 60, theme, { ghost: 3 }));
	assert.ok(lines.includes("(no servers)"));
	assert.ok(lines.includes("total x3"));
});

// --- repaint signature ------------------------------------------------------

test("treeSignature changes when the MCP usage map changes", () => {
	const before = treeSignature(snapshot({ mcpUsage: { context7: 1 } }));
	const after = treeSignature(snapshot({ mcpUsage: { context7: 2 } }));
	assert.notEqual(before, after);
});

// --- nested depth -----------------------------------------------------------

test("the session tally includes a depth-2 subagent run", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const events: RunEvent[] = [
		{ v: 1, type: "start", runId: "root", parentRunId: null, depth: 0, agent: "orchestrator", persona: null, status: "idle", at },
		{ v: 1, type: "start", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "running", at },
		{ v: 1, type: "update", runId: "child", parentRunId: "root", depth: 1, agent: "implementer", persona: null, status: "running", at, mcpUsage: { context7: 2 } },
		{ v: 1, type: "start", runId: "grand", parentRunId: "child", depth: 2, agent: "implementer", persona: null, status: "running", at },
		{ v: 1, type: "end", runId: "grand", parentRunId: "child", depth: 2, agent: "implementer", persona: null, status: "done", at, mcpUsage: { exa: 3 } },
	];
	const tally = createMcpTally();
	for (const event of events) tally.observe(event.runId, event.mcpUsage);
	assert.deepEqual(tally.usage(), { context7: 2, exa: 3 });
});

test("the session tally adds each run's delta once across repeated polls", () => {
	const tally = createMcpTally();
	tally.observe("child", { context7: 1 });
	tally.observe("child", { context7: 1 });
	tally.observe("child", { context7: 3 });
	assert.deepEqual(tally.usage(), { context7: 3 });
});

test("a session reset zeroes the total but keeps counted runs from re-adding", () => {
	const tally = createMcpTally();
	tally.observe("child", { context7: 2 });
	tally.reset();
	assert.deepEqual(tally.usage(), {});
	tally.observe("child", { context7: 2 });
	assert.deepEqual(tally.usage(), {}, "a seen run does not re-add after a reset");
	tally.observe("child", { context7: 5 });
	assert.deepEqual(tally.usage(), { context7: 3 }, "only the post-reset delta counts");
});

test("a reset followed by a new run counts only the new run", () => {
	const tally = createMcpTally();
	tally.observe("old", { context7: 3 });
	tally.reset();
	tally.observe("new", { context7: 2 });
	assert.deepEqual(tally.usage(), { context7: 2 });
});
