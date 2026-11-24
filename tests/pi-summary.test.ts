/**
 * The one-line summaries of the Pi surfaces
 * (platforms/pi/scripts/summary.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-summary.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	sessionLogLine,
	toolCallLine,
	listLine,
	permissionsLine,
	retroLine,
	reviewLine,
	summarizeReview,
} from "../platforms/pi/scripts/summary.ts";

const REVIEW = [
	"## Summary",
	"",
	"Reviewed the fix batch.",
	"",
	"## Risk list",
	"- a claim after the separator",
	"",
	"## Issues",
	"",
	"1. **CRITICAL** - review.ts:217",
	"   Conditions: a label after --",
	"2. **IMPORTANT** - index.ts:425",
	"   Conditions: none",
	"3. **SUGGESTION** - review.ts:489",
	"4. **NIT** - review.ts:225",
	"",
	"## Not verified",
	"",
	"- a **CRITICAL** was possible here but not seen",
	"- an **IMPORTANT** claim I did not check",
	"",
	"## Verdict",
	"",
	"Request Changes - one hole.",
	"",
	"review key: 388178dfdba1c304",
].join("\n");

describe("pi summary: a review", () => {
	test("the verdict, the counts, and the key come from the review text", () => {
		const summary = summarizeReview(REVIEW);
		assert.equal(summary.verdict, "Request Changes");
		assert.equal(summary.critical, 1);
		assert.equal(summary.important, 1);
		assert.equal(summary.suggestion, 1);
		assert.equal(summary.nit, 1);
		assert.equal(summary.blocker, 0);
		assert.equal(summary.key, "388178dfdba1c304");
	});

	test("a severity named under Not verified is not a finding", () => {
		const summary = summarizeReview(REVIEW);
		assert.equal(summary.critical, 1, "the CRITICAL under Not verified must not count");
		assert.equal(summary.important, 1, "the IMPORTANT under Not verified must not count");
	});

	test("a severity written in plain words still counts", () => {
		const text = [
			"## Issues",
			"",
			"1. Severity: CRITICAL",
			"2. Severity: `IMPORTANT`",
			"",
			"## Verdict",
			"Reject - two findings.",
		].join("\n");
		const summary = summarizeReview(text);
		assert.equal(summary.critical, 1);
		assert.equal(summary.important, 1);
		assert.equal(reviewLine(summary), "review  Reject · 1 crit · 1 imp · unknown");
	});

	test("an approving review with no issues still names its key", () => {
		const text = ["## Summary", "Fine.", "", "## Issues", "No issues found.", "", "## Verdict", "Approve - clean.", "", "review key: 7d24abf962839fd3"].join("\n");
		const summary = summarizeReview(text);
		assert.equal(summary.verdict, "Approve");
		assert.equal(reviewLine(summary), "review  Approve · no issues · 7d24abf962839fd3");
	});

	test("a text with no verdict and no key says so instead of guessing", () => {
		const summary = summarizeReview("## Summary\n\nnothing here");
		assert.equal(summary.verdict, "no verdict");
		assert.equal(summary.key, "unknown");
		assert.equal(reviewLine(summary), "review  no verdict · no issues · unknown");
	});

	test("the line reads as the panel needs it", () => {
		assert.equal(reviewLine(summarizeReview(REVIEW)), "review  Request Changes · 1 crit · 1 imp · 1 sug · 1 nit · 388178dfdba1c304");
	});
});

describe("pi summary: the other surfaces", () => {
	test("a permissions report counts rules, grants, and errors", () => {
		const report = [
			"# Permissions — companion",
			"",
			"## Rules (first match wins)",
			"- allow bash ^git status",
			"- ask bash ^git push",
			"- none",
			"",
			"## Session grants (this session only)",
			"- allow bash ^npm test",
			"",
			"## Load errors — the gate fails closed",
			"- the file is not valid JSON",
		].join("\n");
		assert.equal(permissionsLine(report), "permissions  2 rules · 1 grants · 1 errors");
	});

	test("prose words and negations are not findings", () => {
		const text = [
			"## Issues",
			"",
			"1. **CRITICAL** - x.ts:1, not a blocker, and lists important findings",
			"2. **SUGGESTION** - this suggestion is fine",
			"",
			"## Verdict",
			"Request Changes - one finding.",
		].join("\n");
		const summary = summarizeReview(text);
		assert.equal(summary.critical, 1);
		assert.equal(summary.blocker, 0, "`not a blocker` is prose");
		assert.equal(summary.important, 0, "`important findings` is prose");
		assert.equal(summary.suggestion, 1, "`this suggestion is fine` is prose");
	});

	test("a bullet that merely starts with the letters of none is real", () => {
		const report = ["## Rules (first match wins)", "- nonetheless the gate asks before a push", "", "## Session grants (this session only)", "- none"].join("\n");
		assert.equal(permissionsLine(report), "permissions  1 rules · 0 grants · 0 errors");
	});

	test("a placeholder bullet is not a rule", () => {
		const report = ["## Rules (first match wins)", "- none: the built-in doctrine decides every call", "", "## Session grants (this session only)", "- none"].join("\n");
		assert.equal(permissionsLine(report), "permissions  0 rules · 0 grants · 0 errors");
	});

	test("a retro's facts count tool calls, files, and reviews", () => {
		const facts = [
			"## Session facts",
			"",
			"- tool calls: 42 (bash 30, read 12)",
			"- files changed: 3",
			"  - platforms/pi/scripts/review.ts",
			"- compactions: 0",
			"- independent reviews: 1 (7d24abf962839fd3)",
		].join("\n");
		assert.equal(retroLine(facts), "retro  42 tool calls · 3 files · 1 review");
	});

	test("a facts text with nothing counted reads as zeros", () => {
		assert.equal(retroLine("no facts here"), "retro  0 tool calls · 0 files · 0 reviews");
	});

	test("a list counts its paths and its lines", () => {
		const list = ["## Rules", "- rule one", "- rule two", "", "## Summary", "- summary"].join("\n");
		assert.equal(listLine("read list", list), "read list  3 paths · 6 lines");
		assert.equal(listLine("read list", "- none"), "read list  0 paths · 1 lines");
	});

	test("a bash call shows its first line, cut to one line", () => {
		assert.equal(toolCallLine("bash", { command: "cd /repo && npm test" }), "bash  cd /repo && npm test");
		const multi = toolCallLine("bash", { command: "line one\nline two" });
		assert.equal(multi, "bash  line one");
		const long = toolCallLine("bash", { command: "x".repeat(400) });
		assert.ok(long.length <= 127, `the row is ${long.length} characters`);
		assert.match(long, /…$/);
	});

	test("a file tool shows the path, and a grep shows where it looked", () => {
		assert.equal(toolCallLine("read", { path: "src/a.ts" }), "read  src/a.ts");
		assert.equal(toolCallLine("edit", { path: "src/a.ts" }), "edit  src/a.ts");
		assert.equal(toolCallLine("grep", { pattern: "todo", path: "src" }), 'grep  "todo" in src');
		assert.equal(toolCallLine("grep", { pattern: "todo" }), 'grep  "todo"');
		assert.equal(toolCallLine("ls", {}), "ls  .");
	});

	test("an unknown tool gets its name alone, never a guess", () => {
		assert.equal(toolCallLine("mcp__thing", { id: 1 }), "mcp__thing");
	});

	test("a session-log row names the file it wrote", () => {
		assert.equal(sessionLogLine("session log written: /notes/session-logs/2026-11-19/2310-x.md"), "session-log  written: /notes/session-logs/2026-11-19/2310-x.md");
		assert.equal(sessionLogLine("no session logs"), "session-log  no session logs");
	});
});
