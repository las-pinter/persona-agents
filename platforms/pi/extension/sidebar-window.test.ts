/**
 * Column viewport window tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-window.test.ts
 *
 * Covers the clamp at both ends, the one-line step, the two marks, and the
 * rule that no line leaves the window without a mark.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	MIN_WINDOW_ROWS,
	aboveMark,
	belowMark,
	clampScrollOffset,
	scrollLimit,
	windowLines,
} from "./sidebar-window.ts";

/** A column of `count` numbered lines. */
function column(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `line ${index}`);
}

/** The mark carrying a count, or null when the line is content. */
function markCount(line: string): { side: "above" | "below"; count: number } | null {
	const match = /^… \+(\d+) (above|below)$/.exec(line);
	if (!match) return null;
	return { side: match[2] === "above" ? "above" : "below", count: Number(match[1]) };
}

test("a column that fits the window paints whole with no mark", () => {
	const lines = column(3);
	assert.deepEqual(windowLines(lines, 0, 10), lines);
	assert.deepEqual(windowLines(lines, 0, 3), lines, "an exact fit carries no mark");
});

test("the offset clamps to zero at the top and to the last line at the end", () => {
	assert.equal(clampScrollOffset(-5, 40, 10), 0, "a negative offset sits at the top");
	assert.equal(clampScrollOffset(Number.NaN, 40, 10), 0, "a non-finite offset sits at the top");
	assert.equal(scrollLimit(40, 10), 31, "the limit keeps the last line in the body");
	assert.equal(clampScrollOffset(99, 40, 10), 31, "a past-the-end offset sits at the bottom");
	assert.equal(clampScrollOffset(0, 4, 10), 0, "a short column has no scroll range");
});

test("an exactly fitting column has a zero limit and never moves", () => {
	assert.equal(scrollLimit(10, 10), 0, "an exact fit has no scroll range");
	assert.equal(scrollLimit(4, 10), 0, "a short column has no scroll range");
	assert.equal(clampScrollOffset(1, 10, 10), 0, "a press on an exact fit keeps the top line");
	assert.deepEqual(windowLines(column(10), 5, 10), column(10), "the whole column paints, no mark");
});

test("a taller column keeps the confirmed limit and reaches every line", () => {
	assert.equal(scrollLimit(11, 10), 2, "one extra line scrolls two steps, not one");
	assert.equal(scrollLimit(40, 10), 31, "forty lines in ten rows stop at 31");
	const total = 40;
	const lines = column(total);
	const seen = new Set<number>();
	for (let offset = 0; offset <= scrollLimit(total, 10); offset++) {
		for (const line of windowLines(lines, offset, 10)) {
			const index = lines.indexOf(line);
			if (index >= 0) seen.add(index);
		}
	}
	assert.equal(seen.size, total, "every line paints at some offset");
	assert.equal(windowLines(lines, scrollLimit(total, 10), 10).at(-1), "line 39");
});

test("the offset moves one line per step and both ends hold", () => {
	let offset = 0;
	for (let step = 0; step < 100; step++) offset = clampScrollOffset(offset + 1, 40, 10);
	assert.equal(offset, scrollLimit(40, 10), "down stops at the bottom");
	assert.deepEqual(
		windowLines(column(40), offset, 10).slice(1).at(-1),
		"line 39",
		"the last line paints at the bottom",
	);

	offset = clampScrollOffset(offset - 1, 40, 10);
	assert.equal(offset, scrollLimit(40, 10) - 1, "one press up moves exactly one line");

	for (let step = 0; step < 100; step++) offset = clampScrollOffset(offset - 1, 40, 10);
	assert.equal(offset, 0, "up stops at the top");
});

test("a scrolled window paints the mark above and the newest lines below it", () => {
	const window = windowLines(column(40), 5, 6);
	assert.deepEqual(window, ["… +5 above", "line 5", "line 6", "line 7", "line 8", "… +31 below"]);
});

