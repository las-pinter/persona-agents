/**
 * Offline regression harness for the pure sidebar panel renderers.
 *
 * Runs under plain Node (type stripping):
 *   npm run test:permissions -- agent-stack/sidebar-render.test.ts
 *
 * Covers the plan's Task 19 sidebar-render cases: tree, session, workspace,
 * MCP, todos, width fitting, and selection wrap.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type McpSnapshot,
	type SessionSnapshot,
	type SidebarSnapshot,
	type SidebarTheme,
	type TodoSnapshot,
	type WorkspaceSnapshot,
	AGENTS_PAD_MIN,
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
	renderSidebarPanel,
	renderTodosPanel,
	renderTreeLines,
	renderWorkspacePanel,
	selectNext,
	selectPrev,
	shortenHome,
	statusGlyph,
	statusIcon,
	treeSignature,
} from "./sidebar-render.ts";
import type { TreeNode, TreeNodeStatus } from "./tree-model.ts";

const theme: SidebarTheme = {
	bold: (text) => text,
	dim: (text) => text,
	fg: (_color, text) => text,
};

function makeNode(overrides: Partial<TreeNode> & Pick<TreeNode, "runId">): TreeNode {
	return {
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running" as TreeNodeStatus,
		startedAt: "2026-10-07T00:00:00.000Z",
		endedAt: null,
		task: "",
		bytesIn: 0,
		bytesOut: 0,
		usage: undefined,
		toolCount: 0,
		exitCode: null,
		error: null,
		outputPreview: "",
		orphan: false,
		children: [],
		...overrides,
	};
}

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		model: "test-model",
		thinkingLevel: "medium",
		contextTokens: 1000,
		contextWindow: 2000,
		contextPercent: null,
		cost: 0.1234,
		tps: 12.34,
		tokensIn: 0,
		tokensOut: 0,
		turns: 0,
		sessionStartMs: null,
		...overrides,
	};
}

function makeWorkspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return {
		cwd: "/home/dev/persona-agents",
		branch: "dev",
		changed: [],
		changedCount: 0,
		files: [],
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		cwd: "/home/dev/persona-agents",
		tree: [],
		session: makeSession(),
		workspace: makeWorkspace(),
		mcp: [],
		todos: [],
		tps: 0,
		...overrides,
	};
}

function assertFits(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
	}
}

/** Lines are right-padded to the column width; trim for content checks. */
function content(lines: string[]): string[] {
	return lines.map((line) => line.trimEnd());
}

// --- AGENTS (tree) -----------------------------------------------------------

test("zero nodes renders the AGENTS placeholder", () => {
	const lines = renderAgentTreePanel([], 40, 5, theme, 0);
	assert.ok(lines[0]?.startsWith(" AGENTS "));
	assert.ok(lines.some((line) => line.includes("(no active agents)")));
});

test("one done node renders one line with the check icon", () => {
	const node = makeNode({ runId: "n1", agent: "planner", status: "done" });
	const lines = renderAgentTreePanel([node], 40, 5, theme, 0);
	assert.ok(lines.length >= 2);
	assert.ok(lines[1]?.includes("✓"));
	assert.ok(lines[1]?.includes("planner"));
});

test("a running node renders the spinner frame", () => {
	const node = makeNode({ runId: "n1", agent: "tester", status: "running" });
	const lines = renderAgentTreePanel([node], 40, 5, theme, 0);
	assert.ok(lines[1]?.includes("⠋"));
});

test("an idle node renders the idle glyph and not the spinner", () => {
	const node = makeNode({ runId: "n1", agent: "tester", status: "idle" });
	const line = renderAgentTreePanel([node], 40, 5, theme, 0)[1];
	assert.ok(line?.includes("○"));
	assert.ok(!line?.includes("⠋"));
});

test("a failed node renders the cross icon", () => {
	const node = makeNode({ runId: "n1", status: "failed" });
	assert.ok(renderAgentTreePanel([node], 40, 5, theme, 0)[1]?.includes("✗"));
});

