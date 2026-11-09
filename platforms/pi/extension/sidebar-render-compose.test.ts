/**
 * Sidebar renderer composition and fitting tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-render-compose.test.ts
 *
 * Covers panel composition, width and height fitting, theme fallback, and the
 * detail overlay. The repaint signature and the selection walk hold their own
 * test files.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
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
	statusIcon,
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

const HEADER_RE = /^ (AGENTS|STATUS|LOG \d+\/\d+|SESSION|WORKSPACE|MCP|TODOS)$/;

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

// --- composition, width, and height ------------------------------------------

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

test("renderSidebarPanel puts STATUS second and SESSION third", () => {
	const lines = renderSidebarPanel(makeBudgetSnapshot(), 80, 30, theme, 0);
	assert.deepEqual(visibleHeaders(lines), ["AGENTS", "STATUS", "SESSION", "WORKSPACE", "MCP"]);
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
	// AGENTS pads to 4, STATUS is 4, SESSION is 9, and WORKSPACE is 3. With
	// three rules, 4 + 1 + 4 + 1 + 9 + 1 + 3 = 23 needs height 23; at 22
	// WORKSPACE drops.
	const fits = renderSidebarPanel(makeSnapshot(), 80, 23, theme, 0);
	assert.ok(fits.some((line) => line.includes(" WORKSPACE ")), "WORKSPACE fits at height 23");
	assert.equal(fits.filter((line) => line === rule).length, 3, "three rules fit at height 23");
	assert.ok(fits.length <= 23);

	const short = renderSidebarPanel(makeSnapshot(), 80, 22, theme, 0);
	assert.ok(!short.some((line) => line.includes(" WORKSPACE ")), "WORKSPACE drops at height 22");
	assert.equal(short.filter((line) => line === rule).length, 2, "two rules without a fourth panel");
	assert.ok(short.length <= 22);
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

test("renderSidebarPanel gives TODOS the height left after the 34 fixed lines", () => {
	const height = 40;
	const todos = Array.from({ length: 8 }, (_value, index) => ({
		id: String(index),
		text: `todo ${index}`,
		done: false,
	}));
	const lines = renderSidebarPanel(makeSnapshot({ todos }), 80, height, theme, 0);
	const painted = content(lines);
	const todosStart = painted.findIndex((line) => line === " TODOS");
	assert.ok(todosStart > 0, "TODOS paints at height 40");
	assert.equal(lines.length, height, "the column uses the whole height");
	// The six fixed panels take 28 lines and the six rules take six, so TODOS
	// gets 6 lines. One rule and the five-line log sit below it.
	const todosEnd = painted.findIndex(
		(line, index) => index > todosStart && line === SECTION_RULE_CHAR.repeat(80),
	);
	assert.equal(todosEnd - todosStart, height - 34, "TODOS gets limit minus the 34 fixed lines");
	assert.equal(lines.length - todosEnd, 6, "one rule and the five-line log stay below TODOS");
});

test("renderSidebarPanel fills height 37 and gives the freed rule line to TODOS", () => {
	// AGENTS to MCP take 26 lines and LOG takes five. Six rules would need 38
	// lines, so the rule above TODOS is freed and TODOS paints a one-line
	// header in its place.
	const lines = content(renderSidebarPanel(makeBudgetSnapshot(), 80, 37, theme, 0));
	const rule = SECTION_RULE_CHAR.repeat(80);
	assert.equal(lines.length, 37, "the column fills the limit");
	const todosStart = lines.findIndex((line) => line === " TODOS");
	assert.ok(todosStart > 0, "TODOS paints its header at height 37");
	assert.notEqual(lines[todosStart - 1], rule, "the freed rule line above TODOS is gone");
	assert.equal(lines[todosStart + 1], rule, "one rule still separates TODOS from LOG");
	assert.equal(lines.filter((line) => line === rule).length, 5, "five rules carry the seven panels");
	assert.ok(lines[lines.length - 5].startsWith(" LOG "), "LOG keeps its five lines at the foot");
	assert.equal(
		renderTodosPanel(makeBudgetSnapshot().todos, 80, 1, theme).length,
		1,
		"the one-line TODOS budget paints one line and never a negative height",
	);
});

test("renderSidebarPanel restores the TODOS rule at height 38 and fills 38", () => {
	// One row above the free-rule height, TODOS has its own budget line, so the
	// rule above it returns and the seven panels plus six rules fill the column.
	const lines = content(renderSidebarPanel(makeBudgetSnapshot(), 80, 38, theme, 0));
	const rule = SECTION_RULE_CHAR.repeat(80);
	assert.equal(lines.length, 38, "the column fills 38");
	const todosStart = lines.findIndex((line) => line === " TODOS");
	assert.ok(todosStart > 0, "TODOS paints its header at height 38");
	assert.equal(lines[todosStart - 1], rule, "the rule above TODOS is back at height 38");
	assert.equal(lines.filter((line) => line === rule).length, 6, "six rules carry the seven panels");
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
	const headers = [" AGENTS ", " STATUS ", " SESSION ", " WORKSPACE ", " MCP ", " TODOS ", " LOG "];
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
	assert.deepEqual(headers(30), ["AGENTS", "STATUS", "SESSION", "WORKSPACE", "MCP"]);
	assert.deepEqual(headers(24), ["AGENTS", "STATUS", "SESSION"]);
	assert.deepEqual(headers(16), ["AGENTS", "STATUS"]);
	assert.deepEqual(headers(12), ["AGENTS", "STATUS"]);
});

test("renderSidebarPanel paints the log panel last, below TODOS", () => {
	const painted = content(renderSidebarPanel(makeBudgetSnapshot(), 80, 40, theme, 0));
	const todos = painted.findIndex((line) => line === " TODOS");
	const log = painted.findIndex((line) => line.startsWith(" LOG "));
	assert.ok(todos > 0, "TODOS paints at height 40");
	assert.ok(log > todos, "the log panel sits below TODOS");
	assert.equal(log, painted.length - 5, "the log panel closes the column with its five lines");
});

test("renderSidebarPanel paints all seven headers in order at height 40", () => {
	// Height 40 fits the seven panels and their six rules, so every header paints
	// here and a swap of two of them cannot pass unseen.
	const lines = renderSidebarPanel(makeBudgetSnapshot(), 80, 40, theme, 0);
	assert.deepEqual(visibleHeaders(lines), [
		"AGENTS",
		"STATUS",
		"SESSION",
		"WORKSPACE",
		"MCP",
		"TODOS",
		"LOG",
	]);
	assert.equal(lines.length, 40, "the column uses the whole height");
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
