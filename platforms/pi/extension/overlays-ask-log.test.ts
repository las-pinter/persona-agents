/**
 * `/ask-log` view tests: the frame shape, the wrap, the width, and the clamp.
 *
 * `askLogViewRows` is pure, so these tests feed it rows and numbers directly.
 * The mount, the keys, and the mode gate live in `tree-ui.test.ts`.
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/overlays-ask-log.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MAX_ASK_VIEW_ROWS, askLogViewRows } from "./overlays.ts";
import type { AskLogRow } from "./sidebar-render.ts";

/** The rule glyph the frame repeats. */
const RULE = "─";

/** Ask rows, newest first, as `sidebar-data.ts` writes them. */
function makeRows(count: number): AskLogRow[] {
	return Array.from({ length: count }, (_value, index) => {
		const clock = `10:00:${String(count - index).padStart(2, "0")}`;
		return {
			kind: "ask" as const,
			askId: `root#${clock}`,
			phase: "arrival" as const,
			at: `2026-11-07T${clock}.000Z`,
			text: `${clock} implementer/bash waiting=0 shown=none place=slot`,
		};
	});
}

/** The last frame line: the nav line, with the padding trimmed. */
function navLine(lines: string[]): string {
	const line = lines.at(-1);
	assert.ok(line !== undefined, "the frame carries a nav line");
	return line.trimEnd();
}

