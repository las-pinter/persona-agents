/**
 * Tests for the pure study status parser and the active-study pick.
 *
 * The module reads no fs and imports no pi code, so these tests pass a raw
 * `status.md` body and a hand-built study list.
 *
 * Run: npm test -- platforms/pi/extension/study-status.test.ts
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	type StudyEntry,
	parseStatusFile,
	pickActiveStudy,
	sortBriefNames,
	studySlug,
} from "./study-status.ts";

/** A `status.md` body in the documented shape. */
function statusFile(stage: string, updated: string, nextAction: string | null): string {
	const lines = [
		"# Alpha — Status",
		"",
		`- **Stage:** ${stage}`,
		`- **Updated:** ${updated}`,
		"- **Owner:** planner",
	];
	if (nextAction !== null) lines.push(`- **Next action:** ${nextAction}`);
	lines.push("- **Blocked by:** none", "", "## History", "", "| Date | Stage | Note |");
	return `${lines.join("\n")}\n`;
}

/** One study entry with a status body, or `null` for a missing `status.md`. */
function entry(folder: string, body: string | null): StudyEntry {
	return { folder, fields: body === null ? null : parseStatusFile(body) };
}

// --- parseStatusFile ---------------------------------------------------------

test("a status file yields its stage, updated date, and next action", () => {
	const fields = parseStatusFile(statusFile("full", "2026-01-05", "Write brief 03"));

	assert.deepEqual(fields, {
		stage: "full",
		updated: "2026-01-05",
		nextAction: "Write brief 03",
	});
});

test("a status file with no stage and no updated date is not a status file", () => {
	const fields = parseStatusFile("# Notes\n\n- **Owner:** planner\n");

	assert.equal(fields, null);
});

test("a status file with no next action line keeps the field empty", () => {
	const fields = parseStatusFile(statusFile("full", "2026-01-05", null));

	assert.equal(fields?.nextAction, null);
	assert.equal(fields?.stage, "full");
});

test("an empty field value counts as absent", () => {
	const fields = parseStatusFile("- **Stage:**\n- **Updated:** 2026-01-05\n");

	assert.equal(fields?.stage, null);
	assert.equal(fields?.updated, "2026-01-05");
});

// --- pickActiveStudy ---------------------------------------------------------

test("an open study beats a newer done study", () => {
	const picked = pickActiveStudy([
		entry("2026-01-01-alpha", statusFile("full", "2026-01-01", "Go")),
		entry("2026-02-01-beta", statusFile("done", "2026-02-01", "None")),
	]);

	assert.equal(picked?.folder, "2026-01-01-alpha");
});

test("two done studies pick the newest updated date", () => {
	const picked = pickActiveStudy([
		entry("2026-01-01-alpha", statusFile("done", "2026-01-01", "None")),
		entry("2026-02-01-beta", statusFile("done", "2026-02-01", "None")),
	]);

	assert.equal(picked?.folder, "2026-02-01-beta");
});

test("a status-less folder does not hide a done study", () => {
	const picked = pickActiveStudy([
		entry("2026-01-01-alpha", null),
		entry("2026-02-01-beta", statusFile("done", "2026-02-01", "None")),
	]);

	assert.equal(picked?.folder, "2026-02-01-beta", "the done study wins over the status-less folder");
});

test("a status-less folder alone picks nothing", () => {
	assert.equal(pickActiveStudy([entry("2026-01-01-alpha", null)]), null);
});

test("two open studies with one updated date keep the first entry", () => {
	const picked = pickActiveStudy([
		entry("2026-01-01-alpha", statusFile("full", "2026-01-05", "Go")),
		entry("2026-02-01-beta", statusFile("full", "2026-01-05", "Go")),
	]);

	assert.equal(picked?.folder, "2026-01-01-alpha");
});

test("an empty study list picks nothing", () => {
	assert.equal(pickActiveStudy([]), null);
});

// --- studySlug ---------------------------------------------------------------

test("the slug drops a leading date segment", () => {
	assert.equal(studySlug("2026-11-07-gate-status-surface"), "gate-status-surface");
});

test("the slug keeps a name with no date segment", () => {
	assert.equal(studySlug("legacy_studies"), "legacy_studies");
});

// --- sortBriefNames ----------------------------------------------------------

test("the brief names sort by name", () => {
	assert.deepEqual(sortBriefNames(["03-three.md", "01-one.md", "02-two.md"]), [
		"01-one.md",
		"02-two.md",
		"03-three.md",
	]);
});
