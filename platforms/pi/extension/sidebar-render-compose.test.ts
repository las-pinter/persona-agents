/**
 * Sidebar renderer composition and fitting tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-render-compose.test.ts
 *
 * Covers panel composition, width fitting, theme fallback, and the detail
 * overlay. The repaint signature and the selection walk hold their own test
 * files.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	type SidebarSnapshot,
	type SidebarTheme,
	type StatusSnapshot,
	type StudyRowSnapshot,
	AGENTS_PAD_MIN,
	SECTION_RULE_CHAR,
	STUDY_STATUS_SHOWN,
	TODOS_ROWS_SHOWN,
	formatRow,
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
	makeAskLogRows,
	makeFullSnapshot,
	makeNode,
	makeSession,
	makeSnapshot,
	makeWorkspace,
	theme,
} from "./sidebar-render-fixtures.ts";

const HEADER_RE = /^ (AGENTS|STUDY STATUS|LOG|SESSION|WORKSPACE|MCP|TODOS) $/;
/** The panel headers a composed column paints, in column order. */
function visibleHeaders(lines: string[]): string[] {
	return lines
		.filter((line) => HEADER_RE.test(line))
		.map((line) => line.trim());
}

// --- theme fallback ----------------------------------------------------------

test("a theme with no methods still renders a plain header", () => {
	const plain: SidebarTheme = {};
	const lines = renderAgentTreePanel([], 40, plain, 0);
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

	const lines = renderAgentTreePanel([node], 40, empty, 0);

	assert.deepEqual(calls, []);
	assert.equal(lines[0], " AGENTS ");
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

	renderAgentTreePanel([node], 40, partial, 0);

	assert.ok(calls.includes("accent"));
	assert.ok(!calls.includes("muted"));
});

// --- composition and width ---------------------------------------------------

test("renderSidebarPanel stacks AGENTS first", () => {
	const child = makeNode({ runId: "c1", parentRunId: "root", depth: 1, agent: "tester" });
	const root = makeNode({ runId: "root", depth: 0, agent: "orchestrator", children: [child] });
	const lines = renderSidebarPanel(makeSnapshot({ tree: [root] }), 80, theme, 0);
	assert.ok(lines[0]?.startsWith(" AGENTS "));
	assert.ok(lines.some((line) => line.includes(" SESSION ")));
	assert.ok(lines.some((line) => line.includes(" WORKSPACE ")));
});

test("renderSidebarPanel paints the seven panels in the declared order", () => {
	// Every panel paints now that no height drops one, so TODOS and LOG must
	// follow MCP and a swap of the last two cannot pass unseen.
	const lines = renderSidebarPanel(makeFullSnapshot(), 80, theme, 0);
	assert.deepEqual(visibleHeaders(lines), [
		"AGENTS",
		"STUDY STATUS",
		"SESSION",
		"WORKSPACE",
		"MCP",
		"TODOS",
		"LOG",
	]);
	const rule = SECTION_RULE_CHAR.repeat(80);
	assert.equal(lines.filter((line) => line === rule).length, 6, "six rules carry the seven panels");
});

test("renderStatusPanel paints the empty line for a missing status", () => {
	const lines = renderStatusPanel(undefined, 80, theme);
	assert.equal(lines.length, 2, "one title and one empty line");
	assert.equal(lines[0], " STUDY STATUS ");
	assert.deepEqual(lines.slice(1), ["no study tracked"]);
	assertFits(lines, 80);
});

test("renderStatusPanel paints one row per study with glyph, name, brief count, and age", () => {
	const status: StatusSnapshot = {
		studies: [{ name: "gate-status-surface", stage: "active", briefs: 4, updated: "2026-01-05" }],
	};
	const now = Date.parse("2026-01-05T01:00:00.000Z");
	const lines = renderStatusPanel(status, 80, theme, now);
	assert.equal(lines[0], " STUDY STATUS ", "the title paints once");
	assert.equal(lines[1], "● gate-status-surface · 4 · 1h00m");
	assertFits(renderStatusPanel(status, 20, theme, now), 20);
});

test("renderStatusPanel tells a blocked study apart with the warning glyph", () => {
	const status: StatusSnapshot = {
		studies: [{ name: "held-study", stage: "blocked", briefs: 0, updated: null }],
	};
	const lines = renderStatusPanel(status, 80, theme);
	assert.equal(lines[1], "⚠ held-study · 0 · -", "a missing value prints the fallback word");
});

