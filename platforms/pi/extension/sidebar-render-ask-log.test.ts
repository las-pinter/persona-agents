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
	LOG_HEADER_RE,
	assertFits,
	content,
	makeAskLogRows,
	makeBudgetSnapshot,
	theme,
} from "./sidebar-render-fixtures.ts";

const RULE = SECTION_RULE_CHAR.repeat(80);

/** The painted LOG block: the header and its text lines, up to the next rule. */
function logBlock(lines: string[]): number {
	const start = lines.findIndex((line) => line.trim() === "LOG");
	assert.ok(start >= 0, "the LOG header paints");
	const rest = lines.slice(start + 1);
	const stop = rest.findIndex((line) => line === RULE);
	return (stop < 0 ? rest.length : stop) + 1;
}

// --- the panel shape ---------------------------------------------------------

test("an empty ring paints the header and the placeholder in five lines", () => {
	const lines = content(renderAskLogPanel([], 80, theme));
	assert.equal(lines.length, LOG_PANEL_LINES);
	assert.deepEqual(lines, [" LOG", "(no log events)", "", "", ""]);
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
		" LOG",
		"10:00:04 implementer/bash",
		"10:00:03 implementer/bash",
		"10:00:02 implementer/bash",
		"10:00:01 implementer/bash",
	]);
});

test("a full ring of 50 rows paints the plain header", () => {
	// The trim at the cap is proven by "the ring stops at the cap" in
	// ask-record.test.ts; this case proves a full ring paints no count.
	const rows = Array.from({ length: 50 }, (_value, index) => ({
		kind: "ask" as const,
		askId: `root#full-${index}`,
		phase: "expiry" as const,
		at: "2026-11-07T10:00:00.000Z",
		text: `10:00:00 tester/bash waiting=0 row=${index}`,
	}));
	const lines = content(renderAskLogPanel(rows, 80, theme));
	assert.equal(lines.length, LOG_PANEL_LINES, "the full ring keeps the five-line panel");
	assert.equal(lines[0], " LOG", "a full ring paints the plain header");
	assertFits(renderAskLogPanel(rows, 80, theme), 80);
});

// --- the wrap and the cut ----------------------------------------------------

test("a plain line in the ring paints beside the ask rows", () => {
	const rows = [
		{
			kind: "log" as const,
			askId: "",
			phase: "settle" as const,
			at: "2026-11-07T10:00:05.000Z",
			text: "agent-stack: forced paint failed",
		},
		{
			kind: "ask" as const,
			askId: "root#ask",
			phase: "expiry" as const,
			at: "2026-11-07T10:00:04.000Z",
			text: "10:00:04 implementer/bash place=slot",
		},
	];
	const lines = content(renderAskLogPanel(rows, 60, theme));
	assert.equal(lines.length, LOG_PANEL_LINES, "the panel keeps its fixed height");
	assert.equal(lines[0], " LOG", "the header carries no count");
	assert.equal(lines[1], "agent-stack: forced paint failed", "the plain line paints whole");
	assert.equal(lines[2], "10:00:04 implementer/bash place=slot", "the ask row text is unchanged");
	assert.equal(lines[3], "", "the short ring pads to five lines");
	assertFits(renderAskLogPanel(rows, 60, theme), 60);
});

test("at width 45 the newest expiry row keeps place=slot whole", () => {
	assert.equal(content(askLogLines(makeAskLogRows(), 45))[0], " LOG");
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
			kind: "ask" as const,
			askId: "root#older",
			phase: "expiry" as const,
			at: "2026-11-07T10:00:00.000Z",
			text: "10:00:00 tester/edit waiting=0 shown=none place=queue parked=0 surface=no",
		},
	];
	// The ring holds five rows; the panel paints the four text lines it has.
	assert.deepEqual(content(renderAskLogPanel(rows, 45, theme)), [
		" LOG",
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
		" LOG",
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

test("the LOG panel keeps its five lines at the foot of the column", () => {
	for (const height of [36, 40, 60]) {
		const lines = content(renderSidebarPanel(makeBudgetSnapshot(), 80, height, theme, 0));
		assert.equal(logBlock(lines), 5, `LOG paints five lines at height ${height}`);
		assert.notEqual(lines[lines.length - 1], RULE, "no rule paints below the log panel");
	}
});

test("a short column shrinks TODOS first, then drops LOG before MCP", () => {
	const at = (height: number): string[] => content(renderSidebarPanel(makeBudgetSnapshot(), 80, height, theme, 0));
	const tall = at(40);
	const twoTodoLines = at(37);
	const oneTodoLine = at(36);
	const joined = at(35);
	const noTodos = at(34);
	const noLog = at(33);
	const short = at(27);

	// At 40 TODOS still gets five lines and the log keeps five at the foot.
	assert.equal(tall.length, 40, "the column uses the whole height");
	assert.ok(tall.some((line) => line === " TODOS"), "TODOS paints at height 40");
	assert.equal(logBlock(tall), 5, "LOG paints five lines at height 40");

	// At 37 TODOS has two budget lines and the log still paints below it.
	assert.equal(twoTodoLines.length, 37, "the column fills height 37");
	assert.equal(twoTodoLines.filter((line) => line === " TODOS").length, 1, "TODOS paints one header");
	assert.equal(logBlock(twoTodoLines), 5, "LOG paints five lines at height 37");

	// At 36 the one line TODOS has is its own budget row, with a rule above it.
	assert.equal(oneTodoLine.length, 36, "the column fills height 36");
	assert.equal(oneTodoLine.filter((line) => line === " TODOS").length, 1, "TODOS takes one line at height 36");

	// At 35 TODOS takes the freed rule line as its header, and the log still fits.
	assert.equal(joined.length, 35, "the column fills height 35");
	assert.equal(joined.filter((line) => line === " TODOS").length, 1, "TODOS takes the freed line at height 35");
	assert.equal(logBlock(joined), 5, "LOG paints five lines at height 35");

	// At 34 TODOS has no line left, and the log still paints below MCP.
	assert.ok(!noTodos.some((line) => line === " TODOS"), "TODOS shrinks away at height 34");
	assert.equal(logBlock(noTodos), 5, "LOG still paints its five lines at height 34");

	// At 33 the log is the first whole panel to leave, and MCP stays.
	assert.ok(!noLog.some((line) => LOG_HEADER_RE.test(line.trim())), "LOG drops at height 33");
	assert.ok(noLog.some((line) => line === " MCP"), "MCP still paints at height 33");

	// At 27 the log and MCP are gone, and the panels above them stay in order.
	assert.ok(!short.some((line) => LOG_HEADER_RE.test(line.trim())), "LOG stays dropped at height 27");
	assert.ok(!short.some((line) => line === " MCP"), "MCP drops at height 27");
	assert.ok(short.some((line) => line === " WORKSPACE"), "WORKSPACE still paints at height 27");
});