test("a stale node renders the warning icon", () => {
	const node = makeNode({ runId: "n1", status: "stale" });
	assert.ok(renderAgentTreePanel([node], 40, 5, theme, 0)[1]?.includes("⚠"));
});

test("an orphan node renders the question mark", () => {
	const node = makeNode({ runId: "n1", status: "running", orphan: true });
	assert.ok(renderAgentTreePanel([node], 40, 5, theme, 0)[1]?.includes("?"));
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

test("a full session renders the model, context bar, and stats table", () => {
	const lines = content(renderSessionPanel(makeSession(), 60, theme));
	assert.equal(lines[0]?.trimEnd(), " SESSION");
	assert.equal(lines[1], "model: test-model");
	assert.equal(lines[2], "thinking: medium");
	assert.equal(lines[3], "ctx " + contextBar(50) + " 1000/2000 (50%)");
	assert.equal(lines[4], "metric".padEnd(SESSION_LABEL_WIDTH) + "value");
	assert.equal(lines[5], "─".repeat(SESSION_LABEL_WIDTH));
	assert.equal(lines[6], "tokens".padEnd(SESSION_LABEL_WIDTH) + "0/0");
	assert.equal(lines[7], "cost".padEnd(SESSION_LABEL_WIDTH) + "$0.1234");
	assert.equal(lines[8], "turns".padEnd(SESSION_LABEL_WIDTH) + "0");
	assert.equal(lines[9], "tok/s".padEnd(SESSION_LABEL_WIDTH) + "12.3");
	assert.equal(lines[10], "elapsed".padEnd(SESSION_LABEL_WIDTH) + "-");
});

test("the session stats table aligns labels and clips a value", () => {
	const lines = content(
		renderSessionPanel(
			makeSession({ tokensIn: 1500, tokensOut: 2300, turns: 7, cost: 0.5, tps: 9.9 }),
			80,
			theme,
		),
	);
	assert.ok(lines.includes("tokens".padEnd(SESSION_LABEL_WIDTH) + "1.5k/2.3k"));
	assert.ok(lines.includes("turns".padEnd(SESSION_LABEL_WIDTH) + "7"));
	assert.ok(lines.includes("cost".padEnd(SESSION_LABEL_WIDTH) + "$0.5000"));
	assert.ok(lines.includes("tok/s".padEnd(SESSION_LABEL_WIDTH) + "9.9"));
	assertFits(renderSessionPanel(makeSession(), 8, theme), 8);
});

test("a null context renders ctx n/a and does not throw", () => {
	const lines = content(
		renderSessionPanel(
			makeSession({ contextTokens: null, contextWindow: null, contextPercent: null }),
			60,
			theme,
		),
	);
	assert.ok(lines.includes("ctx n/a"));
});

test("an entirely missing session renders n/a and does not throw", () => {
	const lines = content(renderSessionPanel(null, 60, theme));
	assert.ok(lines.includes("ctx n/a"));
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

test("status glyphs use the expected theme color tokens", () => {
	const calls: string[] = [];
	const recording: SidebarTheme = {
		fg: (name, text) => {
			calls.push(name);
			return text;
		},
	};
	statusGlyph(recording, makeNode({ runId: "r", status: "running" }), 0);
	statusGlyph(recording, makeNode({ runId: "i", status: "idle" }), 0);
	statusGlyph(recording, makeNode({ runId: "d", status: "done" }), 0);
	statusGlyph(recording, makeNode({ runId: "f", status: "failed" }), 0);
	statusGlyph(recording, makeNode({ runId: "s", status: "stale" }), 0);
	statusGlyph(recording, makeNode({ runId: "o", status: "running", orphan: true }), 0);
	assert.deepEqual(calls, ["accent", "dim", "success", "error", "warning", "warning"]);
});

test("the context fill bar uses the alarm color token above 80 percent", () => {
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

test("todo glyphs use the success and dim tokens", () => {
	const calls: string[] = [];
	const recording: SidebarTheme = {
		fg: (name, text) => {
			calls.push(name);
			return text;
		},
	};
	renderTodosPanel(
		[
			{ id: "1", text: "done", done: true },
			{ id: "2", text: "open", done: false },
		],
		60,
		recording,
	);
	assert.ok(calls.includes("success"));
	assert.ok(calls.includes("dim"));
});

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
		{ name: "context7", configured: true, connected: true },
		{ name: "exa", configured: true, connected: false },
	];
	const lines = content(renderMcpPanel(mcp, 60, theme));
	assert.equal(lines[0]?.trimEnd(), " MCP");
	assert.ok(lines.includes("configured: 2, connected: 1"));
	assert.ok(lines.some((line) => line.includes("● context7")));
	assert.ok(lines.some((line) => line.includes("○ exa")));
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
	const lines = content(renderTodosPanel(todos, 60, theme));
	assert.equal(lines[0]?.trimEnd(), " TODOS");
	assert.ok(lines.includes("1/2"));
	assert.ok(lines.some((line) => line.includes("✓ write code")));
	assert.ok(lines.some((line) => line.includes("○ write tests")));
});

test("an empty TODOS list renders (no todos)", () => {
	const lines = content(renderTodosPanel([], 60, theme));
	assert.ok(lines.includes("(no todos)"));
});

test("a long todo list clips with a more marker", () => {
	const todos: TodoSnapshot = Array.from({ length: 6 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: false,
	}));
	const lines = renderTodosPanel(todos, 60, theme);
	assert.ok(lines.some((line) => line.includes("… +2 more")));
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

// --- theme fallback ----------------------------------------------------------

test("a theme with no methods still renders a plain header", () => {
	const plain: SidebarTheme = {};
	const lines = content(renderAgentTreePanel([], 40, 5, plain, 0));
	assert.equal(lines[0]?.trimEnd(), " AGENTS");
});

test("a theme with only fg colors headers and dims the more marker", () => {
	const fgOnly: SidebarTheme = { fg: (name, text) => `<${name}>${text}</>` };
	const nodes = Array.from({ length: 6 }, (_value, index) =>
		makeNode({ runId: `n${index}`, agent: `agent${index}` }),
	);
	const lines = renderAgentTreePanel(nodes, 60, 3, fgOnly, 0);
	assert.ok(lines[0]?.includes("<accent>"));
	assert.ok(lines[2]?.includes("<dim>"));
});

test("an empty color map keeps every color token as plain text", () => {
	const calls: string[] = [];
	const empty: SidebarTheme = {
		colors: {},
		fg: (name, text) => {
			calls.push(name);
			return text;
		},
	};
	const node = makeNode({ runId: "n1", status: "running", task: "work" });

	const lines = content(renderAgentTreePanel([node], 40, 5, empty, 0));

	assert.deepEqual(calls, []);
	assert.equal(lines[0], " AGENTS");
});

test("a token in the color map is colored while a missing token stays plain", () => {
	const calls: string[] = [];
	const partial: SidebarTheme = {
		colors: { accent: true },
		fg: (name, text) => {
			calls.push(name);
			return `<${name}>${text}</>`;
		},
	};
	const node = makeNode({ runId: "n1", status: "running", task: "work" });

	renderAgentTreePanel([node], 40, 5, partial, 0);

	assert.ok(calls.includes("accent"));
	assert.ok(!calls.includes("muted"));
});

// --- selection ---------------------------------------------------------------

test("selectNext wraps from the last id to the first", () => {
	assert.equal(selectNext(["a", "b", "c"], "c"), "a");
});

test("selectPrev wraps from the first id to the last", () => {
	assert.equal(selectPrev(["a", "b", "c"], "a"), "c");
});

test("selectNext on an unknown id selects the first", () => {
	assert.equal(selectNext(["a", "b"], "zzz"), "a");
});

// --- composition, width, and signature ---------------------------------------

test("renderSidebarPanel stacks AGENTS first", () => {
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester" });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });
	const lines = renderSidebarPanel(makeSnapshot({ tree: [root] }), 80, 30, theme, 0);
	assert.ok(lines[0]?.startsWith(" AGENTS "));
	assert.ok(lines.some((line) => line.includes(" SESSION ")));
	assert.ok(lines.some((line) => line.includes(" WORKSPACE ")));
});

test("renderSidebarPanel drops lower panels when the height is short", () => {
	const lines = renderSidebarPanel(makeSnapshot(), 80, 2, theme, 0);
	assert.ok(lines[0]?.startsWith(" AGENTS "));
	assert.ok(!lines.some((line) => line.includes(" SESSION ")));
});

test("a blank separator line appears between panels when the height allows", () => {
	const lines = renderSidebarPanel(makeSnapshot(), 80, 30, theme, 0);
	assert.ok(lines.some((line) => line.trim() === ""), "expected a blank separator line");
	assert.notEqual(lines[0]?.trim(), "");
});

test("no separator is added when it would drop a panel", () => {
	// AGENTS pads to 4 lines; SESSION is 11. They fit exactly at height 15.
	const lines = renderSidebarPanel(makeSnapshot(), 80, 15, theme, 0);
	assert.ok(lines.length <= 15);
	assert.ok(lines.some((line) => line.includes(" SESSION ")));
	assert.ok(lines.some((line) => line.includes("elapsed")), "the last SESSION row must stay");
});

test("a short tree at height 14 pads AGENTS to the minimum and drops SESSION", () => {
	// Tradeoff: AGENTS_PAD_MIN buys a stable footprint for the lower panels,
	// but that pad pushes SESSION out when the height is short. AGENTS pads
	// to 4 and SESSION is 11, so 4 + 11 = 15 needs height 15; at 14 the
	// compositor drops SESSION rather than shrink the padded AGENTS panel.
	const root = makeNode({ runId: "root", agent: "orchestrator" });
	const lines = renderSidebarPanel(makeSnapshot({ tree: [root] }), 80, 14, theme, 0);
	assert.equal(lines.length, AGENTS_PAD_MIN, "AGENTS pads to the minimum footprint");
	assert.ok(!lines.some((line) => line.includes(" SESSION ")), "SESSION is dropped at height 14");
});

test("every composed line fits the width", () => {
	const tree = [
		makeNode({
			runId: "root",
			depth: 0,
			task: "a very long task that would overflow the narrow column for sure",
			agent: "orchestrator",
		}),
	];
	const snapshot = makeSnapshot({
		tree,
		workspace: makeWorkspace({ changed: ["a/very/long/path.ts", "b.ts"], changedCount: 2 }),
		mcp: [{ name: "a-very-long-server-name", configured: true, connected: false }],
		todos: [{ id: "1", text: "a very long todo text that overflows", done: false }],
	});
	const lines = renderSidebarPanel(snapshot, 18, 40, theme, 0);
	assert.ok(lines.length > 0);
	assertFits(lines, 18);
});

test("a long task clips with an ellipsis", () => {
	const node = makeNode({
		runId: "n1",
		agent: "orchestrator",
		task: "this task preview is much too long to fit in the narrow column",
	});
	const lines = renderAgentTreePanel([node], 20, 5, theme, 0);
	assert.ok(lines[1]?.includes("…"));
	assertFits(lines, 20);
});

test("treeSignature changes when a node status changes", () => {
	const before = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", status: "running" })] }));
	const after = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", status: "done" })] }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a todo changes", () => {
	const before = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "a", done: false }] }));
	const after = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "a", done: true }] }));
	assert.notEqual(before, after);
});

