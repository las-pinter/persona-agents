/**
 * Permission regression harness for the pi orchestrator history allow.
 *
 * Owner decision: a plain git add, commit, pull, merge, rebase, or tag runs
 * without a prompt for the pi orchestrator. git push, gh pr, gh run, and gh
 * release still ask. The exception forms still ask, a tag delete still denies,
 * and a wrapped form is never an allow. Every other agent still blocks.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCommandRules, type Decision } from "../platforms/pi/extension/command-segments.ts";
import { PI_SHELL_AGENTS, loadAgentRules, verdict } from "./permission-templates.fixtures.ts";

const PLAIN_HISTORY = [
	"git add .",
	"git add -A",
	"git add src/a.ts",
	'git commit -m "fix: thing (x) it\'s"',
	"git commit -F msg.txt",
	"git pull",
	"git pull --rebase origin main",
	"git pull --stat",
	'git merge --no-ff -m "merge it" feature',
	"git merge --ff-only origin/main",
	"git merge -X theirs feature",
	"git rebase main",
	"git rebase -i --autosquash main",
	"git rebase --exec 'npm test' main",
	"git rebase -x 'npm test' main",
	"git rebase -Xours main",
	"git tag v1.2.3",
	'git tag -a v1.2.3 -m "release for x"',
	"git tag v1.0.0-final",
];

/** Each plain form with `git -C`, the pager flags, and the `cd X &&` fold. */
const ANCHORED_HISTORY = PLAIN_HISTORY.flatMap((command) => [
	command.replace(/^git /, "git -C /repo "),
	command.replace(/^git /, "git --no-pager -p -C /repo "),
	`cd /repo && ${command}`,
]);

/** Each ask exception, grouped by the reason the owner kept it. */
const ASK_EXCEPTIONS: Record<string, string[]> = {
	"tag force-move": [
		"git tag -f v1",
		"git tag --force v1",
		"git tag --forc v1",
		"git tag --f v1",
		"git tag -af v1 -m x",
		"git tag v1 -fm x",
		"git -C /repo tag -f v1",
		"cd /repo && git tag --force v1",
	],
	"commit --amend": [
		"git commit --amend",
		"git commit --amen --no-edit",
		"git commit --am",
		"git commit --a",
		'git commit --am"end"',
		"git -C /repo commit --amend -m x",
		"cd /repo && git commit --amend",
		"git commit -m 'a;b' --amend",
		'git commit -m "a|b" --amend',
	],
	"quoted separator before an exception": [
		"git tag 'x;y' -f v1",
		"git pull 'a;b' --upload-pack=x",
		"git merge 'a&b' -s ours",
		"git rebase 'a|b' --strategy ours",
		// A quoted separator first, then a quoted or escaped option.
		"git pull --server-option='a;b' \"--upload-pack=touch /tmp/pwn\" /r",
		"git commit -m 'a;b' '--amend'",
		"git commit -m 'a;b' --\"amend\"",
		"git commit -m 'a;b' --am\\end",
		"git tag 'a;b' '-f' v1",
		"git tag 'a;b' --fo\\rce v1",
		"git merge 'a;b' '-s' ours x",
		"git merge 'a;b' --str\\ategy=ours x",
		"git rebase 'a|b' -\\s ours main",
		"git rebase 'a|b' '-s' ours main",
	],
	"git -c override": [
		"git -c core.hooksPath=/x commit -m x",
		"git -c alias.x=y add .",
		// No `=`: pi rules are case-insensitive, so `-C` alone cannot tell
		// `-c <key>` apart. A config-key shaped value asks.
		"git -c core.hooksPath commit -m x",
		"git -c alias.x commit",
		"git -C /r -c core.fsmonitor commit -m x",
	],
	"brace expansion": [
		"git pull {--upload-pack=evil,/r}",
		"git commit -m x {--amend,}",
		"git commit {--amend,-m,x}",
		"git commit -m x --{amend,}",
		"git commit -m x {,--amend}",
		"git tag {-f,v1}",
		"git tag {-d,v1}",
		"git tag -{d,} v1",
		"git merge {-s,evil} x",
		"git rebase {-s,evil} main",
	],
	glob: ["git commit -m x *", "git add *", "git add [a-]*", "git add ?", "git add !(x)"],
	"transport helper URL": [
		"git pull ext::sh",
		"git pull 'ext::sh -c touch% /tmp/x'",
		"git merge fd::17",
		"git -C /repo pull origin ext::x",
	],
	"upload-pack": ["git pull --upload-pack=evil", "git pull --upl evil"],
	"merge strategy": [
		"git pull -s ours",
		"git merge -s ours x",
		"git merge -sours x",
		"git merge --strategy=ours x",
		"git merge --strat ours x",
		"git rebase -s ours main",
		"git rebase -is ours main",
		"git rebase --strategy ours main",
	],
	"unknown global option": [
		"git --git-dir=/x commit -m x",
		"git --work-tree /x add .",
		"git --exec-path=/x merge y",
		"git --bare tag v1",
	],
	"runtime-shaped": ['git commit -m "$(date)"', 'git commit -m "$MSG"', "git commit -m `date`"],
	wrapped: [
		"env git commit -m x",
		"GIT_DIR=/x git add .",
		"command git merge x",
		"sudo git tag v1",
		"nohup git rebase main",
		"cd /repo && env git commit -m x",
		"echo $(git commit -m x)",
		"echo `git add .`",
	],
};

