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
		...overrides,
	};
}

function makeWorkspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return {
		cwd: "/home/dev/persona-agents",
		branch: "dev",
		changed: [],
		changedCount: 0,
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

/** Count the leading spaces in one line. */
function leadingSpaces(line: string | undefined): number {
	return /^( *)/.exec(line ?? "")?.[1]?.length ?? 0;
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
	assert.equal(lines.length, 2);
	assert.ok(lines[1]?.includes("✓"));
	assert.ok(lines[1]?.includes("planner"));
});

test("a running node renders the spinner frame", () => {
	const node = makeNode({ runId: "n1", agent: "tester", status: "running" });
	const lines = renderAgentTreePanel([node], 40, 5, theme, 0);
	assert.ok(lines[1]?.includes("⠋"));
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

test("indentation grows with depth", () => {
	const grandchild = makeNode({ runId: "c2", parentRunId: "c1", depth: 2, agent: "researcher" });
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester", children: [grandchild] });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });

	const lines = renderTreeLines([root], theme, 0);
	assert.ok(lines[0]?.startsWith("⠋"));
	assert.ok(leadingSpaces(lines[1]) > leadingSpaces(lines[0]));
	assert.ok(leadingSpaces(lines[2]) > leadingSpaces(lines[1]));
});

test("the root node is the first node line", () => {
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester" });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });
	const lines = renderTreeLines([root], theme, 0);
	assert.ok(lines[0]?.includes("orchestrator"));
	assert.ok(lines[1]?.includes("tester"));
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

test("a full session renders the five field lines", () => {
	const lines = content(renderSessionPanel(makeSession(), 60, theme));
	assert.equal(lines[0]?.trimEnd(), " SESSION");
	assert.equal(lines[1], "model: test-model");
	assert.equal(lines[2], "thinking: medium");
	assert.equal(lines[3], "context: 1000/2000 (50%)");
	assert.equal(lines[4], "cost: $0.1234");
	assert.equal(lines[5], "tps: 12.3");
});

test("a null context renders n/a and does not throw", () => {
	const lines = content(
		renderSessionPanel(
			makeSession({ contextTokens: null, contextWindow: null, contextPercent: null }),
			60,
			theme,
		),
	);
	assert.ok(lines.includes("context: n/a"));
});

test("an entirely missing session renders n/a and does not throw", () => {
	const lines = content(renderSessionPanel(null, 60, theme));
	assert.ok(lines.includes("context: n/a"));
	assert.ok(lines.includes("cost: n/a"));
});

// --- WORKSPACE ---------------------------------------------------------------

test("the branch renders", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace({ branch: "dev" }), 60, theme));
	assert.equal(lines[0]?.trimEnd(), " WORKSPACE");
	assert.ok(lines.includes("dev"));
});

test("a null branch renders (not a repo)", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace({ branch: null }), 60, theme));
	assert.ok(lines.includes("(not a repo)"));
});

test("no changes renders (clean)", () => {
	const lines = content(renderWorkspacePanel(makeWorkspace(), 60, theme));
	assert.ok(lines.includes("(clean)"));
});

test("a long changed list clips with a more marker", () => {
	const lines = renderWorkspacePanel(
		makeWorkspace({ changed: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"], changedCount: 6 }),
		60,
		theme,
	);
	const changedLine = lines.find((line) => line.includes("changed"));
	assert.ok(changedLine?.includes("6 changed"));
	assert.ok(changedLine?.includes("… +2 more"));
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

// --- width and height edge cases ---------------------------------------------

for (const width of [0, 1]) {
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

for (const height of [0, 1, 3]) {
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

test("treeSignature changes when a workspace field changes", () => {
	const before = treeSignature(makeSnapshot({ workspace: makeWorkspace({ branch: "dev" }) }));
	const after = treeSignature(makeSnapshot({ workspace: makeWorkspace({ branch: "main" }) }));
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
