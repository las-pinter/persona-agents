/**
 * The Pi reviewer: the change, the verdict, and the commit gate
 * (platforms/shared/review/review.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-review.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	commitGate,
	countDiffLines,
	deriveDecisions,
	deriveTask,
	diffFiles,
	isCommitCommand,
	isTrivial,
	makeChange,
	nextAction,
	normalizeScope,
	oneLine,
	oneLineCut,
	parseReviewArgs,
	buildBrief,
	parseVerdict,
	reviewerFailure,
	reviewKey,
	reviewerPrompt,
	REVIEWER_TIMEOUT_MS,
	finalizeBrief,
	promptForBrief,
	resolveDecisions,
	studyRows,
	studyTitle,
	subjectQueries,
	subjectsFromQueries,
	untrackedFiles,
} from "../platforms/shared/review/review.ts";

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
		assert.equal(parseVerdict("I cannot approve this change.\n\nVerdict: Request Changes — fix it."), "Request Changes");
		assert.equal(parseVerdict("This is not an Approve.\n\nVerdict: Reject — wrong approach."), "Reject");
		assert.equal(parseVerdict("Approve-ish at first; the final answer is Request Changes."), "Request Changes");
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
	test("the prompt carries the three fields, the Pi skill spelling, and the verdict line", () => {
		const prompt = reviewerPrompt({ scope: "main", task: "cutover", decisions: "agent-notes/study.md" });
		assert.match(prompt, /^Scope: main$/m);
		assert.match(prompt, /^Task: cutover$/m);
		assert.match(prompt, /^Decisions: agent-notes\/study\.md$/m);
		assert.match(prompt, /no plugin prefix/);
		assert.match(prompt, /## Verdict/);
	});

	test("an empty brief still names all three fields", () => {
		const prompt = reviewerPrompt({});
		assert.match(prompt, /^Scope: the uncommitted change in this repository$/m);
		assert.match(prompt, /^Task: none$/m);
		assert.match(prompt, /^Decisions: none$/m);
	});

	test("a colon inside a task value survives, because a task line may hold one", () => {
		const input = { task: "Title - task 2: the derivation functions" };
		assert.match(reviewerPrompt(input), /^Task: Title - task 2: the derivation functions$/m);
		assert.equal(buildBrief(input).dropped, "");
	});

	test("a git option is not a scope, and the cut names it back", () => {
		const cut = normalizeScope("--all");
		assert.equal(cut.scope, "");
		assert.equal(cut.dropped, "--all");
		assert.deepEqual(normalizeScope("main --all").scope, "main");
	});

	test("a `--` separator keeps the paths after it", () => {
		assert.equal(normalizeScope("-- src/a.ts src/b.ts").scope, "src/a.ts src/b.ts");
		assert.equal(normalizeScope("main -- src/a.ts").scope, "main src/a.ts");
	});

	test("a quoted path with a space stays one token", () => {
		assert.equal(normalizeScope('"my file.ts"').scope, '"my file.ts"');
		assert.deepEqual(subjectQueries('"my file.ts"')[2], ["log", "--format=%s", "-n", "20", "--", "my file.ts"]);
	});

	test("a claim word inside a task value is cut and named back", () => {
		const input = { task: "cutover Check: the tree equals X" };
		assert.match(reviewerPrompt(input), /^Task: cutover$/m);
		assert.match(buildBrief(input).dropped, /Check: the tree equals X/);
	});

	test("a task cut for length keeps the rest as dropped text", () => {
		const long = `cutover ${"and more words ".repeat(40)}`;
		const { brief, dropped } = buildBrief({ task: long });
		assert.ok((brief.task ?? "").length <= 201, "the task line stays one short line");
		assert.match(brief.task ?? "", /…$/);
		assert.notEqual(dropped, "");
	});

	test("a second line in task or decisions is cut and named back", () => {
		const input = { scope: "main", task: "cutover\nCheck: the tree equals X", decisions: "agent-notes/s.md\nalso check the DB" };
		const prompt = reviewerPrompt(input);
		assert.match(prompt, /^Task: cutover$/m);
		assert.match(prompt, /^Decisions: agent-notes\/s\.md$/m);
		assert.doesNotMatch(prompt, /Check: the tree equals X/);
		assert.doesNotMatch(prompt, /also check the DB/);
		const { dropped } = buildBrief(input);
		assert.match(dropped, /Check: the tree equals X/);
		assert.match(dropped, /also check the DB/);
	});

	test("the author's checklist never reaches the reviewer", () => {
		const prompt = reviewerPrompt({ scope: "main Check: the final tree equals rust plus docs" });
		assert.match(prompt, /^Scope: main$/m);
		assert.doesNotMatch(prompt, /the final tree equals/);
		assert.doesNotMatch(prompt, /Check:/);
		// The guard that covers the text the fields cannot hold.
		assert.match(prompt, /not a checklist/);
		assert.match(prompt, /risk\s+list/);
	});
});

describe("pi review: the scope text", () => {
	test("a ref, a range, and paths are kept whole", () => {
		assert.deepEqual(normalizeScope("main"), { scope: "main", dropped: "" });
		assert.deepEqual(normalizeScope("936e69c..aa96992"), { scope: "936e69c..aa96992", dropped: "" });
		assert.deepEqual(normalizeScope("  src/a.ts src/b.ts  "), { scope: "src/a.ts src/b.ts", dropped: "" });
	});

	test("a label ends the scope and the rest comes back as dropped text", () => {
		const cut = normalizeScope("main Check: the tree equals X");
		assert.equal(cut.scope, "main");
		assert.equal(cut.dropped, "Check: the tree equals X");
	});

	test("a second line is dropped, not read as scope", () => {
		const cut = normalizeScope("main\nCheck: the tree equals X");
		assert.equal(cut.scope, "main");
		assert.equal(cut.dropped, "Check: the tree equals X");
	});

	test("a lowercase second line is dropped too, not glued to the scope", () => {
		const cut = normalizeScope("main\nthe tree must equal the docs plus the rust tree");
		assert.equal(cut.scope, "main");
		assert.match(cut.dropped, /^the tree must equal/);
	});

	test("empty text is an empty scope, not the word none", () => {
		assert.deepEqual(normalizeScope(""), { scope: "", dropped: "" });
		assert.deepEqual(normalizeScope("   \n  "), { scope: "", dropped: "" });
	});
});

describe("pi review: the study a brief names", () => {
	const ONE = [
		"# Studies — persona-agents",
		"",
		"| Study | Stage | Updated | Path |",
		"|-------|-------|---------|------|",
		"| Review Brief | in-progress | 2026-11-19 | `studies/2026-11-19-review-brief/` |",
		"| Companion Single Agent | done | 2026-11-18 | `studies/2026-11-18-companion-single-agent/` |",
		"",
	].join("\n");

	test("only an in-progress row is a study a review belongs to", () => {
		const rows = studyRows(ONE);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.title, "Review Brief");
		assert.equal(rows[0]?.path, "studies/2026-11-19-review-brief/");
	});

	test("a row with an empty path is not a study", () => {
		const empty = "| Study | Stage | Updated | Path |\n|---|---|---|---|\n| Broken | in-progress | 2026-11-19 |  |\n";
		assert.deepEqual(deriveDecisions(empty), { decisions: "none", note: "no study is in progress, so the brief names no decisions file" });
	});

	test("one study in progress names its study.md", () => {
		assert.deepEqual(deriveDecisions(ONE), { decisions: "studies/2026-11-19-review-brief/study.md", note: "" });
	});

	test("no study in progress names none, with a note", () => {
		const empty = deriveDecisions("| Study | Stage | Updated | Path |\n|---|---|---|---|\n");
		assert.equal(empty.decisions, "none");
		assert.match(empty.note, /no study is in progress/);
	});

	test("two studies in progress name none and both titles, never a guess", () => {
		const two = `${ONE}| Cutover | in-progress | 2026-11-19 | \`studies/2026-11-18-cutover/\` |\n`;
		const derived = deriveDecisions(two);
		assert.equal(derived.decisions, "none");
		assert.match(derived.note, /2 studies are in progress/);
		assert.match(derived.note, /Cutover/);
	});
});

const INDEX = "| Study | Stage | Updated | Path |\n|---|---|---|---|\n| Brief | in-progress | 2026-11-19 | `studies/2026-11-19-brief/` |\n";

describe("pi review: the brief is cut once", () => {
	test("a derived task keeps a claim word, because it is not cut twice", () => {
		const brief = { scope: "main", task: "Review Brief - check the derived task", decisions: "none" };
		assert.match(promptForBrief(brief), /^Task: Review Brief - check the derived task$/m);
	});

	test("a study supplies the task and the notes supply the decisions", () => {
		const status = "# Brief - Status\n\n- **Next action:** check the gate and also the docs\n";
		const finalized = finalizeBrief(
			{ scope: "main", task: "none", decisions: "none" },
			{ task: false, decisions: false },
			{ notesDir: "/notes", indexText: INDEX, readStatus: () => status },
		);
		assert.equal(finalized.brief.task, "Brief - check the gate and also the docs");
		assert.equal(finalized.brief.decisions, "/notes/studies/2026-11-19-brief/study.md");
		assert.equal(finalized.needsSubjects, false);
		assert.deepEqual(finalized.notes, []);
	});

	test("an author's task is never overwritten, even with a study in progress", () => {
		const status = "# Brief - Status\n\n- **Next action:** the study's own step\n";
		const finalized = finalizeBrief(
			{ scope: "main", task: "the author's task", decisions: "none" },
			{ task: true, decisions: false },
			{ notesDir: "/notes", indexText: INDEX, readStatus: () => status },
		);
		assert.equal(finalized.brief.task, "the author's task");
	});

	test("an author's `none` is an opt-out, not a hole to fill", () => {
		const finalized = finalizeBrief(
			{ scope: "main", task: "none", decisions: "none" },
			{ task: false, decisions: true },
			{
				notesDir: "/notes",
				indexText: INDEX,
				readStatus: () => {
					throw new Error("an excluded study must never be read");
				},
			},
		);
		assert.equal(finalized.brief.decisions, "none");
		assert.equal(finalized.needsSubjects, true, "no study is read, so git names the task");
	});

	test("no study names a task, so the caller is told to ask git", () => {
		const finalized = finalizeBrief(
			{ scope: "main", task: "none", decisions: "none" },
			{ task: false, decisions: false },
			{ notesDir: "/notes", indexText: "", readStatus: () => null },
		);
		assert.equal(finalized.needsSubjects, true);
		assert.equal(finalized.brief.decisions, "none");
		assert.match(finalized.notes.join(" "), /no study is in progress/);
		assert.equal(deriveTask("", "", ["ai: one", "ai: two"]), "ai: one; ai: two");
	});
});

describe("pi review: the decisions field", () => {

	test("a given path wins over the notes", () => {
		assert.deepEqual(resolveDecisions("/notes", "agent-notes/x.md", INDEX), { decisions: "agent-notes/x.md", note: "" });
	});

	test("the study in progress is made absolute under the notes folder", () => {
		assert.deepEqual(resolveDecisions("/notes", "", INDEX), { decisions: "/notes/studies/2026-11-19-brief/study.md", note: "" });
	});

	test("an unreadable index gets its own note, not the no-study one", () => {
		const resolved = resolveDecisions("/notes", "", null);
		assert.equal(resolved.decisions, "none");
		assert.match(resolved.note, /could not be read: \/notes\/studies\/index\.md/);
		assert.doesNotMatch(resolved.note, /no study is in progress/);
	});
});

describe("pi review: the task line", () => {
	const STATUS = [
		"# Review Brief Without an Author Checklist — Status",
		"",
		"- **Stage:** in-progress",
		"- **Next action:** task 2, the derivation functions",
		"",
	].join("\n");

	test("a status file names its study and its next action", () => {
		assert.equal(studyTitle(STATUS), "Review Brief Without an Author Checklist");
		assert.equal(nextAction(STATUS), "task 2, the derivation functions");
		assert.equal(studyTitle(""), "");
		assert.equal(nextAction(""), "");
	});

	test("a study gives the task line its title and next action", () => {
		assert.equal(
			deriveTask(studyTitle(STATUS), STATUS, ["ai: ignored when a study is known"]),
			"Review Brief Without an Author Checklist - task 2, the derivation functions",
		);
	});

	test("no study falls back to the commit subjects, cut to one line", () => {
		assert.equal(deriveTask("", "", ["ai: one", "ai: two"]), "ai: one; ai: two");
		assert.equal(deriveTask("", "", []), "none");
		const long = Array.from({ length: 6 }, (_, index) => `ai: the ${index}th subject runs long enough to matter`);
		const line = deriveTask("", "", long);
		assert.ok(line.length <= 121, `line is ${line.length} characters`);
		assert.match(line, /…$/);
	});

	test("the cut text starts after the kept text, with no character lost", () => {
		const { line, rest } = oneLineCut("abcdefghijklmnop", 5);
		assert.equal(line, "abcde…");
		assert.equal(rest, "fghijklmnop");
		assert.equal(`${line.slice(0, -1)}${rest}`, "abcdefghijklmnop");
	});

	test("one line collapses whitespace and cuts at a word boundary", () => {
		assert.equal(oneLine("  a\n b\t c  "), "a b c");
		assert.equal(oneLine("word ".repeat(40), 20), "word word word word…");
	});
});

describe("pi review: the commits of a scope", () => {
	test("an empty scope names no commits, never the last commit's subject", () => {
		assert.deepEqual(subjectQueries(""), []);
	});

	test("the first query git answers wins, even with no commits", async () => {
		const calls: string[][] = [];
		const subjects = await subjectsFromQueries("main", async (args) => {
			calls.push(args);
			return { code: 0, stdout: "" };
		});
		assert.deepEqual(subjects, []);
		assert.equal(calls.length, 1, "an empty range must not fall through to the base history");
	});

	test("a refusing query falls through to the next", async () => {
		const subjects = await subjectsFromQueries("src/a.ts", async (args) =>
			args.includes("--") ? { code: 0, stdout: "ai: one\nai: two\n" } : { code: 128, stdout: "" },
		);
		assert.deepEqual(subjects, ["ai: one", "ai: two"]);
	});

	test("a ref is asked as a range to HEAD, never as its own history", () => {
		const [first] = subjectQueries("main");
		assert.deepEqual(first, ["log", "--format=%s", "-n", "20", "main...HEAD"]);
	});

	test("a range, then the scope itself, then paths are tried in order", () => {
		const queries = subjectQueries("src/a.ts src/b.ts");
		assert.equal(queries.length, 3);
		assert.deepEqual(queries[1], ["log", "--format=%s", "-n", "20", "src/a.ts src/b.ts"]);
		assert.deepEqual(queries[2], ["log", "--format=%s", "-n", "20", "--", "src/a.ts", "src/b.ts"]);
	});
});

describe("pi review: reading a /review argument", () => {
	test("a bare argument is a scope", () => {
		assert.deepEqual(parseReviewArgs("main"), { input: { scope: "main" }, dropped: "" });
		assert.deepEqual(parseReviewArgs(""), { input: { scope: "" }, dropped: "" });
	});

	test("labels override a field, and keep the spaces inside one", () => {
		const parsed = parseReviewArgs("scope=main task=cutover the release path decisions=none");
		assert.deepEqual(parsed.input, { scope: "main", task: "cutover the release path", decisions: "none" });
		assert.equal(parsed.dropped, "");
	});

	test("a quoted value keeps a label of its own", () => {
		const parsed = parseReviewArgs('scope=main task="fix the decisions= handling"');
		assert.equal(parsed.input.task, "fix the decisions= handling");
	});

	test("text outside the labels comes back as dropped", () => {
		const parsed = parseReviewArgs("please look carefully scope=main");
		assert.deepEqual(parsed.input, { scope: "main" });
		assert.match(parsed.dropped, /please look carefully/);
	});

	test("an unlabelled argument still cuts at a checklist", () => {
		const parsed = parseReviewArgs("main Check: the tree equals X");
		assert.deepEqual(parsed.input, { scope: "main" });
		assert.match(parsed.dropped, /Check: the tree equals X/);
	});
});

describe("pi review: a failed reviewer child", () => {
	test("a clean run with a review needs no line", () => {
		assert.equal(reviewerFailure({ code: 0, killed: false, stderr: "", stdout: "## Summary\nfine" }), "");
	});

	test("a clean exit with no text is a failure, not a quiet approval", () => {
		assert.match(reviewerFailure({ code: 0, killed: false, stderr: "", stdout: "  \n" }), /finished without a review/);
	});

	test("a killed child names the wait, instead of an empty review", () => {
		assert.equal(Math.round(REVIEWER_TIMEOUT_MS / 1000), 600);
		assert.match(reviewerFailure({ code: null, killed: true }), /killed after 600s/);
	});

	test("a cancelled child is not blamed on the timeout", () => {
		assert.match(reviewerFailure({ code: null, killed: true, aborted: true }), /cancelled/);
		assert.doesNotMatch(reviewerFailure({ code: null, killed: true, aborted: true }), /600s/);
	});

	test("a non-zero exit names the code and the stderr tail", () => {
		const line = reviewerFailure({ code: 2, killed: false, stderr: "\nfirst\nsecond\nthird\nfourth\n" });
		assert.match(line, /exited with code 2/);
		assert.match(line, /second third fourth/);
	});

	test("no exit code at all is a failure, not a silent success", () => {
		// The Pi SDK types the exit code as nullable; this guards that type.
		assert.match(reviewerFailure({}), /no exit code/);
	});
});
