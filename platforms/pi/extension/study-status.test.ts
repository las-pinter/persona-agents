/**
 * Tests for the pure study status parser and the panel's study list.
 *
 * The module reads no fs and imports no pi code, so these tests pass a raw
 * `status.md` body and a hand-built study list.
 *
 * Run: npm test -- platforms/pi/extension/study-status.test.ts
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	type StudyRow,
	isClosedStage,
	parseStatusFile,
	studySlug,
	visibleStudies,
} from "./study-status.ts";

/** A `status.md` body in the documented shape. */
function statusFile(stage: string, updated: string): string {
	const lines = [
		"# Alpha — Status",
		"",
		`- **Stage:** ${stage}`,
		`- **Updated:** ${updated}`,
		"- **Owner:** planner",
		"- **Next action:** Write brief 03",
		"- **Blocked by:** none",
		"",
		"## History",
		"",
		"| Date | Stage | Note |",
	];
	return `${lines.join("\n")}\n`;
}

/** One study row with its date prefix dropped from the display name. */
function row(folder: string, stage: string | null, updated: string | null): StudyRow {
	return { folder, name: studySlug(folder), stage, briefs: 0, updated };
}

/** A fresh process state. */
function freshSeen(): Set<string> {
	return new Set<string>();
}

// --- parseStatusFile ---------------------------------------------------------

test("a status file yields its stage and updated date", () => {
	const fields = parseStatusFile(statusFile("active", "2026-01-05"));

	assert.deepEqual(fields, { stage: "active", updated: "2026-01-05" });
});

test("a status file with no stage and no updated date is not a status file", () => {
	const fields = parseStatusFile("# Notes\n\n- **Owner:** planner\n");

	assert.equal(fields, null);
});

test("an empty field value counts as absent", () => {
	const fields = parseStatusFile("- **Stage:**\n- **Updated:** 2026-01-05\n");

	assert.equal(fields?.stage, null);
	assert.equal(fields?.updated, "2026-01-05");
});

// --- isClosedStage -----------------------------------------------------------

test("done and abandoned are closed stages", () => {
	assert.equal(isClosedStage("done"), true);
	assert.equal(isClosedStage("abandoned"), true);
});

test("active, blocked, and a missing stage are open", () => {
	assert.equal(isClosedStage("active"), false);
	assert.equal(isClosedStage("blocked"), false);
	assert.equal(isClosedStage(null), false);
});

// --- visibleStudies ----------------------------------------------------------

test("every open study shows, newest updated first", () => {
	const rows = [
		row("2026-01-01-alpha", "active", "2026-01-01"),
		row("2026-03-01-gamma", "blocked", "2026-03-01"),
		row("2026-02-01-beta", "active", "2026-02-01"),
	];

	const shown = visibleStudies(rows, freshSeen());

	assert.deepEqual(
		shown.map((entry) => entry.name),
		["gamma", "beta", "alpha"],
	);
});

test("a blocked study keeps its place in the updated order", () => {
	const rows = [
		row("2026-01-01-alpha", "active", "2026-01-01"),
		row("2026-02-01-beta", "blocked", "2026-02-01"),
	];

	const shown = visibleStudies(rows, freshSeen());

	assert.deepEqual(
		shown.map((entry) => [entry.name, entry.stage]),
		[
			["beta", "blocked"],
			["alpha", "active"],
		],
	);
});

test("a study without a stage shows as open", () => {
	const shown = visibleStudies([row("2026-01-01-alpha", null, null)], freshSeen());

	assert.equal(shown.length, 1, "a half-written study is not hidden");
});

test("a study that closes keeps its row after it was open", () => {
	const seen = freshSeen();
	visibleStudies([row("2026-01-01-alpha", "active", "2026-01-01")], seen);

	const shown = visibleStudies([row("2026-01-01-alpha", "done", "2026-01-02")], seen);

	assert.deepEqual(
		shown.map((entry) => [entry.name, entry.stage]),
		[["alpha", "done"]],
	);
});

test("a fresh state drops a closed study", () => {
	const shown = visibleStudies([row("2026-01-01-alpha", "done", "2026-01-02")], freshSeen());

	assert.deepEqual(shown, []);
});

test("a study that was never open does not enter the state", () => {
	const seen = freshSeen();
	visibleStudies([row("2026-01-01-alpha", "abandoned", "2026-01-01")], seen);

	assert.deepEqual([...seen], []);
});

test("a missing updated date sorts last", () => {
	const rows = [
		row("2026-01-01-alpha", "active", null),
		row("2026-01-01-beta", "active", "2026-01-01"),
	];

	const shown = visibleStudies(rows, freshSeen());

	assert.deepEqual(
		shown.map((entry) => entry.name),
		["beta", "alpha"],
	);
});

// --- studySlug ---------------------------------------------------------------

test("the slug drops a leading date segment", () => {
	assert.equal(studySlug("2026-11-07-gate-status-surface"), "gate-status-surface");
});

test("the slug keeps a name with no date segment", () => {
	assert.equal(studySlug("legacy_studies"), "legacy_studies");
});
