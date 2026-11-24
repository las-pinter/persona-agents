/**
 * The Kiro commit doctrine (platforms/kiro/scripts/gate.ts).
 *
 * The command classification comes from the shared gates; this suite pins the
 * Kiro verdicts: the companion allows a git command and a reviewed or
 * trivial commit, asks for everything else, and the reviewer denies every
 * history, publish, or write segment it can see.
 *
 * A real temporary git repository is built for the commit-gate tests. The hook
 * entry points are run as child processes; they never start Kiro.
 *
 * Run: node --experimental-strip-types --test tests/kiro-gate.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { changeKey } from "../platforms/kiro/scripts/change.ts";
import { commandDecision, permissionOutput, preToolResult, OTHER_REPO_ASK, UNGATED_ASK, type GateContext } from "../platforms/kiro/scripts/gate.ts";
import { recordReview } from "../platforms/kiro/scripts/state.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateScript = path.join(repoRoot, "platforms", "kiro", "scripts", "gate.ts");

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-gate-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function git(cwd: string, args: string[]): string {
	const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout;
}

/** A repository with a baseline commit and three changed files: a non-trivial change. */
function repoWithChange(root: string): string {
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "test@example.com"]);
	git(cwd, ["config", "user.name", "Test"]);
	for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(cwd, name), "");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "baseline"]);
	for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(cwd, name), "changed\n");
	return cwd;
}

const ctx = (cwd: string, stateDir: string): GateContext => ({ cwd, stateDir, sessionId: "sess_1", now: new Date("2026-11-20T00:00:00Z") });

