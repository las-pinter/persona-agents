/**
 * Offline tests for the column line fit.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/sidebar-line.test.ts
 *
 * Covers the clip that every renderer uses and the pad that the compositor
 * uses. Every case measures cells, never string length.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipLine, padLine } from "./sidebar-line.ts";

test("clipLine clips to the width and never pads", () => {
	assert.equal(visibleWidth(clipLine("abc", 10)), 3, "a short line keeps its own cells");
	assert.equal(clipLine("abc", 10), "abc", "no pad cell is added");
	assert.equal(visibleWidth(clipLine("x".repeat(40), 10)), 10, "a long line clips to the width");
	assert.equal(clipLine("abc", 0), "", "a zero width paints nothing");
});

test("padLine fills every width exactly", () => {
	for (const width of [1, 2, 3, 4, 6]) {
		assert.equal(visibleWidth(padLine("abc", width)), width, `"abc" is not ${width} cells`);
		assert.equal(
			visibleWidth(padLine("日本語", width)),
			width,
			`the wide-char line is not ${width} cells`,
		);
		assert.equal(
			visibleWidth(padLine("x".repeat(40), width)),
			width,
			`the long line is not ${width} cells`,
		);
	}
});

test("padLine pads a narrow clip to the width", () => {
	// The clip drops a wide char that cannot fit beside the ellipsis, so it
	// hands back one cell, and the pad must fill the second.
	assert.equal(visibleWidth(clipLine("日本語", 2)), 1, "the clip keeps the ellipsis alone");
	const padded = padLine("日本語", 2);
	assert.equal(visibleWidth(padded), 2, "the pad fills the row the clip left short");
	assert.ok(padded.endsWith(" "), "the pad cell closes the row");
});

test("padLine counts a styled line by its cells, not its bytes", () => {
	const styled = "\x1b[31mred\x1b[0m";
	assert.equal(visibleWidth(styled), 3, "the fixture carries three cells");
	assert.equal(visibleWidth(padLine(styled, 6)), 6, "the pad counts the cells");
	assert.equal(padLine(styled, 6), `${styled}   `, "the escape codes stay in place");
});