test("renderStatusPanel caps the list at four studies and marks the overflow", () => {
	assert.equal(STUDY_STATUS_SHOWN, 4, "the cap is four studies");
	const studies = Array.from({ length: 6 }, (_value, index) => ({
		name: `study-${index}`,
		stage: "active",
		briefs: index,
		updated: `2026-01-0${index + 1}`,
	}));
	const lines = renderStatusPanel(
		{ studies },
		80,
		theme,
		Date.parse("2026-01-01T00:00:00.000Z"),
	);
	assert.equal(lines.length, 6, "a title, four rows, and the overflow marker");
	assert.equal(lines[lines.length - 1], "… +2 more");
});

test("renderStatusPanel paints no ask row", () => {
	const status: StatusSnapshot = {
		studies: [{ name: "alpha", stage: "active", briefs: 1, updated: "2026-01-05" }],
	};
	const lines = renderStatusPanel(status, 80, theme, Date.parse("2026-01-05T00:00:00.000Z"));
	assert.equal(lines.length, 2, "the header and one study row only");
});

test("formatRow joins a label and an optional second part with one separator", () => {
	const trim = (line: string): string => line.trimEnd();
	assert.equal(trim(formatRow("alpha", ["4"], 80)), "alpha · 4");
	assert.equal(trim(formatRow("alpha", [], 80)), "alpha", "no separator without a part");
	assert.equal(trim(formatRow("alpha", [null], 80)), "alpha · -", "a missing part prints the fallback word");
	assert.equal(trim(formatRow("", ["4"], 80)), "- · 4", "a missing label prints the fallback word");
	assertFits([formatRow("alpha", ["4"], 4)], 4);
});

test("a full-width dim rule separates panels, never above the first or below the last", () => {
	// Every panel paints content in this column, so a blank line above a rule
	// is a layout fault and not a panel's own pad row.
	const lines = renderSidebarPanel(makeFullSnapshot(), 80, theme, 0);
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
		assert.ok(
			(lines[index - 1] ?? "").trim().length > 0,
			"a rule sits right after a painted panel line",
		);
	}
});

test("the section rule is clipped at width 0 and 1 and still fits", () => {
	const atOne = renderSidebarPanel(makeSnapshot(), 1, theme, 0);
	assertFits(atOne, 1);
	assert.equal(
		atOne.filter((line) => line === SECTION_RULE_CHAR).length,
		6,
		"six rules are drawn at width 1",
	);

	const atZero = renderSidebarPanel(makeSnapshot(), 0, theme, 0);
	assertFits(atZero, 0);
	assert.ok(atZero.every((line) => line === ""), "every line is empty at width 0");
});

test("a short tree pads AGENTS to the minimum", () => {
	const root = makeNode({ runId: "root", agent: "orchestrator" });
	const lines = renderAgentTreePanel([root], 80, theme, 0);
	assert.equal(lines.length, AGENTS_PAD_MIN, "a one-node tree pads to the minimum");
	assert.ok((lines[1] ?? "").includes("orchestrator"), "the node line paints below the header");
	assert.equal(lines[AGENTS_PAD_MIN - 1], "", "AGENTS pads with a blank line");
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
	const lines = renderSidebarPanel(snapshot, 18, theme, 0);
	assert.ok(lines.length > 0);
	assertFits(lines, 18);
});

test("a long task clips with an ellipsis", () => {
	const node = makeNode({
		runId: "n1",
		agent: "orchestrator",
		task: "this task preview is much too long to fit in the narrow column",
	});
	const lines = renderAgentTreePanel([node], 20, theme, 0);
	assert.ok(lines[1]?.includes("…"));
	assertFits(lines, 20);
});

// --- width edge cases --------------------------------------------------------

for (const width of [0, 1, 10, 20, 45, 120]) {
	test(`every panel fits width ${width} and does not throw`, () => {
		const node = makeNode({ runId: "n1", agent: "orchestrator" });
		const panels = [
			renderAgentTreePanel([node], width, theme, 0),
			renderSessionPanel(makeSession(), width, theme),
			renderWorkspacePanel(makeWorkspace(), width, theme),
			renderMcpPanel([{ name: "context7", configured: true, connected: true, status: "connected" }], width, theme),
			renderTodosPanel([{ id: "1", text: "do it", done: false }], width, theme),
			renderSidebarPanel(
				makeSnapshot({
					tree: [node],
					askLog: makeAskLogRows(),
					mcp: [{ name: "context7", configured: true, connected: true, status: "connected" }],
					todos: [{ id: "1", text: "do it", done: false }],
				}),
				width,
				theme,
				0,
			),
		];
		for (const lines of panels) assertFits(lines, width);
	});
}

