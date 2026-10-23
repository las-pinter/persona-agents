/**
 * Permission regression harness for the opencode orchestrator history allow.
 *
 * Owner decision: a plain git add, commit, merge, or rebase runs without a
 * prompt for the opencode orchestrator. git pull, git tag, every `git -C`
 * form, git push, gh pr, and gh release ask. The exception forms ask, a tag
 * delete still denies, and a wrapped form is never an allow. opencode matches
 * each command node on its own, so these tests use no raw chains. Every
 * other opencode agent still blocks. opencode rules are globs where `*`
 * matches any text, so the exceptions are substring asks and over-ask on
 * purpose.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { OPENCODE_SHELL_AGENTS, opencodeVerdict } from "./permission-templates.fixtures.ts";

const PLAIN_HISTORY = [
	"git add",
	"git add .",
	"git add -A",
	"git add src/a.ts",
	'git commit -m "fix: thing (x) it\'s"',
	"git commit -F msg.txt",
	"git commit",
	// Makes a new amend! commit; it does not amend, so it must stay allow.
	"git commit --fixup=amend:HEAD",
	'git merge --no-ff -m "merge it" feature',
	"git merge --ff-only origin/main",
	"git merge --abort",
	"git merge dev",
	"git rebase",
	"git rebase main",
	"git rebase -i HEAD~3",
	"git rebase --continue",
	"git rebase --exec 'npm run check' main",
	"git rebase -x 'npm run check' main",
];

const ASK_EXCEPTIONS: Record<string, string[]> = {
	// A quoted or escaped space in the `-C` value can hide a second verb, so
	// every `git -C` history form asks (owner decision).
	"git -C forms": [
		"git -C x\\ commit push --force",
		"git -C 'x commit ' push --force",
		'git -C "x tag " push origin +main',
		"git -C x\\ commit -c core.fsmonitor=/tmp/e status",
		"git -C x\\ add reset --hard HEAD~5",
		"git -C /repo add .",
		"git -C /repo commit -m x",
		"git -C /repo merge main",
		"git -C /repo rebase main",
		"git -C /repo pull",
		"git -C /repo tag v1",
		"git -C /r rm -rf x commit",
		"git -C /r -c core.fsmonitor commit -m x",
	],
	// A planted file named `--upload-pack=<cmd>` or `-d` would turn a bare `*`
	// into code execution or a tag delete, so pull and tag ask (owner decision).
	"git pull and git tag": [
		"git pull",
		"git pull origin main",
		"git pull --rebase",
		"git pull --ff-only",
		"git pull *",
		"git pull origin *",
		"git tag v1",
		'git tag -a v1.2.3 -m "release v1.2.3"',
		"git tag v1 *",
		"git tag *",
	],
	"tag force-move": ["git tag -f v1", "git tag --force v1", "git tag -fm1 v1", "git tag '-f' v1"],
	"commit --amend": [
		"git commit --amend",
		"git commit --amen --no-edit",
		"git commit --am",
		"git commit --a",
		'git commit --am"end"',
		"git commit -m x '--amend'",
		'git commit -m x "--amend"',
		"git commit -m x --'amend'",
		'git commit -m x --"amend"',
		"git commit -m x --a'mend'",
		'git commit -m x --a"mend"',
		"git commit -m x --a\\mend",
		"git commit -m x \\-\\-amend",
		"git commit -m x -\\-amend",
		"git commit -m x '-'-amend",
		"git commit -m x ''--amend",
		"git commit -m 'a;b' '--amend'",
		"git commit -m 'a;b' --am\\end",
	],
	"upload-pack": [
		"git pull --upload-pack=evil",
		"git pull \"--upload-pack=touch /tmp/pwn\" /r",
		"git pull --server-option='a;b' \"--upload-pack=touch /tmp/pwn\" /r",
	],
	"transport helper URL": [
		"git pull ext::sh",
		"git merge fd::17",
		"git merge ext:'':sh",
		'git merge ext:"":sh',
		"git merge ext:\\:sh",
		"git merge 'fd:':17",
	],
	"merge strategy": [
		"git pull -s ours",
		"git merge -s ours x",
		"git merge -sours x",
		"git merge -ns ours x",
		"git merge -nqvs ours x",
		"git merge --strategy=ours x",
		"git merge --strat ours x",
		"git merge '-s' ours x",
		"git merge --str\\ategy=ours x",
		"git rebase -s ours main",
		"git rebase -is ours main",
		"git rebase --strategy ours main",
		"git rebase -\\s ours main",
		"git rebase 'a|b' '-s' ours main",
	],
	"git -c override and unknown global option": [
		"git -c core.hooksPath=/x commit -m x",
		"git -c core.hooksPath commit -m x",
		"git -c alias.x=y add .",
		"git --git-dir=/x commit -m x",
		"git --work-tree /x add .",
		"git --exec-path=/x merge y",
		"git --bare rebase main",
		"git --attr-source commit push origin main",
		"git -p commit -m x",
		"git --no-pager merge x",
	],
	"brace, bracket, and extglob expansion": [
		"git pull {--upload-pack=evil,/r}",
		"git commit -m x {--amend,}",
		"git commit {--amend,-m,x}",
		"git commit -m x --{amend,}",
		"git tag {-d,v1}",
		"git merge {-s,evil} x",
		"git rebase {-s,evil} main",
		"git add [a-]*",
		"git add !(x)",
		"git add @(x)",
		"git add +(x)",
	],
	"runtime-shaped": [
		'git commit -m "$(date)"',
		'git commit -m "$MSG"',
		"git commit -m `date`",
		"git commit -m x ${IFS}--amend",
		"git commit -m x $'--amend'",
		"git add <(touch /tmp/x)",
		"git add =(touch /tmp/x)",
		"git add\ta.ts",
	],
	wrapped: [
		"env git commit -m x",
		"GIT_DIR=/x git add .",
		"command git merge x",
		"sudo git rebase main",
		"nohup git rebase main",
		"time git commit -m x",
		"xargs git commit -m x",
		"echo $(git commit -m x)",
		"echo `git add .`",
		" git commit -m x",
		"/usr/bin/git commit -m x",
	],
};

const STILL_ASK = [
	"git push",
	"git push origin main",
	"git push --force origin main",
	"git -C /repo push",
	"env git push",
	"gh pr create --fill",
	"gh pr merge 1",
	"gh -R x/y pr list",
	"gh release create v1",
	"gh release list",
	"git reset --soft HEAD~1",
];

const TAG_DELETE = ["git tag -d v1", "git tag --delete v1", "git tag -fd v1", "git -C /repo tag -d v1", "git tag v1 -d"];

// Accepted local risk (owner decision): opencode reads `*` as any text and `?`
// as any one character, so no rule can match a literal `*` or `?`. On git add,
// commit, merge, and rebase a bare glob allows, and bash pathname expansion can
// add an option word (a file named `--amend` in the directory). The test pins
// the risk so that a change is seen. git pull and git tag ask for this reason.
const LITERAL_GLOB_ACCEPTED_RISK = [
	"git add *",
	"git add ?",
	"git commit -m x *",
	"git commit -m x --a?end",
	"git merge *",
	"git rebase *",
];

describe("opencode orchestrator: plain history commands allow", () => {
	test("plain add, commit, merge, and rebase allow", () => {
		for (const command of PLAIN_HISTORY) assert.equal(opencodeVerdict("orchestrator", command), "allow", command);
	});

	test("tag listing still allows", () => {
		for (const command of ["git tag", "git tag -l", "git tag --list", "git -C /repo tag -l"]) {
			assert.equal(opencodeVerdict("orchestrator", command), "allow", command);
		}
	});

	test("near-miss verbs do not ride the allow", () => {
		for (const command of ["git commit-tree HEAD^{tree}", "git merge-file a b c", "git merge-tree a b"]) {
			assert.notEqual(opencodeVerdict("orchestrator", command), "allow", command);
		}
	});
});

describe("opencode orchestrator: history exception forms ask", () => {
	// The -C and pull/tag groups get the stricter exact-ask test below.
	for (const [reason, commands] of Object.entries(ASK_EXCEPTIONS)) {
		if (reason === "git -C forms" || reason === "git pull and git tag") continue;
		test(`${reason} is never an allow`, () => {
			for (const command of commands) {
				const kind = opencodeVerdict("orchestrator", command);
				assert.ok(kind === "ask" || kind === "deny", `${command}: ${kind}`);
			}
		});
	}

	test("the -C hidden-verb inputs, pull, and tag ask (not deny)", () => {
		for (const command of [...ASK_EXCEPTIONS["git -C forms"], ...ASK_EXCEPTIONS["git pull and git tag"]]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("push, gh pr, gh release, and reset --soft still ask", () => {
		for (const command of STILL_ASK) assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
	});

	test("tag delete still denies", () => {
		for (const command of TAG_DELETE) assert.equal(opencodeVerdict("orchestrator", command), "deny", command);
	});

	test("accepted risk: a literal * or ? on add, commit, merge, or rebase allows", () => {
		for (const command of LITERAL_GLOB_ACCEPTED_RISK) {
			assert.equal(opencodeVerdict("orchestrator", command), "allow", command);
		}
	});
});

describe("opencode non-orchestrators: history commands still block", () => {
	for (const agent of OPENCODE_SHELL_AGENTS) {
		test(`${agent}: plain history forms do not allow`, () => {
			for (const command of PLAIN_HISTORY) {
				assert.notEqual(opencodeVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
	}
});
