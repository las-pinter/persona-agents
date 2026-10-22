/**
 * Sidebar renderer composition and fitting tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-render-compose.test.ts
 *
 * Covers panel composition, width and height fitting, the tree signature,
 * selection, theme fallback, and the detail overlay.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	type SidebarTheme,
	AGENTS_PAD_MIN,
	SECTION_RULE_CHAR,
	renderAgentTreePanel,
	renderMcpPanel,
	renderNodeDetail,
	renderSessionPanel,
	renderSidebarPanel,
	renderTodosPanel,
	renderWorkspacePanel,
	selectNext,
	selectPrev,
	statusIcon,
	treeSignature,
} from "./sidebar-render.ts";
import {
	assertFits,
	content,
	makeNode,
	makeSession,
	makeSnapshot,
	makeWorkspace,
	theme,
} from "./sidebar-render-fixtures.ts";

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

test("a full-width dim rule separates panels, never above the first or below the last", () => {
	const lines = renderSidebarPanel(makeSnapshot(), 80, 30, theme, 0);
	const rule = SECTION_RULE_CHAR.repeat(80);
	const ruleIndexes = lines
		.map((line, index) => (line === rule ? index : -1))
		.filter((index) => index >= 0);
	// One rule per gap between the five panels.
	assert.equal(ruleIndexes.length, 4, "expected one rule per panel gap");
	assert.notEqual(lines[0], rule, "no rule above the first panel");
	assert.notEqual(lines[lines.length - 1], rule, "no rule below the last panel");
	for (const index of ruleIndexes) {
		assert.notEqual(lines[index - 1], rule, "two rules are adjacent");
		assert.notEqual(lines[index + 1], rule, "two rules are adjacent");
		assert.ok((lines[index - 1]?.length ?? 0) > 0, "a rule sits right after a panel line");
	}
});

test("the section rule is clipped at width 0 and 1 and still fits", () => {
	const atOne = renderSidebarPanel(makeSnapshot(), 1, 30, theme, 0);
	assertFits(atOne, 1);
	assert.equal(
		atOne.filter((line) => line === SECTION_RULE_CHAR).length,
		4,
		"four rules are drawn at width 1",
	);

	const atZero = renderSidebarPanel(makeSnapshot(), 0, 30, theme, 0);
	assertFits(atZero, 0);
	assert.ok(atZero.every((line) => line === ""), "every line is empty at width 0");
});

test("the section rule is drawn with the dim color token", () => {
	const calls: Array<[string, string]> = [];
	const recording: SidebarTheme = {
		fg: (name, text) => {
			calls.push([name, text]);
			return text;
		},
	};
	const rule = SECTION_RULE_CHAR.repeat(80);

	renderSidebarPanel(makeSnapshot(), 80, 30, recording, 0);

	assert.ok(
		calls.some(([name, text]) => name === "dim" && text === rule),
		"the section rule must use the dim token",
	);
});

test("the section rule counts against the height budget", () => {
	const rule = SECTION_RULE_CHAR.repeat(80);
	// AGENTS pads to 4; SESSION is 9. One rule makes 14 lines, so SESSION
	// fits at height 14 but is dropped at height 13 before the budget overflows.
	const fits = renderSidebarPanel(makeSnapshot(), 80, 14, theme, 0);
	assert.ok(fits.some((line) => line.includes(" SESSION ")), "SESSION fits at height 14");
	assert.equal(fits.filter((line) => line === rule).length, 1, "one rule fits at height 14");
	assert.ok(fits.length <= 14);

	const short = renderSidebarPanel(makeSnapshot(), 80, 13, theme, 0);
	assert.ok(!short.some((line) => line.includes(" SESSION ")), "SESSION drops at height 13");
	assert.equal(short.filter((line) => line === rule).length, 0, "no rule without a second panel");
	assert.ok(short.length <= 13);
});

test("a short tree at height 13 pads AGENTS to the minimum and drops SESSION", () => {
	// Tradeoff: AGENTS_PAD_MIN buys a stable footprint for the lower panels.
	// AGENTS pads to 4 and SESSION is 9, so with one rule 4 + 1 + 9 = 14 needs
	// height 14; at 13 the compositor drops SESSION rather than shrink AGENTS.
	const root = makeNode({ runId: "root", agent: "orchestrator" });
	const lines = renderSidebarPanel(makeSnapshot({ tree: [root] }), 80, 13, theme, 0);
	assert.equal(lines.length, AGENTS_PAD_MIN, "AGENTS pads to the minimum footprint");
	assert.ok(!lines.some((line) => line.includes(" SESSION ")), "SESSION is dropped at height 13");
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
		mcp: [{ name: "a-very-long-server-name", configured: true, connected: false, status: "disconnected" }],
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
			renderMcpPanel([{ name: "context7", configured: true, connected: true, status: "connected" }], width, theme),
			renderTodosPanel([{ id: "1", text: "do it", done: false }], width, 8, theme),
			renderSidebarPanel(
				makeSnapshot({
					tree: [node],
					mcp: [{ name: "context7", configured: true, connected: true, status: "connected" }],
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
				mcp: [{ name: "context7", configured: true, connected: true, status: "connected" }],
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

test("renderSidebarPanel gives TODOS the leftover height and shows every item", () => {
	const snapshot = makeSnapshot({
		tree: [],
		todos: Array.from({ length: 6 }, (_value, index) => ({
			id: String(index),
			text: `todo ${index}`,
			done: false,
		})),
	});
	const lines = renderSidebarPanel(snapshot, 80, 60, theme, 0);
	assert.ok(lines.some((line) => line.includes("todo 5")), "the sixth item must render when height allows");
	assert.ok(!lines.some((line) => line.includes("more")), "no overflow marker when every item fits");
});

test("renderSidebarPanel paints the turn marker from the snapshot", () => {
	const snapshot = makeSnapshot({
		tree: [],
		todos: [{ id: "1", text: "open", done: false }],
		todosTurnMarker: true,
	});
	const withMarker = content(renderSidebarPanel(snapshot, 80, 60, theme, 0));
	assert.ok(withMarker.some((line) => line.includes("— new turn —")));

	const withoutMarker = content(
		renderSidebarPanel(makeSnapshot({ tree: [], todos: [{ id: "1", text: "open", done: false }] }), 80, 60, theme, 0),
	);
	assert.ok(!withoutMarker.some((line) => line.includes("— new turn —")));
});

test("renderSidebarPanel drops lower panels first", () => {
	const node = makeNode({ runId: "root", agent: "orchestrator", task: "work" });
	const snapshot = makeSnapshot({
		tree: [node],
		mcp: [{ name: "context7", configured: true, connected: true, status: "connected" }],
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
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: false, status: "disconnected" }] }),
	);
	const after = treeSignature(
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: true, status: "connected" }] }),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when only an MCP status changes", () => {
	const before = treeSignature(
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: false, status: "unknown" }] }),
	);
	const after = treeSignature(
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected: false, status: "disconnected" }] }),
	);
	assert.notEqual(before, after);
});

test("treeSignature changes when a todos field changes", () => {
	const before = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "first", done: false }] }));
	const after = treeSignature(makeSnapshot({ todos: [{ id: "1", text: "second", done: false }] }));
	assert.notEqual(before, after);
});

test("treeSignature changes when the todos turn marker changes", () => {
	const before = treeSignature(makeSnapshot({ todosTurnMarker: false }));
	const after = treeSignature(makeSnapshot({ todosTurnMarker: true }));
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
