/**
 * The Kiro review flow: the brief (platforms/kiro/scripts/review.ts) and the
 * verdict recorder (review-record.ts).
 *
 * The brief is built over a temporary repository and notes tree; the recorder
 * reads a fixture V3 session store. The tests never start Kiro or a model.
 *
 * Run: node --experimental-strip-types --test tests/kiro-review.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewBrief, reviewerTask } from "../platforms/kiro/scripts/review.ts";
import { keyOfPrompt, recordSessionReviews } from "../platforms/kiro/scripts/review-record.ts";
import { changeKey } from "../platforms/kiro/scripts/change.ts";
import { reviewFor } from "../platforms/kiro/scripts/state.ts";
import { isTrivial } from "../platforms/shared/review/review.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewScript = path.join(repoRoot, "platforms", "kiro", "scripts", "review.ts");
const recordScript = path.join(repoRoot, "platforms", "kiro", "scripts", "review-record.ts");
const sessionId = "sess_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-review-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function git(cwd: string, args: string[]): void {
	const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
}

/** A repository with a baseline commit and three changed files. */
function repoWithChange(root: string): string {
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test"]);
	for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(cwd, name), "");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "baseline work"]);
	for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(cwd, name), "changed\n");
	return cwd;
}

/** A notes tree with one study in progress. */
function notesWithStudy(root: string): string {
	const notes = path.join(root, "notes");
	const study = path.join(notes, "studies", "2026-11-20-kiro");
	fs.mkdirSync(study, { recursive: true });
	fs.writeFileSync(path.join(study, "status.md"), "# Kiro Port — Status\n\n- **Next action:** finish the review flow\n");
	fs.writeFileSync(
		path.join(notes, "studies", "index.md"),
		"| Study | Stage | Updated | Path |\n|-------|-------|---------|------|\n| Kiro Port | in-progress | 2026-11-20 | `studies/2026-11-20-kiro/` |\n",
	);
	return notes;
}

describe("kiro review: the brief", () => {
	test("the study in progress fills the task and the decisions file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-review-"));
		try {
			const cwd = repoWithChange(root);
			const notes = notesWithStudy(root);
			const brief = await buildReviewBrief({}, { cwd, notesDir: notes });
			assert.equal(brief.brief.scope, "the uncommitted change in this repository");
			assert.equal(brief.brief.task, "Kiro Port - finish the review flow");
			assert.equal(brief.brief.decisions, path.join(notes, "studies", "2026-11-20-kiro", "study.md"));
			assert.match(brief.key, /^[0-9a-f]{16}$/);
			const task = reviewerTask(brief);
			assert.match(task, /^Scope: the uncommitted change in this repository$/m);
			assert.match(task, /^Task: Kiro Port - finish the review flow$/m);
			assert.match(task, new RegExp(`^Decisions: .*study\\.md$`, "m"));
			assert.match(task, new RegExp(`^Change key: ${brief.key}$`, "m"));
			assert.match(task, /Note for Kiro/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a named field is kept, none included", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-review-"));
		try {
			const cwd = repoWithChange(root);
			const notes = notesWithStudy(root);
			const brief = await buildReviewBrief({ scope: "HEAD~1", task: "cutover", decisions: "none" }, { cwd, notesDir: notes });
			assert.equal(brief.brief.scope, "HEAD~1");
			assert.equal(brief.brief.task, "cutover");
			assert.equal(brief.brief.decisions, "none");
			assert.equal(brief.key, "", "a ref scope does not carry the working-tree key");
			assert.ok(brief.notes.some((note) => /does not unlock a commit/.test(note)));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("author text that is not a scope is cut and named back", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-review-"));
		try {
			const cwd = repoWithChange(root);
			const notes = notesWithStudy(root);
			const brief = await buildReviewBrief({ scope: "main Check: the tests pass" }, { cwd, notesDir: notes });
			assert.equal(brief.brief.scope, "main");
			assert.ok(brief.notes.some((note) => /ignored author text: Check: the tests pass/.test(note)));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("with no study, an empty scope names no task", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-review-"));
		try {
			const cwd = repoWithChange(root);
			const brief = await buildReviewBrief({}, { cwd, notesDir: path.join(root, "empty-notes") });
			assert.equal(brief.brief.task, "none");
			assert.equal(brief.brief.decisions, "none");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a large untracked file is not a trivial change", () => {
		withTemp((root) => {
			const cwd = path.join(root, "untracked-repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "base.txt"), "base\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "big.ts"), Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"));
			const { change } = changeKey(cwd);
			assert.equal(change.untracked.length, 1);
			assert.equal(isTrivial(change), false);
		});
	});

	test("the key survives git add, so a review still covers the commit", () => {
		withTemp((root) => {
			const cwd = path.join(root, "add-repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			git(cwd, ["commit", "--allow-empty", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "new.ts"), "const a = 1;\n");
			const before = changeKey(cwd).key;
			git(cwd, ["add", "."]);
			assert.equal(changeKey(cwd).key, before);
			fs.writeFileSync(path.join(cwd, "new.ts"), "const a = 2;\n");
			assert.notEqual(changeKey(cwd).key, before);
		});
	});

	test("deleting or renaming a file after a review changes the key", () => {
		withTemp((root) => {
			const cwd = path.join(root, "delete-repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
			fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "changed\n");
			const before = changeKey(cwd).key;
			fs.rmSync(path.join(cwd, "b.txt"));
			assert.notEqual(changeKey(cwd).key, before, "a deletion changes the key");
			git(cwd, ["checkout", "--", "b.txt"]);
			assert.equal(changeKey(cwd).key, before, "restoring the file restores the key");
		});
	});

	test("a mode-only change changes the key", () => {
		withTemp((root) => {
			const cwd = path.join(root, "mode-repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "run.sh"), "#!/bin/sh\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			const before = changeKey(cwd).key;
			fs.chmodSync(path.join(cwd, "run.sh"), 0o755);
			assert.notEqual(changeKey(cwd).key, before, "a chmod changes the key");
			fs.chmodSync(path.join(cwd, "run.sh"), 0o644);
			assert.equal(changeKey(cwd).key, before, "restoring the mode restores the key");
		});
	});

	test("an untracked directory's files all count", () => {		withTemp((root) => {
			const cwd = path.join(root, "dir-repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			git(cwd, ["commit", "--allow-empty", "-m", "baseline"]);
			fs.mkdirSync(path.join(cwd, "feature"));
			for (const name of ["a.ts", "b.ts"]) {
				fs.writeFileSync(path.join(cwd, "feature", name), Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
			}
			const { change } = changeKey(cwd);
			assert.deepEqual(change.files, ["feature/a.ts", "feature/b.ts"]);
			assert.equal(isTrivial(change), false);
		});
	});

	test("a failed git read is not a trivial change", () => {
		withTemp((root) => {
			const cwd = path.join(root, "not-a-repo");
			fs.mkdirSync(cwd);
			const { change } = changeKey(cwd);
			assert.equal(isTrivial(change), false);
		});
	});

	test("the CLI prints the reviewer task and its warnings", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const notes = notesWithStudy(root);
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", reviewScript, "main Check: the tests pass", `--cwd=${cwd}`, `--notes=${notes}`],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /^Scope: main$/m);
			assert.doesNotMatch(run.stdout, /^Change key:/m, "a named scope names no key");
			assert.match(run.stdout, /Note for Kiro/);
			assert.match(run.stderr, /ignored author text/);
			assert.match(run.stderr, /does not unlock a commit/);
		});
	});

	test("the CLI with no scope names the uncommitted change and its key", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const notes = notesWithStudy(root);
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", reviewScript, `--cwd=${cwd}`, `--notes=${notes}`],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /^Scope: the uncommitted change in this repository$/m);
			assert.match(run.stdout, /^Change key: [0-9a-f]{16}$/m);
		});
	});
});