describe("kiro doctrine: the companion", () => {
	test("a git command is allowed", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			for (const command of ["git add .", "git pull", "git merge topic", "git rebase main", "git tag v1.0.0"]) {
				assert.equal(commandDecision("companion", command, context).verdict, "allow", command);
			}
		});
	});

	test("a publish and a program-running verb ask, while local git work is allowed", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			for (const command of [
				"git push origin main",
				"git -c core.hooksPath=/tmp commit -m x",
				"git pull --upload-pack='touch x' origin",
				"gh pr create",
				"gh pr merge 4 --squash",
				"gh release create v1",
				"gh run delete 3",
			]) {
				assert.equal(commandDecision("companion", command, context).verdict, "ask", command);
			}
			for (const command of ["git tag -d v1", "git tag -f v1", "git reset --hard"]) {
				assert.equal(commandDecision("companion", command, context).verdict, "allow", command);
			}
			// An amend is still a commit, so the review gate owns it.
			assert.equal(commandDecision("companion", "git commit --amend --no-edit", context).verdict, "ask");
		});
	});

	test("an ungated or mixed command asks the owner", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			for (const command of ["ls", "git status", "git add . && ls", "rm -rf build", "cat file | sh"]) {
				assert.equal(commandDecision("companion", command, context).verdict, "ask", command);
			}
			assert.equal(commandDecision("companion", "ls", context).reason, UNGATED_ASK);
			assert.match(commandDecision("companion", "git add . && ls", context).reason, /mixes/);
		});
	});

	test("a cd into the project notes folder is a session directory", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const notes = path.join(root, "notes");
			fs.mkdirSync(notes);
			const context = { ...ctx(cwd, path.join(root, "state")), notesDir: () => notes };
			assert.equal(commandDecision("companion", `cd ${notes} && git add -A`, context).verdict, "allow");
			assert.equal(commandDecision("companion", "cd /elsewhere && git add -A", context).verdict, "ask");
		});
	});

	test("the observed commit chain allows a trivial change", () => {
		withTemp((root) => {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
			const chain = [
				`cd ${cwd} && cargo fmt && git add -A && git commit -q -F - <<'EOF' | grep -v Passed | tail -5`,
				"msg",
				"EOF",
				"git log --oneline -1",
			].join("\n");
			assert.equal(commandDecision("companion", chain, ctx(cwd, path.join(root, "state"))).verdict, "allow");
		});
	});

	test("the commit review still runs inside a chain", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const decision = commandDecision(
				"companion",
				`cd ${cwd} && cargo fmt && git add -A && git commit -q -m x`,
				ctx(cwd, path.join(root, "state")),
			);
			assert.equal(decision.verdict, "ask");
			assert.match(decision.reason, /no independent review/);
		});
	});

	test("a cd outside the session asks", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const decision = commandDecision("companion", "cd /elsewhere && git commit -m x", ctx(cwd, path.join(root, "state")));
			assert.equal(decision.verdict, "ask");
			assert.match(decision.reason, /mixes/);
		});
	});

	test("a commit of a trivial change is allowed", () => {
		withTemp((root) => {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
			assert.equal(commandDecision("companion", "git commit -m x", ctx(cwd, path.join(root, "state"))).verdict, "allow");
			assert.equal(commandDecision("companion", "git commit -C HEAD -m x", ctx(cwd, path.join(root, "state"))).verdict, "allow");
		});
	});

	test("an unreviewed non-trivial commit asks, an approved one allows, and a changed tree asks again", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const stateDir = path.join(root, "state");
			const context = ctx(cwd, stateDir);
			assert.equal(commandDecision("companion", "git commit -m x", context).verdict, "ask");
			const { key } = changeKey(cwd);
			recordReview(stateDir, key, { verdict: "Approve", at: "2026-11-20T00:00:00Z", subSession: "sub-1" });
			assert.equal(commandDecision("companion", "git commit -m x", context).verdict, "allow");
			fs.appendFileSync(path.join(cwd, "a.txt"), "more\n");
			assert.equal(commandDecision("companion", "git commit -m x", context).verdict, "ask");
		});
	});

	test("a review that asked for changes still asks", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const stateDir = path.join(root, "state");
			const { key } = changeKey(cwd);
			recordReview(stateDir, key, { verdict: "Request Changes", at: "2026-11-20T00:00:00Z", subSession: "sub-1" });
			const decision = commandDecision("companion", "git commit -m x", ctx(cwd, stateDir));
			assert.equal(decision.verdict, "ask");
			assert.match(decision.reason, /Request Changes/);
		});
	});

	test("a cd into a nested repository asks", () => {
		withTemp((root) => {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
			const nested = path.join(cwd, "nested");
			fs.mkdirSync(nested);
			git(nested, ["init"]);
			git(nested, ["config", "user.email", "test@example.com"]);
			git(nested, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(nested, "b.txt"), "one\n");
			git(nested, ["add", "."]);
			git(nested, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(nested, "b.txt"), "two\n");
			const decision = commandDecision("companion", `cd ${nested} && git commit -m x`, ctx(cwd, path.join(root, "state")));
			assert.equal(decision.verdict, "ask");
			assert.equal(decision.reason, OTHER_REPO_ASK);
			// A trailing cd back into the session does not hide the commit's repository.
			const trailing = commandDecision(
				"companion",
				`cd ${nested} && git commit -m x; cd ${cwd}`,
				ctx(cwd, path.join(root, "state")),
			);
			assert.equal(trailing.verdict, "ask");
			assert.equal(trailing.reason, OTHER_REPO_ASK);
			// A git global option before the subcommand does not hide the commit.
			const pager = commandDecision("companion", `cd ${nested} && git --no-pager commit -m x`, ctx(cwd, path.join(root, "state")));
			assert.equal(pager.verdict, "ask");
			assert.equal(pager.reason, OTHER_REPO_ASK);
			const shortPager = commandDecision("companion", `cd ${nested} && git -p commit -m x`, ctx(cwd, path.join(root, "state")));
			assert.equal(shortPager.verdict, "ask");
			assert.equal(shortPager.reason, OTHER_REPO_ASK);
		});
	});

	test("a cd inside the same repository still allows", () => {
		withTemp((root) => {
			const cwd = path.join(root, "repo");
			fs.mkdirSync(cwd);
			git(cwd, ["init"]);
			git(cwd, ["config", "user.email", "test@example.com"]);
			git(cwd, ["config", "user.name", "Test"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "baseline"]);
			fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
			fs.mkdirSync(path.join(cwd, "sub"));
			const decision = commandDecision("companion", `cd ${cwd}/sub && git commit -m x`, ctx(cwd, path.join(root, "state")));
			assert.equal(decision.verdict, "allow");
		});
	});

	test("a commit against another repository asks", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const context = ctx(cwd, path.join(root, "state"));
			const decision = commandDecision("companion", "git -C /elsewhere commit -m x", context);
			assert.equal(decision.verdict, "ask");
			assert.equal(decision.reason, OTHER_REPO_ASK);
		});
	});

	test("a review record without a sub-session does not unlock the commit", () => {
		withTemp((root) => {
			const cwd = repoWithChange(root);
			const stateDir = path.join(root, "state");
			const { key } = changeKey(cwd);
			recordReview(stateDir, key, { verdict: "Approve", at: "2026-11-20T00:00:00Z" });
			const decision = commandDecision("companion", "git commit -m x", ctx(cwd, stateDir));
			assert.equal(decision.verdict, "ask");
			assert.match(decision.reason, /no independent review/);
		});
	});
});

