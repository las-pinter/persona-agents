/**
 * The review panel (platforms/pi/ui/panel.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-panel.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_LINES, ReviewPanel } from "../platforms/pi/ui/panel.ts";

/** A theme that changes nothing, so a rendered line is plain text. */
const PLAIN = { fg: (_color: string, text: string): string => text };

/** A click on the panel, in the shape Pi sends. */
const CLICK = {
	type: "click" as const,
	button: "left" as const,
	x: 3,
	y: 0,
	screenX: 3,
	screenY: 12,
	width: 60,
	height: 1,
	shift: false,
	alt: false,
	ctrl: false,
};

const REVIEW = ["## Summary", "Reviewed the change.", "", "## Risk list", "- a risk", "", "## Issues", "1. **CRITICAL** - x.ts:1", "", "## Verdict", "Request Changes - one hole."];

function panelFor(text: string[]): { panel: ReviewPanel; renders: () => number } {
	let renders = 0;
	const panel = new ReviewPanel({ line: "review  Request Changes · 1 crit · abc123", text: text.join("\n") }, PLAIN, () => {
		renders++;
	});
	return { panel, renders: () => renders };
}

describe("pi panel: the folded line", () => {
	test("folded, the panel is exactly one line with the folded mark", () => {
		const { panel } = panelFor(REVIEW);
		const lines = panel.render(60);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /^▸ review {2}Request Changes/);
	});

	test("a line wider than the terminal is cut, never wrapped", () => {
		const { panel } = panelFor(REVIEW);
		const lines = panel.render(20);
		assert.equal(lines.length, 1);
		// Visible columns, not string length: the row carries ANSI resets.
		assert.ok(visibleWidth(lines[0] ?? "") <= 20, "the row fits the width");
	});
});

describe("pi panel: unfolded", () => {
	test("a click unfolds, a second click folds, and each asks for a render", () => {
		const { panel, renders } = panelFor(REVIEW);
		assert.equal(panel.handleMouse(CLICK)?.handled, true);
		assert.equal(panel.isExpanded, true);
		assert.equal(panel.handleMouse(CLICK)?.handled, true);
		assert.equal(panel.isExpanded, false);
		assert.equal(renders(), 2);
	});

	test("a right click and a wheel are not an unfold", () => {
		const { panel } = panelFor(REVIEW);
		assert.equal(panel.handleMouse({ ...CLICK, button: "right" }), undefined);
		assert.equal(panel.handleMouse({ ...CLICK, type: "wheel", wheelDelta: -1 }), undefined);
		assert.equal(panel.isExpanded, false);
	});

	test("unfolded, the panel never exceeds its cap", () => {
		const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
		const { panel } = panelFor(long);
		panel.handleMouse(CLICK);
		const lines = panel.render(60);
		assert.equal(lines.length, PANEL_LINES);
	});

	test("a cut body says how many lines are left", () => {
		const long = Array.from({ length: 60 }, (_, index) => `line ${index}`);
		const { panel } = panelFor(long);
		panel.handleMouse(CLICK);
		const lines = panel.render(80);
		assert.match(lines[lines.length - 1] ?? "", /… \d+ more lines/);
	});

	test("toggle() folds without a mouse, for the keyboard path", () => {
		const { panel } = panelFor(REVIEW);
		assert.equal(panel.toggle(), true);
		assert.equal(panel.toggle(), false);
	});
});