test("a short tree pads the AGENTS panel to a stable footprint", () => {
	const lines = renderAgentTreePanel([makeNode({ runId: "n1" })], 45, 20, theme, 0);
	assert.equal(lines.length, AGENTS_PAD_MIN);
});

test("AGENTS padding never exceeds the height budget", () => {
	const lines = renderAgentTreePanel([], 45, 2, theme, 0);
	assert.ok(lines.length <= 2, `padded to ${lines.length} lines for height 2`);
});

// --- width and height edge cases ---------------------------------------------

for (const width of [0, 1, 45]) {
	test(`every panel fits width ${width} and does not throw`, () => {
		const node = makeNode({ runId: "n1", agent: "orchestrator" });
		const panels = [
			renderAgentTreePanel([node], width, 5, theme, 0),
			renderSessionPanel(makeSession(), width, theme),
			renderWorkspacePanel(makeWorkspace(), width, theme),
			renderMcpPanel([{ name: "context7", configured: true, connected: true }], width, theme),
			renderTodosPanel([{ id: "1", text: "do it", done: false }], width, theme),
			renderSidebarPanel(
				makeSnapshot({
					tree: [node],
					mcp: [{ name: "context7", configured: true, connected: true }],
					todos: [{ id: "1", text: "do it", done: false }],
				}),
				width,
				20,
				theme,
				0,
			),
		];
		for (const lines of panels) assertFits(lines, width);
	});
}