test("a window at the top carries only the mark below", () => {
	const window = windowLines(column(40), 0, 4);
	assert.deepEqual(window, ["line 0", "line 1", "line 2", "… +37 below"]);
});

test("a window at the bottom carries only the mark above", () => {
	const window = windowLines(column(40), scrollLimit(40, 4), 4);
	assert.equal(window.length, 4, "the window stays four rows tall");
	assert.equal(window[0], `… +${scrollLimit(40, 4)} above`, "the top mark paints");
	assert.equal(window.at(-1), "line 39", "the last line paints at the bottom");
	assert.ok(!window.some((line) => markCount(line)?.side === "below"), "no bottom mark at the end");
});

test("one line leaves the window only through a mark", () => {
	const total = 57;
	const lines = column(total);
	for (const visible of [2, 3, 5, 13, 24, 40, 60]) {
		for (let offset = 0; offset <= total; offset += 7) {
			const window = windowLines(lines, offset, visible);
			assert.ok(window.length <= visible, `window ${visible} overflowed at ${offset}`);
			const above = markCount(window[0] ?? "")?.side === "above" ? (markCount(window[0])?.count ?? 0) : 0;
			const last = window.at(-1) ?? "";
			const below = markCount(last)?.side === "below" ? (markCount(last)?.count ?? 0) : 0;
			const body = window.filter((line) => markCount(line) === null);
			assert.equal(
				above + body.length + below,
				total,
				`visible ${visible} offset ${offset} lost a line: ${JSON.stringify(window)}`,
			);
			assert.deepEqual(
				body,
				lines.slice(above, above + body.length),
				"the body is contiguous, in column order",
			);
		}
	}
});

test("a two-row window paints both marks and no body", () => {
	assert.equal(MIN_WINDOW_ROWS, 2, "the floor is two rows");
	const window = windowLines(column(20), 4, 2);
	assert.deepEqual(window, ["… +4 above", "… +16 below"]);
});

test("a two-row window at either end paints one body row", () => {
	assert.deepEqual(
		windowLines(column(20), 0, 2),
		["line 0", "… +19 below"],
		"the top edge keeps the first line beside the single mark",
	);
	assert.deepEqual(
		windowLines(column(20), scrollLimit(20, 2), 2),
		["… +19 above", "line 19"],
		"the bottom edge keeps the last line beside the single mark",
	);
});

test("a one-row window paints nothing, so no line leaves without a mark", () => {
	for (const offset of [0, 1, 7, 19, 20]) {
		assert.deepEqual(
			windowLines(column(20), offset, 1),
			[],
			`offset ${offset} painted a window below the row floor`,
		);
	}
	assert.deepEqual(
		windowLines(column(20), 0, MIN_WINDOW_ROWS),
		["line 0", "… +19 below"],
		"the floor itself still paints",
	);
});

test("a three-row window paints one body row between the two marks", () => {
	assert.deepEqual(windowLines(column(20), 4, 3), ["… +4 above", "line 4", "… +15 below"]);
});

test("a zero-row window paints nothing", () => {
	assert.deepEqual(windowLines(column(20), 4, 0), []);
	assert.deepEqual(windowLines([], 0, 0), []);
});

test("an empty column paints no mark", () => {
	assert.deepEqual(windowLines([], 0, 5), []);
});

test("the dim style wraps each mark and nothing else", () => {
	const dim = (text: string): string => `<dim>${text}</dim>`;
	const window = windowLines(column(20), 4, 4, dim);
	assert.deepEqual(window, ["<dim>… +4 above</dim>", "line 4", "line 5", "<dim>… +14 below</dim>"]);
});

test("the marks name the hidden counts on each side", () => {
	assert.equal(aboveMark(3), "… +3 above");
	assert.equal(belowMark(9), "… +9 below");
	assert.equal(aboveMark(-2), "… +0 above", "a negative count floors at zero");
});