describe("kiro review: the verdict recorder", () => {
	function store(root: string, runs: { agent: string; key?: string; briefKey?: string; response: string; status?: string }[]): string {
		const kiro = path.join(root, "kiro");
		const dir = path.join(kiro, "sessions", "hash", sessionId);
		fs.mkdirSync(dir, { recursive: true });
		const payloads: Record<string, unknown>[] = [];
		runs.forEach((run, index) => {
			const sub = `sub-${index}`;
			if (!run.key && run.briefKey) {
				payloads.push({ type: "tool_result", status: "completed", content: `Output:\nReview one change.\n\nChange key: ${run.briefKey}\nmetadata` });
			}
			payloads.push({ type: "sub_agent_start", subSessionId: sub, subAgentName: run.agent, prompt: run.key ? `Review one change.\n\nChange key: ${run.key}\nmetadata` : "Review one change." });
			payloads.push({ type: "sub_agent_complete", subSessionId: sub, subAgentName: run.agent, response: run.response, status: run.status ?? "success" });
		});
		fs.writeFileSync(path.join(dir, "messages.jsonl"), `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`);
		return kiro;
	}

	test("an approved reviewer run is recorded under its key", () => {
		withTemp((root) => {
			const kiro = store(root, [{ agent: "pa-reviewer", key: "0123456789abcdef", response: "## Summary\nFine.\n\n## Verdict\nApprove - good." }]);
			const stateDir = path.join(root, "state");
			const recorded = recordSessionReviews(kiro, sessionId, stateDir);
			assert.equal(recorded.length, 1);
			assert.equal(recorded[0].verdict, "Approve");
			assert.equal(reviewFor(stateDir, "0123456789abcdef")?.verdict, "Approve");
			assert.equal(recordSessionReviews(kiro, sessionId, stateDir).length, 0, "a second scan records nothing");
		});
	});

	test("the newest verdict for a key survives a second scan", () => {
		withTemp((root) => {
			const kiro = store(root, [
				{ agent: "pa-reviewer", key: "5555555555555555", response: "## Verdict\nApprove - the first run." },
				{ agent: "pa-reviewer", key: "5555555555555555", response: "## Verdict\nRequest Changes - the second run." },
			]);
			const stateDir = path.join(root, "state");
			assert.equal(recordSessionReviews(kiro, sessionId, stateDir).length, 2);
			assert.equal(reviewFor(stateDir, "5555555555555555")?.verdict, "Request Changes");
			recordSessionReviews(kiro, sessionId, stateDir);
			assert.equal(reviewFor(stateDir, "5555555555555555")?.verdict, "Request Changes", "a second scan keeps the newest");
		});
	});

	test("a named-scope review does not inherit the earlier working-tree key", () => {
		withTemp((root) => {
			const kiro = path.join(root, "kiro");
			const dir = path.join(kiro, "sessions", "hash", sessionId);
			fs.mkdirSync(dir, { recursive: true });
			const payloads = [
				{ type: "tool_result", content: "Output:\nScope: the uncommitted change in this repository\n\nChange key: 6666666666666666\n" },
				{ type: "tool_result", content: "Output:\nScope: main...HEAD\n\nReview one change.\n" },
				{ type: "sub_agent_start", subSessionId: "sub-x", subAgentName: "pa-reviewer", prompt: "Review one change." },
				{ type: "sub_agent_complete", subSessionId: "sub-x", subAgentName: "pa-reviewer", response: "## Verdict\nApprove - nope.", status: "success" },
			];
			fs.writeFileSync(path.join(dir, "messages.jsonl"), `${payloads.map((payload) => JSON.stringify({ timestamp: "2026-11-20T00:00:00Z", payload })).join("\n")}\n`);
			const stateDir = path.join(root, "state");
			assert.equal(recordSessionReviews(kiro, sessionId, stateDir).length, 0);
			assert.equal(reviewFor(stateDir, "6666666666666666"), null);
		});
	});

	test("a request for changes is recorded, and a non-reviewer or a keyless run is not", () => {
		withTemp((root) => {
			const kiro = store(root, [
				{ agent: "pa-reviewer", key: "1111111111111111", response: "## Verdict\nRequest Changes - fix it." },
				{ agent: "someone-else", key: "2222222222222222", response: "## Verdict\nApprove - nope." },
				{ agent: "pa-reviewer", response: "## Verdict\nApprove - no key." },
				{ agent: "pa-reviewer", key: "3333333333333333", response: "## Verdict\nApprove - failed.", status: "error" },
			]);
			const stateDir = path.join(root, "state");
			const recorded = recordSessionReviews(kiro, sessionId, stateDir);
			assert.equal(recorded.length, 1);
			assert.equal(reviewFor(stateDir, "1111111111111111")?.verdict, "Request Changes");
			assert.equal(reviewFor(stateDir, "2222222222222222"), null);
			assert.equal(reviewFor(stateDir, "3333333333333333"), null);
		});
	});

	test("a truncated prompt still records the key from the brief in the transcript", () => {
		withTemp((root) => {
			const kiro = store(root, [
				{ agent: "pa-reviewer", briefKey: "4444444444444444", response: "## Verdict\nApprove - the brief was in the transcript." },
			]);
			const stateDir = path.join(root, "state");
			const recorded = recordSessionReviews(kiro, sessionId, stateDir);
			assert.equal(recorded.length, 1);
			assert.equal(reviewFor(stateDir, "4444444444444444")?.verdict, "Approve");
		});
	});

	test("the key line is read from the brief only", () => {
		assert.equal(keyOfPrompt("Change key: 0123456789abcdef"), "0123456789abcdef");
		assert.equal(keyOfPrompt("Change key: 0123456789abcdef\nmore"), "0123456789abcdef");
		assert.equal(keyOfPrompt("Change key: not-a-key"), "");
		assert.equal(keyOfPrompt("Change key: 0123456789abcde"), "");
	});

	test("the CLI writes the record from the Stop event", () => {
		withTemp((root) => {
			const kiro = store(root, [{ agent: "pa-reviewer", key: "abcdefabcdefabcd", response: "## Verdict\nApprove - good." }]);
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", recordScript, `--home=${root}`, `--kiro-home=${kiro}`],
				{ input: JSON.stringify({ session_id: sessionId, hook_event_name: "Stop" }), encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.equal(run.stdout, "");
			assert.equal(reviewFor(path.join(kiro, "persona-agents", "state"), "abcdefabcdefabcd")?.verdict, "Approve");
		});
	});
});

describe("kiro review: the skill branch", () => {
	test("the shared review skill branches to the Kiro reference", () => {
		const skill = fs.readFileSync(path.join(repoRoot, "content", "skills", "review", "SKILL.md"), "utf8");
		assert.match(skill, /Running in Kiro CLI/);
		assert.match(skill, /references\/kiro\.md/);
		const reference = fs.readFileSync(path.join(repoRoot, "content", "skills", "review", "references", "kiro.md"), "utf8");
		assert.match(reference, /review\.ts/);
		assert.match(reference, /pa-reviewer/);
	});
});
