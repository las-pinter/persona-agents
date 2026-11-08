/**
 * LOG panel tests: the five fixed lines, the wrap rule, the cut, and the slot.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-render-ask-log.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	LOG_PANEL_LINES,
	SECTION_RULE_CHAR,
	askLogLines,
	renderAskLogPanel,
	renderSidebarPanel,
} from "./sidebar-render.ts";
import {
	assertFits,
	content,
	makeAskLogRows,
	makeBudgetSnapshot,
	theme,
} from "./sidebar-render-fixtures.ts";

const RULE = SECTION_RULE_CHAR.repeat(80);

/** The painted LOG block: the header and its text lines, up to the next rule. */
function logBlock(lines: string[]): number {
	const start = lines.findIndex((line) => line.trim() === "LOG 4");
	assert.ok(start >= 0, "the LOG header paints");
	const rest = lines.slice(start + 1);
	const stop = rest.findIndex((line) => line === RULE);
	return (stop < 0 ? rest.length : stop) + 1;
}

// --- the panel shape ---------------------------------------------------------

test("an empty ring paints the header and the placeholder in five lines", () => {
	const lines = content(renderAskLogPanel([], 80, theme));
	assert.equal(lines.length, LOG_PANEL_LINES);
	assert.deepEqual(lines, [" LOG 0", "(no child asks)", "", "", ""]);
	assertFits(renderAskLogPanel([], 80, theme), 80);
});

test("a missing ring paints the same five lines as an empty ring", () => {
	assert.deepEqual(
		content(renderAskLogPanel(undefined, 80, theme)),
		content(renderAskLogPanel([], 80, theme)),
	);
});

test("a ring of four short rows keeps five lines and paints the newest first", () => {
	const rows = makeAskLogRows().map((row) => ({ ...row, text: `${row.text.slice(0, 8)} implementer/bash` }));
	const lines = content(renderAskLogPanel(rows, 45, theme));
	assert.equal(lines.length, LOG_PANEL_LINES);
	assert.deepEqual(lines, [
		" LOG 4",
		"10:00:04 implementer/bash",
		"10:00:03 implementer/bash",
		"10:00:02 implementer/bash",
		"10:00:01 implementer/bash",
	]);
});

// --- the wrap and the cut ----------------------------------------------------

test("at width 45 the newest expiry row keeps place=slot whole", () => {
	assert.equal(content(askLogLines(makeAskLogRows(), 45))[0], " LOG 4");
	const textLines = content(askLogLines(makeAskLogRows(), 45)).slice(1);
	// The wrap breaks on whitespace, so the flag token survives in one piece.
	assert.ok(
		textLines.some((line) => line.includes("place=slot")),
		`no line carries the whole token: ${JSON.stringify(textLines)}`,
	);
	for (const line of textLines) {
		assert.ok(!line.endsWith("place="), `the token split at the end: ${JSON.stringify(line)}`);
		assert.ok(!line.startsWith("slot"), `the token split at the start: ${JSON.stringify(line)}`);
	}
	assertFits(askLogLines(makeAskLogRows(), 45), 45);
});

test("a ring of five rows wraps the newest row at width 45", () => {
	const rows = [
		...makeAskLogRows(),
		{
			askId: "root#older",
			phase: "expiry" as const,
			at: "2026-11-07T10:00:00.000Z",
			text: "10:00:00 tester/edit waiting=0 shown=none place=queue parked=0 surface=no",
		},
	];
	// The ring holds five rows; the panel paints the four text lines it has.
	assert.deepEqual(content(renderAskLogPanel(rows, 45, theme)), [
		" LOG 5",
		"10:00:04 implementer/bash waiting=0",
		"shown=none place=slot parked=0 surface=yes",
		"10:00:03 tester/bash waiting=0 shown=this",
		"place=slot parked=1 surface=yes",
	]);
});

test("a ring of four long rows fills the four text lines and stops there", () => {
	const lines = content(renderAskLogPanel(makeAskLogRows(), 45, theme));
	assert.equal(lines.length, 5, "the panel keeps its five lines");
	// At width 45 rows 0 and 1 take two wrapped lines each, so the four fill.
	assert.ok(lines[3]?.includes("shown=this"), "row 1 paints its first line");
	assert.ok(!lines.some((line) => line.includes("10:00:02")), "row 2 never paints");
	assert.ok(!lines.some((line) => line.includes("place=queue")), "row 2 never paints");
});

test("at width 40 the budget cuts row 0 after three lines and row 1 after one", () => {
	// Row 0 wraps to three lines and row 1 needs three. The four-line budget
	// keeps row 0 whole, gives row 1 its first line, then stops.
	const body = content(askLogLines(makeAskLogRows(), 40, theme));
	assert.equal(body.length, LOG_PANEL_LINES, "the budget stops the list at five lines");
	assert.deepEqual(body, [
		" LOG 4",
		"10:00:04 implementer/bash waiting=0",
		"shown=none place=slot parked=0",
		"surface=yes",
		"10:00:03 tester/bash waiting=0",
	]);
	assert.equal(
		body[4],
		"10:00:03 tester/bash waiting=0",
		"the fifth line is the first wrapped line of the second row",
	);
	assert.ok(!body.some((line) => line.includes("shown=this")), "the second row's second line never paints");
	assert.ok(!body.some((line) => line.includes("10:00:02")), "the third row never paints");
	assert.deepEqual(
		content(renderAskLogPanel(makeAskLogRows(), 40, theme)),
		body,
		"the panel paints the same five lines as the budget body",
	);
});

for (const width of [0, 1, 10, 20, 45, 120]) {
	test(`the LOG panel fits width ${width}`, () => {
		const lines = renderAskLogPanel(makeAskLogRows(), width, theme);
		assert.equal(lines.length, LOG_PANEL_LINES, "the panel is five lines at every width");
		assertFits(lines, width);
	});
}

// --- the slot and the height budget ------------------------------------------

test("the LOG panel keeps its five lines before the panels below shrink", () => {
	for (const height of [16, 24, 30]) {
		const block = logBlock(content(renderSidebarPanel(makeBudgetSnapshot(), 80, height, theme, 0)));
		assert.equal(block, 5, `LOG paints five lines at height ${height}`);
	}
});

test("a short column drops the right number of lines from the panels below", () => {
	const at = (height: number): string[] => renderSidebarPanel(makeBudgetSnapshot(), 80, height, theme, 0);
	const tall = at(30);
	const medium = at(16);
	const short = at(12);

	// AGENTS 4, STATUS 4, LOG 5, SESSION 9, and three rules paint at height 30.
	assert.equal(tall.length, 25, "the reference column paints 25 of 30 lines");
	// SESSION 9 lines and its rule leave at height 16.
	assert.equal(medium.length, 25 - (9 + 1));
	// LOG 5 lines and its rule leave at height 12.
	assert.equal(short.length, 25 - (9 + 1) - (5 + 1));
	assert.ok(tall.some((line) => line.includes(" SESSION ")), "SESSION paints at height 30");
	assert.ok(!medium.some((line) => line.includes(" SESSION ")), "SESSION drops at height 16");
	assert.ok(medium.some((line) => line.includes(" LOG ")), "LOG still paints at height 16");
	assert.ok(!short.some((line) => line.includes(" LOG ")), "LOG drops at height 12");
});