for (const height of [0, 1, 3, 8, 15, 30]) {
	test(`renderSidebarPanel respects height ${height}`, () => {
		const node = makeNode({ runId: "root", agent: "orchestrator", task: "work" });
		const lines = renderSidebarPanel(
			makeSnapshot({
				tree: [node],
				mcp: [{ name: "context7", configured: true, connected: true }],
				todos: [{ id: "1", text: "do it", done: false }],
			}),
			80,
			height,
			theme,
			0,
		);
		assert.ok(lines.length <= height, `height ${height} overflowed with ${lines.length} lines`);
	});
}

test("renderSidebarPanel drops lower panels first", () => {
	const node = makeNode({ runId: "root", agent: "orchestrator", task: "work" });
	const snapshot = makeSnapshot({
		tree: [node],
		mcp: [{ name: "context7", configured: true, connected: true }],
		todos: [{ id: "1", text: "do it", done: false }],
	});
	const headers = [" AGENTS ", " SESSION ", " WORKSPACE ", " MCP ", " TODOS "];
	for (const height of [1, 3, 8, 12, 15, 18, 30]) {
		const lines = renderSidebarPanel(snapshot, 80, height, theme, 0);
		assert.ok(lines.length <= height, `height ${height} overflowed`);
		const present = headers
			.map((header, index) => (lines.some((line) => line.includes(header)) ? index : -1))
			.filter((index) => index >= 0);
		present.forEach((index, position) => {
			assert.equal(index, position, `height ${height} dropped a higher panel before a lower one`);
		});
	}
});

