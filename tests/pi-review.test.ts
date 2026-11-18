/**
 * The Pi reviewer: the change, the verdict, and the commit gate
 * (platforms/pi/scripts/review.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-review.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	commitGate,
	countDiffLines,
	diffFiles,
	isCommitCommand,
	isTrivial,
	makeChange,
	parseVerdict,
	reviewKey,
	reviewerPrompt,
	untrackedFiles,
} from "../platforms/pi/scripts/review.ts";

const DIFF = [
	"diff --git a/src/gate.ts b/src/gate.ts",
	"--- a/src/gate.ts",
	"+++ b/src/gate.ts",
	"@@ -1,3 +1,4 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	"diff --git a/README.md b/README.md",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"",
].join("\n");

describe("pi review: reading a change", () => {
	test("a diff names its files and counts its changed lines", () => {
		assert.deepEqual(diffFiles(DIFF), ["src/gate.ts", "README.md"]);
		assert.deepEqual(countDiffLines(DIFF), { addedLines: 3, removedLines: 2 });
	});

	test("a new file's diff names it even though the old side is /dev/null", () => {
		const added = ["--- /dev/null", "+++ b/src/new.ts", "+hello", ""].join("\n");
		assert.deepEqual(diffFiles(added), ["src/new.ts"]);
	});

	test("untracked paths come from git status", () => {
		const status = [" M src/gate.ts", "?? src/new.ts", "?? notes/", "A  staged.ts", ""].join("\n");
		assert.deepEqual(untrackedFiles(status), ["src/new.ts", "notes/"]);
	});

	test("a change merges the diff files and the untracked ones", () => {
		const change = makeChange(DIFF, "?? src/new.ts\n", "sig");
		assert.deepEqual(change.files, ["src/gate.ts", "README.md", "src/new.ts"]);
		assert.equal(change.signature, "sig");
		assert.equal(change.addedLines, 3);
	});
});

describe("pi review: the key and the trivial rule", () => {
	const change = makeChange(DIFF, "", "");

	test("the key is stable, short, and changes with the content", () => {
		const key = reviewKey(change);
		assert.match(key, /^[0-9a-f]{16}$/);
		assert.equal(reviewKey(makeChange(DIFF, "", "")), key);
		assert.notEqual(reviewKey(makeChange(`${DIFF}\n+more`, "", "")), key);
		assert.notEqual(reviewKey(makeChange(DIFF, "?? extra.ts\n", "")), key);
		assert.notEqual(reviewKey(makeChange(DIFF, "", "different")), key);
	});

	test("two files and forty lines is still trivial, one more of either is not", () => {
		assert.equal(isTrivial({ files: ["a", "b"], addedLines: 20, removedLines: 20 }), true);
		assert.equal(isTrivial({ files: ["a", "b", "c"], addedLines: 1, removedLines: 0 }), false);
		assert.equal(isTrivial({ files: ["a"], addedLines: 41, removedLines: 0 }), false);
		assert.equal(isTrivial(change), true);
	});
});

describe("pi review: the verdict a reviewer states", () => {
	test("the documented forms are read", () => {
		assert.equal(parseVerdict("## Verdict\n\nApprove — one sentence of justification."), "Approve");
		assert.equal(parseVerdict("## Verdict\n\nRequest Changes — fix the gate."), "Request Changes");
		assert.equal(parseVerdict("## Verdict\n\nReject — wrong approach."), "Reject");
		assert.equal(parseVerdict("Verdict: Approve"), "Approve");
		assert.equal(parseVerdict("## Verdict\n\n**Approve**"), "Approve");
		assert.equal(parseVerdict("[Request Changes] — scope too wide"), "Request Changes");
	});

	test("the Verdict section wins over an earlier mention", () => {
		const text = "## Issues\n\nWe should reject nothing here.\n\n## Verdict\n\nApprove — fine.";
		assert.equal(parseVerdict(text), "Approve");
	});

	test("no verdict is null, not a guess", () => {
		assert.equal(parseVerdict("Summary\n\nLooks fine to me."), null);
		assert.equal(parseVerdict(""), null);
	});
});

describe("pi review: the commit gate", () => {
	test("a trivial change or an approving review passes silently", () => {
		assert.equal(commitGate({ trivial: true, reviewed: null }).verdict, "allow");
		assert.equal(commitGate({ trivial: false, reviewed: "Approve" }).verdict, "allow");
	});

	test("an unreviewed or unapproved change asks, and says why", () => {
		const none = commitGate({ trivial: false, reviewed: null });
		assert.equal(none.verdict, "ask");
		assert.match(none.reason, /no independent review/);
		const changes = commitGate({ trivial: false, reviewed: "Request Changes" });
		assert.equal(changes.verdict, "ask");
		assert.match(changes.reason, /Request Changes/);
		const reject = commitGate({ trivial: false, reviewed: "Reject" });
		assert.equal(reject.verdict, "ask");
	});

	test("only a plain git commit is gated", () => {
		assert.equal(isCommitCommand("git commit -m 'ai: x'"), true);
		assert.equal(isCommitCommand("cd sub && git commit -m x"), true);
		assert.equal(isCommitCommand("git -C repo commit -m x"), true);
		assert.equal(isCommitCommand("git status"), false);
		assert.equal(isCommitCommand("echo 'git commit'"), false);
		assert.equal(isCommitCommand("git log --grep commit"), false);
	});
});

describe("pi review: the reviewer task", () => {
	test("the prompt names the change, the Pi skill spelling, and the verdict line", () => {
		assert.match(reviewerPrompt(""), /the uncommitted change/);
		assert.match(reviewerPrompt("main"), /Review main\./);
		assert.match(reviewerPrompt(""), /no plugin prefix/);
		assert.match(reviewerPrompt(""), /## Verdict/);
	});
});