const STILL_ASK = [
	"git push",
	"git -C /repo push",
	"cd /repo && git push",
	"git push --force origin main",
	"gh pr create --fill",
	"gh pr merge 1",
	"gh run list",
	"gh release create v1",
	"git reset --soft HEAD~1",
];

const TAG_DELETE = [
	"git tag -d v1",
	"git tag --delete v1",
	"git tag -fd v1",
	"git -C /repo tag -d v1",
	"git tag -dv1",
	"git tag -d1",
	"git tag --format=%(refname) -d v1",
	// A quoted separator before the delete flag must not end the scan.
	"git tag 'x;y' -d v1",
	'git tag "a|b" -d v1',
	'git tag "a&b" --delete v1',
	"git tag --sort=';' -d v1",
	"git tag 'a\nb' -d v1",
	"git -C /r tag 'a;b' -d v1",
	"cd /r && git tag 'a;b' -d v1",
	// A quoted separator first, then a quoted or escaped delete flag.
	"git tag 'a;b' -\\d v1",
	"git tag 'a;b' '-d' v1",
	"git tag 'a;b' -\"d\" v1",
	"git tag 'a;b' \\-d v1",
	"git tag 'a;b' \"--delete\" v1",
];

// Accepted over-asks. pi also tests each ask rule against the command with its
// quotes removed (shared gate code), so a quoted glob, brace, `$`, or option
// text reads as unquoted. These ask although bash would not expand them.
const OVER_ASK = [
	"git add '*.ts'",
	"git commit -m 'why? [x]'",
	'git commit -m "fix {x}"',
	"git commit -m 'cost $5'",
	'git commit -m "remove --amend usage"',
	"git -C my.repo commit -m x",
];

// pi cannot ask for these forms: the agent deny list blocks `bash -c`, and an
// xargs prefix or a path to git matches no ask or allow rule, so it falls to
// deny-by-default. Deny is the accepted fallback for these forms only.
const WRAPPED_DENY = ["bash -c 'git commit -m x'", "sh -c 'git add .'"];
const WRAPPED_DEFAULT = ["xargs git commit -m x", "/usr/bin/git commit -m x"];