// --- selection edge cases ----------------------------------------------------

test("selectNext on an empty list returns the current value", () => {
	assert.equal(selectNext([], null), null);
	assert.equal(selectNext([], "x"), "x");
});

test("selectPrev on an empty list returns the current value", () => {
	assert.equal(selectPrev([], null), null);
	assert.equal(selectPrev([], "x"), "x");
});

test("selectPrev on an unknown id selects the last", () => {
	assert.equal(selectPrev(["a", "b", "c"], "zzz"), "c");
});

test("selectNext and selectPrev wrap a single-element list to itself", () => {
	assert.equal(selectNext(["a"], "a"), "a");
	assert.equal(selectPrev(["a"], "a"), "a");
});

// --- treeSignature coverage --------------------------------------------------

test("treeSignature changes when a node depth changes", () => {
	const before = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", depth: 0 })] }));
	const after = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", depth: 1 })] }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a task changes after char 64", () => {
	const prefix = "t".repeat(80);
	const before = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", task: `${prefix}A` })] }));
	const after = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", task: `${prefix}B` })] }));
	assert.notEqual(before, after);
});

test("treeSignature changes when an output preview changes after char 64", () => {
	const prefix = "p".repeat(80);
	const before = treeSignature(
		makeSnapshot({ tree: [makeNode({ runId: "n1", outputPreview: `${prefix}A` })] }),
	);
	const after = treeSignature(
		makeSnapshot({ tree: [makeNode({ runId: "n1", outputPreview: `${prefix}B` })] }),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when a node usage changes", () => {
	const before = treeSignature(
		makeSnapshot({
			tree: [makeNode({ runId: "n1", usage: { input: 1, output: 2, cost: 0.1, turns: 3 } })],
		}),
	);
	const after = treeSignature(
		makeSnapshot({
			tree: [makeNode({ runId: "n1", usage: { input: 1, output: 2, cost: 0.2, turns: 3 } })],
		}),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when a node tool count changes", () => {
	const before = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", toolCount: 1 })] }));
	const after = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", toolCount: 2 })] }));
	assert.notEqual(before, after);
});

test("treeSignature keeps a null error distinct from an empty string", () => {
	const before = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", error: null })] }));
	const after = treeSignature(makeSnapshot({ tree: [makeNode({ runId: "n1", error: "" })] }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a session field changes", () => {
	const before = treeSignature(makeSnapshot({ session: makeSession({ model: "model-a" }) }));
	const after = treeSignature(makeSnapshot({ session: makeSession({ model: "model-b" }) }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a session token total changes", () => {
	const before = treeSignature(makeSnapshot({ session: makeSession({ tokensIn: 10, tokensOut: 20, turns: 1 }) }));
	const after = treeSignature(makeSnapshot({ session: makeSession({ tokensIn: 10, tokensOut: 20, turns: 2 }) }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a workspace field changes", () => {
	const before = treeSignature(makeSnapshot({ workspace: makeWorkspace({ branch: "dev" }) }));
	const after = treeSignature(makeSnapshot({ workspace: makeWorkspace({ branch: "main" }) }));
	assert.notEqual(before, after);
});

test("treeSignature changes when a workspace file stat changes", () => {
	const before = treeSignature(
		makeSnapshot({ workspace: makeWorkspace({ files: [{ path: "a.ts", added: 1, removed: 0, untracked: false }] }) }),
	);
	const after = treeSignature(
		makeSnapshot({ workspace: makeWorkspace({ files: [{ path: "a.ts", added: 2, removed: 0, untracked: false }] }) }),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when an MCP field changes", () => {
	const before = treeSignature(
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: false }] }),
	);
	const after = treeSignature(
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: true }] }),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when a todos field changes", () => {
	const before = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "first", done: false }] }));
	const after = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "second", done: false }] }));
	assert.notEqual(before, after);
});

// --- detail overlay clipping and placeholders --------------------------------

test("renderNodeDetail clips a very long output preview to the width", () => {
	const node = makeNode({ runId: "n1", outputPreview: "x".repeat(500) });
	assertFits(renderNodeDetail(node, 40, theme), 40);
});

test("renderNodeDetail clips a very long error to the width", () => {
	const node = makeNode({ runId: "n1", error: "e".repeat(500) });
	assertFits(renderNodeDetail(node, 40, theme), 40);
});

test("renderNodeDetail shows the no-output placeholder for a whitespace preview", () => {
	const node = makeNode({ runId: "n1", outputPreview: "   \n  " });
	const lines = renderNodeDetail(node, 40, theme);
	assert.equal(lines.filter((line) => line.includes("(no output)")).length, 1);
});

test("statusIcon returns the first spinner frame for a non-finite frame", () => {
	assert.equal(statusIcon("running", Number.NaN), "⠋");
	assert.equal(statusIcon("running", Number.POSITIVE_INFINITY), "⠋");
	assert.equal(statusIcon("running", Number.NEGATIVE_INFINITY), "⠋");
});