describe("ask log view frame", () => {
	test("the frame is a header, two rules, the rows, and a nav line", () => {
		const rows = makeRows(3);
		const lines = askLogViewRows(rows, 60, 0, 10);

		assert.equal(lines.length, 3 + 4, "header, rule, three rows, rule, nav");
		assert.equal(lines[0].trimEnd(), "  ASK LOG — 3 events · newest first", "the title sits on the row indent");
		assert.equal(lines[1].trimEnd(), RULE.repeat(59), "the first rule spans the width minus one");
		assert.equal(lines.at(-2)?.trimEnd(), RULE.repeat(59), "the closing rule spans the width minus one");
		const wide = askLogViewRows(rows, 70, 0, 10);
		assert.equal(
			navLine(wide),
			"(line 1/3) · ↑/↓/PgUp/PgDn scroll · g/G top/end · q/Esc close",
			"the page counter leads the nav line",
		);

		const body = lines.slice(2, -2);
		assert.deepEqual(
			body.map((line) => line.trimEnd()),
			[
				"  10:00:03 implementer/bash waiting=0 shown=none place=slot",
				"  10:00:02 implementer/bash waiting=0 shown=none place=slot",
				"  10:00:01 implementer/bash waiting=0 shown=none place=slot",
			],
			"the body is the ring in order, newest first, indented two spaces",
		);
	});

	test("a plain line in the ring keeps its text and breaks no row", () => {
		const rows: AskLogRow[] = [
			{
				kind: "log",
				askId: "",
				phase: "settle",
				at: "2026-11-07T10:00:04.000Z",
				text: "agent-stack: forced paint failed: the host said no",
			},
			...makeRows(2),
		];
		const lines = askLogViewRows(rows, 60, 0, 10);

		assert.equal(lines[0].trimEnd(), "  ASK LOG — 3 events · newest first", "the title counts every entry");
		assert.deepEqual(
			lines.slice(2, -2).map((line) => line.trimEnd()),
			[
				"  agent-stack: forced paint failed: the host said no",
				"  10:00:02 implementer/bash waiting=0 shown=none place=slot",
				"  10:00:01 implementer/bash waiting=0 shown=none place=slot",
			],
			"the plain line and both ask rows keep their text",
		);
	});

	test("the rule stops at 96 cells on a wide width and never passes it", () => {
		const wide = askLogViewRows(makeRows(1), 200, 0, 10);
		assert.equal(wide[1].trimEnd(), RULE.repeat(96), "the rule caps at 96 cells");
		assert.ok(wide.every((line) => visibleWidth(line) <= 200));
	});

	test("an empty or missing ring paints the placeholder between the two rules", () => {
		const lines = askLogViewRows([], 60, 0, 10);

		assert.equal(lines.length, 5, "header, rule, placeholder, rule, nav");
		assert.match(lines[0], /ASK LOG — 0 events · newest first\s*$/);
		assert.equal(lines[1].trimEnd(), RULE.repeat(59));
		assert.equal(lines[2].trimEnd(), "  (no child asks)", "the placeholder sits on the row indent");
		assert.equal(lines.at(-2)?.trimEnd(), RULE.repeat(59), "the empty frame still carries one closing rule");
		assert.match(navLine(lines), /^\(line 1\/1\) ·/);

		assert.deepEqual(askLogViewRows(undefined, 60, 0, 10), lines, "a missing ring paints the same frame");
		assert.deepEqual(askLogViewRows(null, 60, 0, 10), lines, "a null ring paints the same frame");
	});

	test("at width 20 every line fits and every token below 20 cells stays whole", () => {
		const lines = askLogViewRows(makeRows(4), 20, 0, 10);

		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 20, `line exceeds 20 cells: ${JSON.stringify(line)}`);
		}
		const joined = lines.join("\n");
		for (const token of ["10:00:04", "implementer/bash", "waiting=0", "shown=none", "place=slot"]) {
			assert.ok(joined.includes(token), `the wrap split the token ${token}`);
		}

		// ASK_WRAP_MIN plus the row indent is the narrowest width the body wraps to.
		const narrowest = askLogViewRows(makeRows(4), 12, 0, 10);
		assert.match(
			navLine(narrowest),
			/^\(line \d+\/\d+\)/,
			"the whole page counter leads at the narrowest width",
		);
		assert.ok(!navLine(narrowest).includes("top/end"), "the narrow frame cut the key hints, not the counter");
	});

	test("the offset clamps to the last full page and the nav line reports it", () => {
		const rows = makeRows(6);

		const first = askLogViewRows(rows, 60, 0, 4);
		assert.match(navLine(first), /^\(line 1\/6\) ·/);

		// Six body rows in a four-row view leave two rows of travel.
		const last = askLogViewRows(rows, 60, 99, 4);
		assert.equal(last.length, 2 + 4 + 2, "a full page of body rows plus the frame");
		assert.match(navLine(last), /^\(line 3\/6\) ·/, "the offset stopped at the last full page");
		assert.match(last[2], /10:00:04/, "the page starts at the fourth body row");
	});

	test("a view height of 100 is the clamp, and a smaller height shows fewer rows", () => {
		const rows = makeRows(MAX_ASK_VIEW_ROWS + 10);
		const full = askLogViewRows(rows, 60, 0, MAX_ASK_VIEW_ROWS);
		assert.equal(full.length, 2 + MAX_ASK_VIEW_ROWS + 2, "the default view height is the clamp");

		const narrow = askLogViewRows(rows, 60, 0, 5);
		assert.equal(narrow.length, 2 + 5 + 2, "the caller's height wins below the clamp");
	});

	test("one row that wraps to two lines takes two offsets", () => {
		const long: AskLogRow = {
			kind: "ask",
			askId: "root#a",
			phase: "arrival",
			at: "2026-11-07T10:00:09.000Z",
			text: "10:00:09 implementer/bash waiting=0 shown=none place=slot parked=0 surface=yes",
		};
		const rows = [long];
		const chunks = wrapTextWithAnsi(long.text, 58);
		assert.equal(chunks.length, 2, "the fixture row wraps to two lines at width 60");

		const lines = askLogViewRows(rows, 60, 1, 1);
		assert.equal(lines[2].trimEnd(), `  ${chunks[1]}`, "the second offset starts at the second wrapped line");
		assert.match(navLine(lines), /^\(line 2\/2\) ·/);
	});
});
