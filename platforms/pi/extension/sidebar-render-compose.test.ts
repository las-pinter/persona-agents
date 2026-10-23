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
	type SidebarSnapshot,
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

test("selectNext and selectPrev wrap, fall back on an unknown id, and tolerate an empty list", () => {
	assert.equal(selectNext(["a", "b", "c"], "c"), "a");
	assert.equal(selectPrev(["a", "b", "c"], "a"), "c");
	assert.equal(selectNext(["a", "b"], "zzz"), "a");
	assert.equal(selectPrev(["a", "b", "c"], "zzz"), "c");
	assert.equal(selectNext(["a"], "a"), "a");
	assert.equal(selectPrev(["a"], "a"), "a");
	assert.equal(selectNext([], null), null);
	assert.equal(selectPrev([], "x"), "x");
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
	for (const height of [0, 1, 3, 8, 12, 15, 18, 30]) {
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

// --- treeSignature coverage --------------------------------------------------

test("treeSignature changes for every field the panels paint", () => {
	const n = (overrides: Partial<Parameters<typeof makeNode>[0]>) =>
		makeSnapshot({ tree: [makeNode({ runId: "n1", ...overrides })] });
	const long = "t".repeat(80);
	const mcp = (connected: boolean, status: "connected" | "disconnected" | "unknown") =>
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected, status }] });
	const file = (added: number) =>
		makeSnapshot({
			workspace: makeWorkspace({ files: [{ path: "a.ts", added, removed: 0, untracked: false }] }),
		});
	const usage = (cost: number) => n({ usage: { input: 1, output: 2, cost, turns: 3 } });
	const cases: Array<[string, SidebarSnapshot, SidebarSnapshot]> = [
		["node status", n({ status: "running" }), n({ status: "done" })],
		["node depth", n({ depth: 0 }), n({ depth: 1 })],
		["task after char 64", n({ task: `${long}A` }), n({ task: `${long}B` })],
		["output preview after char 64", n({ outputPreview: `${long}A` }), n({ outputPreview: `${long}B` })],
		["node usage", usage(0.1), usage(0.2)],
		["tool count", n({ toolCount: 1 }), n({ toolCount: 2 })],
		["null error vs empty error", n({ error: null }), n({ error: "" })],
		[
			"session model",
			makeSnapshot({ session: makeSession({ model: "model-a" }) }),
			makeSnapshot({ session: makeSession({ model: "model-b" }) }),
		],
		[
			"session turns",
			makeSnapshot({ session: makeSession({ turns: 1 }) }),
			makeSnapshot({ session: makeSession({ turns: 2 }) }),
		],
		[
			"workspace branch",
			makeSnapshot({ workspace: makeWorkspace({ branch: "dev" }) }),
			makeSnapshot({ workspace: makeWorkspace({ branch: "main" }) }),
		],
		["workspace file stat", file(1), file(2)],
		["MCP connected", mcp(false, "disconnected"), mcp(true, "connected")],
		["MCP status only", mcp(false, "unknown"), mcp(false, "disconnected")],
		[
			"todo done flag",
			makeSnapshot({ todos: [{ id: "1", text: "a", done: false }] }),
			makeSnapshot({ todos: [{ id: "1", text: "a", done: true }] }),
		],
		[
			"todo text",
			makeSnapshot({ todos: [{ id: "1", text: "first", done: false }] }),
			makeSnapshot({ todos: [{ id: "1", text: "second", done: false }] }),
		],
		["todos turn marker", makeSnapshot({ todosTurnMarker: false }), makeSnapshot({ todosTurnMarker: true })],
	];
	for (const [label, before, after] of cases) {
		assert.notEqual(treeSignature(before), treeSignature(after), label);
	}
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