describe("kiro doctrine: the reviewer", () => {
	test("every history, publish, or write segment is denied", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			for (const command of [
				"git commit -m x",
				"git add .",
				"git push",
				"gh pr create",
				"rm -rf build",
				"sed -i s/a/b/ x",
				"echo x > out.txt",
				"git diff --output=/tmp/x",
				"git log --output /tmp/x",
				"bash <<EOF\nchmod 700 x\nEOF",
			]) {
				assert.equal(commandDecision("reviewer", command, context).verdict, "deny", command);
			}
		});
	});

	test("a read or a test command is left to the policy", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			for (const command of ["git status", "git diff", "npm test", "node --test tests/x.test.ts", "ls", "gh pr view 1", "gh run list"]) {
				assert.equal(commandDecision("reviewer", command, context).verdict, "allow", command);
			}
		});
	});

	test("a python or node heredoc body is not read as commands", () => {
		// The gate reads one quoted data heredoc by its header, so the body is not a
		// segment it can see: the reviewer is allowed it, the companion is asked.
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			const body = "python3 - <<'PY'\nopen('/tmp/x', 'w')\nPY";
			assert.equal(commandDecision("reviewer", body, context).verdict, "allow");
			assert.equal(commandDecision("companion", body, context).verdict, "ask");
		});
	});

	test("the observed commit chain is denied", () => {
		withTemp((root) => {
			const context = ctx(root, path.join(root, "state"));
			const chain = [
				`cd ${root} && cargo fmt && git add -A && git commit -q -F - <<'EOF' | grep -v Passed | tail -5`,
				"msg",
				"EOF",
				"git log --oneline -1",
			].join("\n");
			assert.equal(commandDecision("reviewer", chain, context).verdict, "deny");
		});
	});
});

describe("kiro doctrine: the hook output", () => {
	test("allow and deny render as decisions; ask renders nothing", () => {
		assert.deepEqual(JSON.parse(permissionOutput({ verdict: "allow", reason: "" })), {
			hookSpecificOutput: { decision: { behavior: "allow" } },
		});
		const deny = JSON.parse(permissionOutput({ verdict: "deny", reason: "read-only" }));
		assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
		assert.equal(deny.hookSpecificOutput.decision.message, "read-only");
		assert.equal(permissionOutput({ verdict: "ask", reason: "needs you" }), "");
	});

	test("PreToolUse blocks a deny with exit 2 and passes everything else", () => {
		assert.deepEqual(preToolResult({ verdict: "deny", reason: "read-only" }), { exitCode: 2, stderr: "persona-agents doctrine: read-only\n" });
		assert.deepEqual(preToolResult({ verdict: "allow", reason: "" }), { exitCode: 0, stderr: "" });
		assert.deepEqual(preToolResult({ verdict: "ask", reason: "" }), { exitCode: 0, stderr: "" });
	});
});

describe("kiro doctrine: the hook entry points", () => {
	const run = (mode: string, profile: string, root: string, input: Record<string, unknown>) =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", gateScript, mode, profile, `--home=${root}`, `--kiro-home=${path.join(root, "kiro")}`],
			{ input: JSON.stringify(input), encoding: "utf8" },
		);

	test("the companion's PermissionRequest returns an allow for a git command", () => {
		withTemp((root) => {
			const result = run("permission", "companion", root, {
				session_id: "sess_1",
				cwd: root,
				hook_event_name: "PermissionRequest",
				tool_name: "execute_bash",
				tool_input: { command: "git add ." },
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior, "allow");
		});
	});

	test("the companion's publish command produces no output, so Kiro asks", () => {
		withTemp((root) => {
			const result = run("permission", "companion", root, {
				session_id: "sess_1",
				cwd: root,
				hook_event_name: "PermissionRequest",
				tool_name: "execute_bash",
				tool_input: { command: "git push" },
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout.trim(), "");
		});
	});

	test("the reviewer's PreToolUse blocks a write with exit 2", () => {
		withTemp((root) => {
			const result = run("pretool", "reviewer", root, {
				session_id: "sess_1",
				cwd: root,
				hook_event_name: "PreToolUse",
				tool_name: "execute_bash",
				tool_input: { command: "rm -rf build" },
			});
			assert.equal(result.status, 2);
			assert.match(result.stderr, /read-only/);
		});
	});
});