test("renderSidebarPanel paints every todo row up to the cap", () => {
	const snapshot = makeSnapshot({
		tree: [],
		todos: Array.from({ length: TODOS_ROWS_SHOWN }, (_value, index) => ({
			id: String(index),
			text: `todo ${index}`,
			done: false,
		})),
	});
	const lines = renderSidebarPanel(snapshot, 80, theme, 0);
	assert.ok(lines.some((line) => line.includes("todo 5")), "the sixth item must render under the cap");
	assert.ok(!lines.some((line) => line.includes("more")), "no overflow marker while the list fits the cap");
});

test("renderSidebarPanel paints the turn marker from the snapshot", () => {
	const snapshot = makeSnapshot({
		tree: [],
		todos: [{ id: "1", text: "open", done: false }],
		todosTurnMarker: true,
	});
	const withMarker = renderSidebarPanel(snapshot, 80, theme, 0);
	assert.ok(withMarker.some((line) => line.includes("— new turn —")));

	const withoutMarker = renderSidebarPanel(
		makeSnapshot({ tree: [], todos: [{ id: "1", text: "open", done: false }] }),
		80,
		theme,
		0,
	);
	assert.ok(!withoutMarker.some((line) => line.includes("— new turn —")));
});

test("renderSidebarPanel paints the log panel last, below TODOS", () => {
	const painted = renderSidebarPanel(makeFullSnapshot(), 80, theme, 0);
	const todos = painted.findIndex((line) => line === " TODOS ");
	const log = painted.findIndex((line) => line.trim() === "LOG");
	assert.ok(todos > 0, "TODOS paints above the log panel");
	assert.ok(log > todos, "the log panel sits below TODOS");
	assert.equal(log, painted.length - 5, "the log panel closes the column with its five lines");
});

test("the column paints all seven panels in order with no height", () => {
	// No height goes in, so every panel paints at its own height and a swap of
	// two headers cannot pass unseen.
	const lines = renderSidebarPanel(makeFullSnapshot(), 80, theme, 0);
	assert.deepEqual(visibleHeaders(lines), [
		"AGENTS",
		"STUDY STATUS",
		"SESSION",
		"WORKSPACE",
		"MCP",
		"TODOS",
		"LOG",
	]);
	assert.ok(lines.some((line) => line.trimEnd() === " TODOS"), "TODOS paints");
	assert.ok(lines.some((line) => line.trim() === "LOG"), "LOG paints at the foot");
});

// --- the study list inside the composed column -------------------------------

/** Study rows in the panel order the data layer produces: newest first. */
function makeStudies(count: number): StudyRowSnapshot[] {
	return Array.from({ length: count }, (_value, index) => ({
		name: `study-${index}`,
		stage: index === 1 ? "blocked" : "active",
		briefs: index,
		updated: `2026-01-0${index + 1}`,
	}));
}

/** A budget snapshot plus the given study list and MCP usage totals. */
function makeStudySnapshot(count: number): SidebarSnapshot {
	return {
		...makeFullSnapshot(),
		mcpUsage: { context7: 2, exa: 1 },
		status: { studies: makeStudies(count) },
	};
}

test("a full study list paints four rows and no overflow marker", () => {
	const lines = renderSidebarPanel(makeStudySnapshot(4), 80, theme, 0);
	assert.deepEqual(visibleHeaders(lines), [
		"AGENTS",
		"STUDY STATUS",
		"SESSION",
		"WORKSPACE",
		"MCP",
		"TODOS",
		"LOG",
	]);
	for (let index = 0; index < 4; index++) {
		assert.ok(lines.some((line) => line.includes(`study-${index}`)), `study-${index} paints`);
	}
	assert.ok(!lines.some((line) => line.includes("more")), "four studies need no overflow marker");
	assert.equal(lines[lines.length - 5].trim(), "LOG", "LOG keeps its five lines at the foot");
});

test("six studies paint the cap and the overflow marker inside the column", () => {
	const lines = renderSidebarPanel(makeStudySnapshot(6), 80, theme, 0);
	const rows = lines.filter((line) => /study-\d/.test(line));
	assert.equal(rows.length, STUDY_STATUS_SHOWN, "four study rows paint");
	assert.equal(lines.filter((line) => line.includes("… +2 more")).length, 1, "one overflow marker paints");
	assert.ok(lines.some((line) => line.trimEnd() === " TODOS"), "TODOS still paints");
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
