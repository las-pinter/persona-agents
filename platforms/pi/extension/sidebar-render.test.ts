/**
 * Offline regression harness for the pure sidebar panel renderers.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-render.test.ts
 *
 * Covers the tree, session, workspace, MCP, and todos panel renderers.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	type McpSnapshot,
	type SidebarTheme,
	type TodoSnapshot,
	CONTEXT_BAR_CELLS,
	SESSION_LABEL_WIDTH,
	contextBar,
	contextBarColor,
	formatCount,
	formatElapsed,
	hasRunningNode,
	renderAgentTreePanel,
	renderMcpPanel,
	renderNodeDetail,
	renderSessionPanel,
	renderTodosPanel,
	renderTreeLines,
	renderWorkspacePanel,
	shortenHome,
} from "./sidebar-render.ts";
import {
	assertFits,
	content,
	makeNode,
	makeSession,
	makeWorkspace,
	theme,
} from "./sidebar-render-fixtures.ts";

// --- AGENTS (tree) -----------------------------------------------------------

test("zero nodes renders the AGENTS placeholder", () => {
	const lines = renderAgentTreePanel([], 40, 5, theme, 0);
	assert.ok(lines[0]?.startsWith(" AGENTS "));
	assert.ok(lines.some((line) => line.includes("(no active agents)")));
});

test("each node status renders its own glyph on the first node line", () => {
	const cases: Array<[string, Partial<Parameters<typeof makeNode>[0]>, string]> = [
		["done", { status: "done" }, "✓"],
		["running", { status: "running" }, "⠋"],
		["idle", { status: "idle" }, "○"],
		["failed", { status: "failed" }, "✗"],
		["stale", { status: "stale" }, "⚠"],
		["orphan", { status: "running", orphan: true }, "?"],
	];
	for (const [label, overrides, glyph] of cases) {
		const node = makeNode({ runId: "n1", agent: "planner", ...overrides });
		const lines = renderAgentTreePanel([node], 40, 5, theme, 0);
		assert.ok(lines.length >= 2, label);
		assert.ok(lines[1]?.includes(glyph), `${label} shows ${glyph}`);
		assert.ok(lines[1]?.includes("planner"), `${label} shows the agent name`);
	}
	const idle = renderAgentTreePanel([makeNode({ runId: "n1", status: "idle" })], 40, 5, theme, 0)[1];
	assert.ok(!idle?.includes("⠋"), "an idle node does not spin");
});

test("branch connectors nest with depth and mark the last child", () => {
	const grandchild = makeNode({ runId: "c2", parentRunId: "c1", depth: 2, agent: "researcher" });
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester", children: [grandchild] });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });

	const lines = renderTreeLines([root], theme, 0);
	assert.ok(lines[0]?.startsWith("⠋"), "the root has no connector");
	assert.ok(lines[1]?.startsWith("└─ "), "a single child draws the last-child glyph");
	assert.ok(lines[2]?.startsWith("   └─ "), "a grandchild aligns under its parent");
});

test("sibling connectors mark the last child and keep the vertical spine", () => {
	const first = makeNode({ runId: "a", parentRunId: "root", depth: 1, agent: "alpha" });
	const grandchild = makeNode({ runId: "a1", parentRunId: "a", depth: 2, agent: "deep" });
	first.children = [grandchild];
	const last = makeNode({ runId: "b", parentRunId: "root", depth: 1, agent: "beta" });
	const root = makeNode({ runId: "root", depth: 0, children: [first, last] });

	const lines = renderTreeLines([root], theme, 0);
	assert.ok(lines[1]?.startsWith("├─ "), "the first of two children gets the tee");
	assert.ok(lines[2]?.startsWith("│  "), "a middle branch keeps the vertical spine");
	assert.ok(lines[3]?.startsWith("└─ "), "the last child gets the corner");
});

test("the root node is the first node line", () => {
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester" });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });
	const lines = renderTreeLines([root], theme, 0);
	assert.ok(lines[0]?.includes("orchestrator"));
	assert.ok(lines[1]?.includes("tester"));
});

test("a top-level orphan with depth draws no connector", () => {
	const orphan = makeNode({ runId: "lost", parentRunId: "ghost", depth: 1, orphan: true, agent: "tester" });
	const lines = renderTreeLines([orphan], theme, 0);
	assert.ok(lines[0]?.startsWith("? "), "the orphan glyph starts the line");
	assert.ok(!lines[0]?.includes("─"), "no branch glyph is drawn");
});

test("a tree taller than the budget prints a more marker", () => {
	const nodes = Array.from({ length: 6 }, (_value, index) =>
		makeNode({ runId: `n${index}`, agent: `agent${index}` }),
	);
	const lines = renderAgentTreePanel(nodes, 40, 3, theme, 0);
	assert.equal(lines.length, 3);
	assert.ok(lines[2]?.includes("… +5 more"));
});

test("renderNodeDetail maps a node to its output preview", () => {
	const node = makeNode({
		runId: "n1",
		agent: "implementer",
		status: "done",
		exitCode: 0,
		outputPreview: "hello from the child",
	});
	const lines = renderNodeDetail(node, 60, theme);
	assert.ok(lines.some((line) => line.includes("hello from the child")));
	assert.ok(lines.some((line) => line.includes("exit: 0")));
});

test("renderNodeDetail reports a missing usage", () => {
	const lines = renderNodeDetail(makeNode({ runId: "n1" }), 60, theme);
	assert.ok(lines.some((line) => line.includes("usage: n/a")));
});

// --- SESSION -----------------------------------------------------------------

test("a full session renders the model, context bar, and aligned stats", () => {
	const lines = content(renderSessionPanel(makeSession(), 60, theme));
	assert.equal(lines[0]?.trimEnd(), " SESSION");
	assert.equal(lines[1], "model".padEnd(SESSION_LABEL_WIDTH) + "test-model");
	assert.equal(lines[2], "thinking".padEnd(SESSION_LABEL_WIDTH) + "medium");
	assert.equal(lines[3], "ctx".padEnd(SESSION_LABEL_WIDTH) + contextBar(50) + "  50% (1.0k/2.0k)");
	assert.equal(lines[4], "tokens".padEnd(SESSION_LABEL_WIDTH) + "0 / 0");
	assert.equal(lines[5], "cost".padEnd(SESSION_LABEL_WIDTH) + "$0.12");
	assert.equal(lines[6], "turns".padEnd(SESSION_LABEL_WIDTH) + "0");
	assert.equal(lines[7], "tok/s".padEnd(SESSION_LABEL_WIDTH) + "12.3");
	assert.equal(lines[8], "elapsed".padEnd(SESSION_LABEL_WIDTH) + "-");
});

test("every SESSION value starts at the same column", () => {
	const lines = content(
		renderSessionPanel(
			makeSession({ tokensIn: 1500, tokensOut: 2300, turns: 7, cost: 0.5, tps: 9.9 }),
			60,
			theme,
		),
	);
	const rows: Array<[string, string]> = [
		["model", "test-model"],
		["thinking", "medium"],
		["tokens", "1.5k / 2.3k"],
		["cost", "$0.50"],
		["turns", "7"],
		["tok/s", "9.9"],
	];
	for (const [label, value] of rows) {
		const line = lines.find((candidate) => candidate.startsWith(label));
		assert.ok(line, `missing ${label} row`);
		assert.equal(line, label.padEnd(SESSION_LABEL_WIDTH) + value);
		assert.equal(line?.indexOf(value), SESSION_LABEL_WIDTH, `${label} value is not aligned`);
	}
	assertFits(renderSessionPanel(makeSession(), 8, theme), 8);
});

test("a tiny cost keeps four decimals so it does not read as zero", () => {
	const lines = content(renderSessionPanel(makeSession({ cost: 0.0012 }), 60, theme));
	assert.ok(lines.includes("cost".padEnd(SESSION_LABEL_WIDTH) + "$0.0012"));
	assert.ok(!lines.includes("cost".padEnd(SESSION_LABEL_WIDTH) + "$0.00"));
});

test("a null context renders ctx n/a and does not throw", () => {
	const lines = content(
		renderSessionPanel(
			makeSession({ contextTokens: null, contextWindow: null, contextPercent: null }),
			60,
			theme,
		),
	);
	assert.ok(lines.includes("ctx".padEnd(SESSION_LABEL_WIDTH) + "n/a"));
});

test("an entirely missing session renders n/a and does not throw", () => {
	const lines = content(renderSessionPanel(null, 60, theme));
	assert.ok(lines.includes("ctx".padEnd(SESSION_LABEL_WIDTH) + "n/a"));
	assert.ok(lines.includes("cost".padEnd(SESSION_LABEL_WIDTH) + "-"));
});

// --- context fill bar --------------------------------------------------------

test("contextBar fills the fixed cell count", () => {
	assert.equal(contextBar(0, 10), "░".repeat(10));
	assert.equal(contextBar(100, 10), "█".repeat(10));
	assert.equal(contextBar(50, 10), "█".repeat(5) + "░".repeat(5));
	assert.equal(contextBar(150, 10), "█".repeat(10));
	assert.equal(contextBar(-5, 10), "░".repeat(10));
	assert.equal(contextBar(50, 4), "██░░");
	assert.equal(contextBar(100).length, CONTEXT_BAR_CELLS);
});

test("contextBarColor uses the low, mid, and alarm thresholds", () => {
	assert.equal(contextBarColor(0), "success");
	assert.equal(contextBarColor(49), "success");
	assert.equal(contextBarColor(50), "warning");
	assert.equal(contextBarColor(80), "warning");
	assert.equal(contextBarColor(81), "error");
	assert.equal(contextBarColor(100), "error");
});

test("the session panel colors the context bar with the alarm token above 80 percent", () => {
	const calls: string[] = [];
	const recording: SidebarTheme = {
		fg: (name, text) => {
			calls.push(name);
			return text;
		},
	};
	renderSessionPanel(makeSession({ contextTokens: 1900, contextWindow: 2000 }), 80, recording);
	assert.ok(calls.includes("error"));
});

test("the session context bar clips at width 0 and 1", () => {
	for (const width of [0, 1]) assertFits(renderSessionPanel(makeSession(), width, theme), width);
});

// --- rich agent lines --------------------------------------------------------

test("a rich agent line shows name, elapsed, tokens, turns, and tools", () => {
	const node = makeNode({
		runId: "n1",
		agent: "implementer",
		status: "done",
		startedAt: "2026-10-07T00:00:00.000Z",
		endedAt: "2026-10-07T00:01:05.000Z",
		usage: { input: 1000, output: 500, cost: 0.1, turns: 7 },
		toolCount: 3,
	});
	const line = renderTreeLines([node], theme, 0, Date.parse("2026-10-07T00:01:05.000Z"))[0];
	assert.ok(line?.includes("implementer"));
	assert.ok(line?.includes("1m05s"));
	assert.ok(line?.includes("1.5k"));
	assert.ok(line?.includes("7t"));
	assert.ok(line?.includes("3⚒"));
});

test("missing agent metrics render placeholders", () => {
	const node = makeNode({
		runId: "n1",
		agent: "tester",
		status: "idle",
		startedAt: "not-a-date",
		endedAt: null,
	});
	const line = renderTreeLines([node], theme, 0, 0)[0];
	assert.ok(line?.includes("tester"));
	assert.ok(line?.includes("- - -"));
	assert.ok(line?.includes("0⚒"));
});

test("a rich agent line stays readable and fits width 45", () => {
	const node = makeNode({
		runId: "n1",
		agent: "orchestrator",
		startedAt: "2026-10-07T00:00:00.000Z",
		endedAt: "2026-10-07T00:01:05.000Z",
		usage: { input: 12000, output: 3000, cost: 0.5, turns: 12 },
		toolCount: 42,
		task: "a very long task preview",
	});
	const lines = renderAgentTreePanel(
		[node],
		45,
		6,
		theme,
		0,
		Date.parse("2026-10-07T00:01:05.000Z"),
	);
	assertFits(lines, 45);
	assert.ok(lines[1]?.includes("orchestrator"));
});

// --- format helpers ----------------------------------------------------------

test("formatCount compacts large values and rejects non-finite input", () => {
	assert.equal(formatCount(0), "0");
	assert.equal(formatCount(999), "999");
	assert.equal(formatCount(1500), "1.5k");
	assert.equal(formatCount(1_250_000), "1.3M");
	assert.equal(formatCount(Number.NaN), "-");
});

test("formatElapsed compacts seconds, minutes, and hours", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(65_000), "1m05s");
	assert.equal(formatElapsed(3_600_000), "1h00m");
	assert.equal(formatElapsed(null), "-");
	assert.equal(formatElapsed(-1), "-");
});

// --- colored status glyphs ---------------------------------------------------

// --- WORKSPACE ---------------------------------------------------------------

test("the branch renders with a branch glyph and clean marker", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace({ branch: "dev" }), 60, theme));
	assert.equal(lines[0]?.trimEnd(), " WORKSPACE");
	assert.ok(lines.includes("⎇ dev (clean)"));
});

test("a null branch renders (not a repo)", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace({ branch: null }), 60, theme));
	assert.ok(lines.some((line) => line.includes("(not a repo)")));
});

test("no changes renders (clean)", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace(), 60, theme));
	assert.ok(lines.some((line) => line.includes("(clean)")));
});

test("workspace file lines show right-aligned diff stats and untracked mark", () => {
	const lines = content(
		renderWorkspacePanel(
			makeWorkspace({
				cwd: "/home/dev/persona-agents",
				files: [
					{ path: "agent-stack/sidebar-render.ts", added: 12, removed: 3, untracked: false },
					{ path: "new-file.ts", added: 0, removed: 0, untracked: true },
				],
				changed: ["agent-stack/sidebar-render.ts", "new-file.ts"],
				changedCount: 2,
			}),
			60,
			theme,
		),
	);
	assert.ok(lines.some((line) => line.includes("+12 -3")));
	assert.ok(lines.some((line) => line.includes("? new-file.ts")));
	assert.ok(lines.some((line) => line.trim().endsWith("?")));
	assert.ok(lines.includes("~/persona-agents"));
});

test("workspace shortens a home cwd to ~", () => {
	assert.equal(shortenHome("/home/dev", "/home/dev"), "~");
	assert.equal(shortenHome("/home/dev/x/y", "/home/dev"), "~/x/y");
	assert.equal(shortenHome("/home/dev/x", undefined), "~/x");
	assert.equal(shortenHome("/tmp/other"), "/tmp/other");
});

test("a long changed list clips with a more marker", () => {
	const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map((path) => ({
		path,
		added: 1,
		removed: 0,
		untracked: false,
	}));
	const lines = content(
		renderWorkspacePanel(
			makeWorkspace({ files, changed: files.map((file) => file.path), changedCount: 6 }),
			60,
			theme,
		),
	);
	assert.ok(lines.some((line) => line.includes("6 changed")));
	assert.ok(lines.some((line) => line.includes("… +2 more")));
});

// --- MCP ---------------------------------------------------------------------

test("MCP renders a configured/connected summary and server dots", () => {
	const mcp: McpSnapshot = [
		{ name: "context7", configured: true, connected: true, status: "connected" },
		{ name: "exa", configured: true, connected: false, status: "disconnected" },
	];
	const lines = content(renderMcpPanel(mcp, 60, theme));
	assert.equal(lines[0]?.trimEnd(), " MCP");
	assert.ok(lines.includes("configured: 2, connected: 1"));
	assert.ok(lines.some((line) => line.includes("● context7")));
	assert.ok(lines.some((line) => line.includes("○ exa")));
});

test("MCP summary counts the status, not the connected flag", () => {
	const mcp: McpSnapshot = [
		{ name: "a", configured: true, connected: false, status: "connected" },
		{ name: "b", configured: true, connected: false, status: "connected" },
		{ name: "c", configured: true, connected: true, status: "disconnected" },
	];
	const lines = content(renderMcpPanel(mcp, 60, theme));
	// Status-derived count is 2; the flag-derived count is 1.
	assert.ok(lines.includes("configured: 3, connected: 2"));
});

test("MCP dots stay plain text when the theme has no colors", () => {
	const mcp: McpSnapshot = [
		{ name: "a", configured: true, connected: true, status: "connected" },
		{ name: "b", configured: true, connected: false, status: "unknown" },
	];
	const lines = content(renderMcpPanel(mcp, 60, {}));
	assert.ok(lines.some((line) => line.includes("● a")));
	assert.ok(lines.some((line) => line.includes("◐ b")));
});

test("an empty MCP list renders (no servers)", () => {
	const lines = content(renderMcpPanel([], 60, theme));
	assert.ok(lines.includes("(no servers)"));
});

// --- TODOS -------------------------------------------------------------------

test("TODOS renders a progress line and checkbox lines", () => {
	const todos: TodoSnapshot = [
		{ id: "1", text: "write code", done: true },
		{ id: "2", text: "write tests", done: false },
	];
	const lines = content(renderTodosPanel(todos, 60, 8, theme));
	assert.equal(lines[0]?.trimEnd(), " TODOS");
	assert.ok(lines.includes("1/2"));
	assert.ok(lines.some((line) => line.includes("✓ write code")));
	assert.ok(lines.some((line) => line.includes("○ write tests")));
});

test("an empty TODOS list renders (no todos)", () => {
	const lines = content(renderTodosPanel([], 60, 8, theme));
	assert.ok(lines.includes("(no todos)"));
});

test("a long todo list clips with a more marker", () => {
	const todos: TodoSnapshot = Array.from({ length: 6 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: false,
	}));
	const lines = renderTodosPanel(todos, 60, 4, theme);
	assert.ok(lines.some((line) => line.includes("… +5 more")));
});

test("six todos at height 12 show all six without an overflow line", () => {
	const todos: TodoSnapshot = Array.from({ length: 6 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: false,
	}));
	const lines = content(renderTodosPanel(todos, 60, 12, theme));
	assert.equal(lines.length, 8, "header, summary, and six item lines");
	assert.ok(lines.some((line) => line.includes("todo 5")));
	assert.ok(!lines.some((line) => line.includes("more")));
});

test("the turn marker renders when requested", () => {
	const lines = content(
		renderTodosPanel([{ id: "1", text: "open", done: false }], 60, 8, theme, true),
	);
	assert.ok(lines.some((line) => line.includes("— new turn —")));
});

test("no turn marker renders when it is false", () => {
	const lines = content(
		renderTodosPanel([{ id: "1", text: "open", done: false }], 60, 8, theme),
	);
	assert.ok(!lines.some((line) => line.includes("— new turn —")));
});

test("all done todos render the all-done cue", () => {
	const lines = content(
		renderTodosPanel(
			[
				{ id: "1", text: "a", done: true },
				{ id: "2", text: "b", done: true },
			],
			60,
			8,
			theme,
		),
	);
	assert.ok(lines.some((line) => line.includes("✓ all done")));
});

test("the all-done cue survives an item overflow", () => {
	const todos: TodoSnapshot = Array.from({ length: 4 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: true,
	}));
	const lines = content(renderTodosPanel(todos, 60, 4, theme));

	assert.ok(lines.some((line) => line.includes("✓ all done")));
	assert.ok(lines.some((line) => line.includes("… +4 more")));
});

test("an empty list still shows the turn marker", () => {
	const lines = content(renderTodosPanel([], 60, 8, theme, true));

	assert.ok(lines.some((line) => line.includes("(no todos)")));
	assert.ok(lines.some((line) => line.includes("— new turn —")));
});

test("an empty list keeps the turn marker at a tight height", () => {
	const lines = content(renderTodosPanel([], 60, 2, theme, true));

	assert.equal(lines.length, 2, "header and marker only");
	assert.ok(lines.some((line) => line.includes("— new turn —")));
	assert.ok(!lines.some((line) => line.includes("(no todos)")));
});

test("height 0 renders no lines and height 1 renders only the header", () => {
	assert.deepEqual(renderTodosPanel([{ id: "1", text: "a", done: false }], 60, 0, theme), []);
	const headerOnly = content(
		renderTodosPanel([{ id: "1", text: "a", done: false }], 60, 1, theme),
	);
	assert.deepEqual(headerOnly, [" TODOS"]);
});

test("the turn marker and all-done cue clip to a narrow width", () => {
	for (const width of [0, 1, 5]) {
		const lines = renderTodosPanel([{ id: "1", text: "a", done: true }], width, 8, theme, true);
		assertFits(lines, width);
	}
});

test("hasRunningNode is false when no node runs", () => {
	assert.equal(hasRunningNode([]), false);
	assert.equal(hasRunningNode([makeNode({ runId: "i", status: "idle" })]), false);
	assert.equal(hasRunningNode([makeNode({ runId: "d", status: "done" })]), false);
	assert.equal(hasRunningNode([makeNode({ runId: "f", status: "failed" })]), false);
	assert.equal(hasRunningNode([makeNode({ runId: "s", status: "stale" })]), false);
});

test("hasRunningNode is true for a running node, including a descendant", () => {
	assert.equal(hasRunningNode([makeNode({ runId: "r", status: "running" })]), true);
	const child = makeNode({ runId: "c", status: "running", depth: 1 });
	const root = makeNode({ runId: "root", status: "idle", children: [child] });
	assert.equal(hasRunningNode([root]), true);
});
