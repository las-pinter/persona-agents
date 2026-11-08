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
	type StatusSnapshot,
	AGENTS_PAD_MIN,
	SECTION_RULE_CHAR,
	STATUS_PAD_MIN,
	renderAgentTreePanel,
	renderMcpPanel,
	renderNodeDetail,
	renderSessionPanel,
	renderSidebarPanel,
	renderStatusPanel,
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
	makeAskLogRows,
	makeBudgetSnapshot,
	makeNode,
	makeSession,
	makeSnapshot,
	makeWorkspace,
	theme,
} from "./sidebar-render-fixtures.ts";

const HEADER_RE = /^ (AGENTS|STATUS|LOG \d+|SESSION|WORKSPACE|MCP|TODOS)$/;

/** The panel headers a composed column paints, in column order. */
function visibleHeaders(lines: string[]): string[] {
	return content(lines)
		.filter((line) => HEADER_RE.test(line))
		.map((line) => line.trim().split(" ")[0] as string);
}

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
	const lines = content(renderSidebarPanel(makeSnapshot(), 80, 2, theme, 0));
	const headers = visibleHeaders(lines);
	assert.deepEqual(headers, ["AGENTS"], "only AGENTS paints at height 2");
	assert.equal(lines.length, 2, "the column uses the whole height");
});

test("renderSidebarPanel puts STATUS second and LOG third", () => {
	const lines = renderSidebarPanel(makeBudgetSnapshot(), 80, 30, theme, 0);
	assert.deepEqual(visibleHeaders(lines), ["AGENTS", "STATUS", "LOG", "SESSION"]);
});

test("renderStatusPanel pads a missing status to four lines", () => {
	const lines = renderStatusPanel(undefined, 80, theme);
	assert.equal(lines.length, STATUS_PAD_MIN);
	assert.equal(content(lines)[0], " STATUS");
	assert.deepEqual(content(lines).slice(1), ["no active study", "next -", "- · ask -"]);
	assertFits(lines, 80);
});

test("renderStatusPanel paints the stage, next, and ask rows", () => {
	const status: StatusSnapshot = {
		study: "gate-status-surface",
		stage: "full",
		briefs: ["01-a.md", "02-b.md", "03-c.md", "04-d.md"],
		nextAction: "brief 01",
		head: "b674669",
		askCounts: { bash: 2 },
		askTool: "bash",
		askAgeMs: 65_000,
	};
	const lines = content(renderStatusPanel(status, 80, theme));
	assert.equal(lines[1], "full · 4 briefs · gate-status-surface");
	assert.equal(lines[2], "next brief 01");
	assert.equal(lines[3], "b674669 · ask bash x2 1m05s");
	assertFits(renderStatusPanel(status, 20, theme), 20);
});

test("a full-width dim rule separates panels, never above the first or below the last", () => {
	const lines = renderSidebarPanel(makeSnapshot(), 80, 40, theme, 0);
	const rule = SECTION_RULE_CHAR.repeat(80);
	const ruleIndexes = lines
		.map((line, index) => (line === rule ? index : -1))
		.filter((index) => index >= 0);
	// One rule per gap between the seven panels.
	assert.equal(ruleIndexes.length, 6, "expected one rule per panel gap");
	assert.notEqual(lines[0], rule, "no rule above the first panel");
	assert.notEqual(lines[lines.length - 1], rule, "no rule below the last panel");
	for (const index of ruleIndexes) {
		assert.notEqual(lines[index - 1], rule, "two rules are adjacent");
		assert.notEqual(lines[index + 1], rule, "two rules are adjacent");
		assert.ok((lines[index - 1]?.length ?? 0) > 0, "a rule sits right after a panel line");
	}
});

test("the section rule is clipped at width 0 and 1 and still fits", () => {
	const atOne = renderSidebarPanel(makeSnapshot(), 1, 40, theme, 0);
	assertFits(atOne, 1);
	assert.equal(
		atOne.filter((line) => line === SECTION_RULE_CHAR).length,
		6,
		"six rules are drawn at width 1",
	);

	const atZero = renderSidebarPanel(makeSnapshot(), 0, 40, theme, 0);
	assertFits(atZero, 0);
	assert.ok(atZero.every((line) => line === ""), "every line is empty at width 0");
});

test("the section rule counts against the height budget", () => {
	const rule = SECTION_RULE_CHAR.repeat(80);
	// AGENTS pads to 4, STATUS is 4, LOG is 5, and SESSION is 9. With three
	// rules, 4 + 1 + 4 + 1 + 5 + 1 + 9 = 25 needs height 25; at 24 SESSION drops.
	const fits = renderSidebarPanel(makeSnapshot(), 80, 25, theme, 0);
	assert.ok(fits.some((line) => line.includes(" SESSION ")), "SESSION fits at height 25");
	assert.equal(fits.filter((line) => line === rule).length, 3, "three rules fit at height 25");
	assert.ok(fits.length <= 25);

	const short = renderSidebarPanel(makeSnapshot(), 80, 24, theme, 0);
	assert.ok(!short.some((line) => line.includes(" SESSION ")), "SESSION drops at height 24");
	assert.equal(short.filter((line) => line === rule).length, 2, "two rules without a fourth panel");
	assert.ok(short.length <= 24);
});