describe("pi orchestrator: plain history commands allow", () => {
	test("plain forms allow", () => {
		for (const command of PLAIN_HISTORY) assert.equal(verdict("orchestrator", command), "allow", command);
	});

	test("git -C, pager flags, and the cd fold allow", () => {
		for (const command of ANCHORED_HISTORY) assert.equal(verdict("orchestrator", command), "allow", command);
	});

	test("a chain of plain history commands allows", () => {
		for (const command of ["git add . && git commit -m x", "git status && git add .", "git pull && git log"]) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("a chain with a blocked npm form does not allow", () => {
		// `npm test -- --watch` sits one token from the allowed `npm test`, so the
		// chain proves the allow anchor holds inside a chain.
		assert.equal(verdict("orchestrator", "git add . && npm test"), "allow");
		assert.equal(verdict("orchestrator", "git add . && npm test -- --watch"), "default");
	});
});

describe("pi orchestrator: history exception forms ask", () => {
	for (const [reason, commands] of Object.entries(ASK_EXCEPTIONS)) {
		test(`${reason} asks`, () => {
			for (const command of commands) assert.equal(verdict("orchestrator", command), "ask", command);
		});
	}

	test("push, gh pr, gh run, gh release, and reset --soft still ask", () => {
		for (const command of STILL_ASK) assert.equal(verdict("orchestrator", command), "ask", command);
		// `gh run` does not overreach: a sibling subcommand and a longer word stay deny-by-default.
		assert.equal(verdict("orchestrator", "gh issue list"), "default", "gh issue list");
		assert.equal(verdict("orchestrator", "gh runner list"), "default", "gh runner list");
		// A gh global option before the subcommand names no ask entry, so it falls to default.
		assert.equal(verdict("orchestrator", "gh -R owner/repo run list"), "default", "gh -R owner/repo run list");
	});

	test("quoted glob, brace, and option text over-ask (accepted, safe side)", () => {
		for (const command of OVER_ASK) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("tag delete still denies", () => {
		for (const command of TAG_DELETE) assert.equal(verdict("orchestrator", command), "deny", command);
	});

	test("wrapped forms pi cannot ask for deny, never allow", () => {
		for (const command of WRAPPED_DENY) assert.equal(verdict("orchestrator", command), "deny", command);
		for (const command of WRAPPED_DEFAULT) assert.equal(verdict("orchestrator", command), "default", command);
	});
});

describe("pi orchestrator: a session allow approves a segment only when every matching ask is allowed", () => {
	const UPLOAD = "pull --upload-pack requires user approval";
	const STRATEGY = "merge strategy requires user approval";
	const GLOB = "glob or brace expansion in a git history command requires user approval";
	const AMEND = "commit --amend requires user approval";
	const CASES: { command: string; rules: string[] }[] = [
		{ command: "git pull -s ours --upload-pack=evil /r", rules: [STRATEGY, UPLOAD] },
		{ command: "git pull {x,} --upload-pack=evil /r", rules: [GLOB, UPLOAD] },
		{ command: "git commit --amend *", rules: [AMEND, GLOB] },
	];
	const sessionVerdict = (command: string, allowedReasons: string[]): Decision["kind"] => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		return evaluateCommandRules(command, true, ruleSets, mode, "bash", "orchestrator", {
			isSessionAllowed: (rule) => allowedReasons.includes(rule.reason ?? ""),
		}).kind;
	};

	for (const { command, rules } of CASES) {
		test(`one allowed rule still asks: ${command}`, () => {
			for (const reason of rules) assert.equal(sessionVerdict(command, [reason]), "ask", `${command} with ${reason}`);
		});

		test(`all matching rules allowed allows: ${command}`, () => {
			assert.equal(sessionVerdict(command, rules), "allow", command);
		});
	}

	test("the prompt names the first matching rule not yet allowed", () => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		const allowed = new Set<string>([AMEND]);
		const evaluate = () =>
			evaluateCommandRules("git commit --amend *", true, ruleSets, mode, "bash", "orchestrator", {
				isSessionAllowed: (rule) => allowed.has(rule.reason ?? ""),
			});
		const first = evaluate();
		assert.equal(first.kind, "ask");
		if (first.kind !== "ask") return;
		assert.equal(first.rule.reason, GLOB);
		// "Always allow" on that prompt adds its rule; the command then allows.
		allowed.add(first.rule.reason ?? "");
		assert.equal(evaluate().kind, "allow");
	});
});

describe("pi non-orchestrators: history commands still block", () => {
	for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
		test(`${agent}: plain history forms do not allow`, () => {
			// A role never allows a history form: the kind is `deny` or `default`.
			for (const command of [...PLAIN_HISTORY, ...ANCHORED_HISTORY]) {
				const kind = verdict(agent, command);
				assert.ok(kind === "deny" || kind === "default", `${agent}: ${command}: ${kind}`);
			}
		});
	}

	// A role never allows `gh run` either. The implementer names it with a deny
	// entry; the other roles reach the block through deny-by-default.
	test("implementer: gh run names a deny entry", () => {
		assert.equal(verdict("implementer", "gh run list"), "deny");
	});

	for (const agent of PI_SHELL_AGENTS) {
		test(`${agent}: gh run falls to deny-by-default`, () => {
			assert.equal(verdict(agent, "gh run list"), "default");
		});
	}
});