test("a short tree at height 13 pads AGENTS to the minimum and drops SESSION", () => {
	// AGENTS pads to 4 and STATUS is 4, so one rule makes 4 + 1 + 4 = 9 lines.
	// SESSION would need 19, so at 13 it drops and AGENTS stays at its minimum.
	const root = makeNode({ runId: "root", agent: "orchestrator" });
	const lines = renderSidebarPanel(makeSnapshot({ tree: [root] }), 80, 13, theme, 0);
	assert.equal(
		lines.length,
		AGENTS_PAD_MIN + 1 + STATUS_PAD_MIN,
		"AGENTS pads and STATUS paints",
	);
	assert.equal(content(lines)[AGENTS_PAD_MIN - 1], "", "AGENTS pads with a blank line");
	assert.ok(!lines.some((line) => line.includes(" SESSION ")), "SESSION is dropped at height 13");
	assert.ok(!lines.some((line) => line.includes(" LOG ")), "LOG is dropped at height 13");
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

for (const width of [0, 1, 10, 20, 45, 120]) {
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
					askLog: makeAskLogRows(),
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

test("renderSidebarPanel gives TODOS the height left after 34 upper lines", () => {
	const height = 40;
	const todos = Array.from({ length: 8 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: false,
	}));
	const lines = renderSidebarPanel(makeSnapshot({ todos }), 80, height, theme, 0);
	const todosStart = content(lines).findIndex((line) => line === " TODOS");
	assert.ok(todosStart > 0, "TODOS paints at height 40");
	assert.equal(lines.length, height, "the column uses the whole height");
	assert.equal(lines.length - todosStart, height - 34, "TODOS gets limit minus the 34 upper lines");
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
	const headers = [" AGENTS ", " STATUS ", " LOG ", " SESSION ", " WORKSPACE ", " MCP ", " TODOS "];
	for (const height of [0, 1, 3, 8, 12, 15, 16, 18, 24, 30]) {
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

test("renderSidebarPanel keeps the settled order at heights 30, 24, 16, and 12", () => {
	const snapshot = makeBudgetSnapshot();
	const headers = (height: number): string[] =>
		visibleHeaders(renderSidebarPanel(snapshot, 80, height, theme, 0));
	assert.deepEqual(headers(30), ["AGENTS", "STATUS", "LOG", "SESSION"]);
	assert.deepEqual(headers(24), ["AGENTS", "STATUS", "LOG"]);
	assert.deepEqual(headers(16), ["AGENTS", "STATUS", "LOG"]);
	assert.deepEqual(headers(12), ["AGENTS", "STATUS"]);
});

test("renderSidebarPanel paints all seven headers in order at height 40", () => {
	// Height 40 fits the seven panels and their six rules, so the MCP and TODOS
	// headers paint here and a swap of two of them cannot pass unseen.
	const lines = renderSidebarPanel(makeBudgetSnapshot(), 80, 40, theme, 0);
	assert.deepEqual(visibleHeaders(lines), [
		"AGENTS",
		"STATUS",
		"LOG",
		"SESSION",
		"WORKSPACE",
		"MCP",
		"TODOS",
	]);
	assert.equal(lines.length, 40, "the column uses the whole height");
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
	const status = (overrides: Partial<StatusSnapshot> = {}) =>
		makeSnapshot({
			status: {
				study: "study-a",
				stage: "full",
				briefs: ["01-a.md"],
				nextAction: "brief 01",
				head: "abc1234",
				askCounts: { bash: 1 },
				askTool: "bash",
				askAgeMs: 1000,
				...overrides,
			},
		});
	const askLog = (text: string) =>
		makeSnapshot({
			askLog: [{ askId: "root#1", phase: "expiry", at: "2026-11-07T00:00:00.000Z", text }],
		});
	const cases: Array<[string, SidebarSnapshot, SidebarSnapshot]> = [
		["node status", n({ status: "running" }), n({ status: "done" })],
		["node depth", n({ depth: 0 }), n({ depth: 1 })],
		["task after char 64", n({ task: `${long}A` }), n({ task: `${long}B` })],
		["output preview after char 64", n({ outputPreview: `${long}A` }), n({ outputPreview: `${long}B` })],
		["node usage", usage(0.1), usage(0.2)],
		["tool count", n({ toolCount: 1 }), n({ toolCount: 2 })],
		["node round", n({ round: 1 }), n({ round: 2 })],
		["node resumed", n({ resumed: false }), n({ resumed: true })],
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
		["status study", status(), status({ study: "study-b" })],
		["status stage", status(), status({ stage: "draft" })],
		["status briefs", status(), status({ briefs: ["01-a.md", "02-b.md"] })],
		["status next action", status(), status({ nextAction: "brief 02" })],
		["status head", status(), status({ head: "def5678" })],
		["status ask count", status(), status({ askCounts: { bash: 2 } })],
		["status ask tool", status(), status({ askTool: "edit" })],
		["status ask age", status(), status({ askAgeMs: 2000 })],
		["askLog row text", askLog("a"), askLog("b")],
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
