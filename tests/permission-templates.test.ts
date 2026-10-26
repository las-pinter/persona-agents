/**
 * Regression harness for the git-write permission doctrine on the pi platform.
 *
 * Loads the shipped pi agent frontmatters and asserts the verdict matrix:
 *   orchestrator                                -> ALLOW for a plain add/commit/pull; ASK for push and `gh pr`/`gh release`
 *   implementer                                 -> DENY for add/commit/push/pull and `gh pr`/`gh release`
 *   researcher/reviewer/tester/planner          -> DENY for push/pull and `gh pr`/`gh release`
 *
 * Also checks the live global file does not keep a push/pull or `gh pr` deny,
 * and that its global ask covers push and `gh pr` but not pull.
 * That check skips when the file is absent, because the file is outside the repo.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCommandRules, type Decision } from "../platforms/pi/extension/command-segments.ts";
import {
	KIRO_SHELL_AGENTS,
	OPENCODE_SHELL_AGENTS,
	PI_SHELL_AGENTS,
	kiroVerdict,
	loadGlobalRuleSets,
	loadKiroConfig,
	liveGlobalPath,
	opencodeVerdict,
	verdict,
} from "./permission-templates.fixtures.ts";

const WRITE_COMMANDS = [
	"git add agent-stack/foo.ts",
	'git commit -m "test"',
	"git push",
	"git pull",
	"gh pr create --fill",
];

const ANCHORED_COMMANDS = ["git -C /repo push", "cd /repo && git push"];

describe("git-write permission doctrine (pi templates)", () => {
	test("orchestrator: plain add/commit/pull allow; push and gh pr ask", () => {
		const allowed = ["git add agent-stack/foo.ts", 'git commit -m "test"', "git pull"];
		for (const command of [...WRITE_COMMANDS, ...ANCHORED_COMMANDS]) {
			const expected = allowed.includes(command) ? "allow" : "ask";
			assert.equal(verdict("orchestrator", command), expected, command);
		}
	});

	test("orchestrator: git show still runs", () => {
		assert.equal(verdict("orchestrator", "git show HEAD"), "allow");
	});

	test("implementer: add/commit/push/pull and gh pr all deny", () => {
		for (const command of [...WRITE_COMMANDS, ...ANCHORED_COMMANDS]) {
			assert.equal(verdict("implementer", command), "deny", command);
		}
	});

	test("non-orchestrators: compound npm test && git push denies", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			assert.equal(verdict(agent, "npm test && git push"), "deny", agent);
		}
	});

	for (const agent of PI_SHELL_AGENTS) {
		test(`${agent}: push/pull and gh pr deny`, () => {
			const commands = [
				"git push",
				"git pull",
				"gh pr create --fill",
				"git -C /repo push",
				"git -C /repo pull",
				"cd /repo && git push",
				"cd /repo && git pull",
			];
			for (const command of commands) {
				assert.equal(verdict(agent, command), "deny", command);
			}
		});
	}
});

test("live global permissions.json drops the git push/pull and gh pr denies and asks only for push", (t) => {
	const ruleSets = loadGlobalRuleSets();
	if (ruleSets === null) {
		t.skip(`${liveGlobalPath()} is absent; the live file is outside the repo`);
		return;
	}
	// Assert behavior, not rule text. A split into one rule per verb keeps the
	// same verdict, so the test must still pass while the behavior is correct.
	const globalVerdict = (command: string): Decision["kind"] =>
		evaluateCommandRules(command, true, ruleSets, "allow-unless-matched", "bash", null).kind;

	// No global git push/pull deny (bare and env-prefixed forms).
	for (const command of ["git push", "git pull", "env git push", "env git pull"]) {
		assert.notEqual(globalVerdict(command), "deny", `global deny must not keep a git push/pull rule: ${command}`);
	}
	// Global ask must cover bare git push, but not git pull: a global ask beats
	// the orchestrator's agent allow for a plain pull.
	assert.equal(globalVerdict("git push"), "ask", "global ask must include git push");
	assert.notEqual(globalVerdict("git pull"), "ask", "global ask must not include git pull");
	// No global gh pr deny (bare and env-prefixed forms).
	for (const command of ["gh pr create", "env gh pr create"]) {
		assert.notEqual(globalVerdict(command), "deny", `global deny must not keep a gh pr rule: ${command}`);
	}
	// Global ask must cover gh pr.
	assert.equal(globalVerdict("gh pr create"), "ask", "global ask must include gh pr");
});

// ---------------------------------------------------------------------------
// Cross-platform regression: env-prefix bypass, kiro bare forms, branch gate.
// ---------------------------------------------------------------------------



const ENV_PREFIXED = [
	"env git push",
	"GIT_DIR=/x git push",
	"time git commit",
	"nohup git push",
	"env gh pr create",
	"env git pull",
	"env git add .",
	"env git -C /repo push",
];

const WRITE_BARE = ["git push", "git pull", "git add .", "git commit -m x", "gh pr create", "git -C /repo push"];

const BRANCH_DESTRUCTIVE = [
	"git branch -D topic",
	"git branch -f topic",
	"git branch -m old new",
	"git branch -M old new",
	"git branch --delete topic",
	"git branch --force topic",
	"git branch --move old new",
	"git branch --copy old new",
	"git branch -d topic",
	"git branch -c old new",
	"git branch -C old new",
	"env git branch -D topic",
	"env git branch -d topic",
	"git branch --de topic",
	"git branch --d topic",
	"git branch --del topic",
	"git branch --dele topic",
	"git branch --delet topic",
	"git branch --for topic",
	"git branch --forc topic",
	"git branch --mov old new",
	"git branch --mo old new",
	"git branch --cop old new",
];

const READ_ONLY_BRANCH = [
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch --list",
	"git branch --show-current",
	"git branch --format='%(refname)'",
	"git branch --format=%(refname)",
];

const XARGS_WRITES = [
	"xargs git push",
	"xargs git pull",
	"xargs git add .",
	"xargs git commit -m x",
	"xargs gh pr create",
	"xargs git -C /repo push",
];

const SUBSTITUTION_WRITES = [
	"echo $(git push)",
	"echo `git push`",
	"echo $(git commit -m x)",
	"git --git-dir=/x push",
	"git --git-dir=/x add .",
	"git --git-dir=/x commit -m x",
	"git -c foo=bar commit",
	"git -p push",
	"git --no-pager push",
	"git --work-tree=/x push",
	"gh -R owner/repo pr create",
];

const SUDO_FLAG_WRITES = [
	"env -i sudo git push",
	"env sudo -E git push",
	"env sudo -u root git push",
];

describe("pi: env-prefix bypass and branch gate", () => {
	test("orchestrator: env-prefixed writes ask", () => {
		for (const command of ENV_PREFIXED) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: env-prefixed writes deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of ENV_PREFIXED) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("orchestrator: destructive branch asks, read-only stays allowed", () => {
		for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict("orchestrator", command), "ask", command);
		assert.equal(verdict("orchestrator", "git branch -a"), "allow");
		assert.equal(verdict("orchestrator", "git branch"), "allow");
	});

	test("non-orchestrators: destructive branch denies, read-only not denied", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			assert.notEqual(verdict(agent, "git branch -a"), "deny", `${agent}: git branch -a`);
		}
	});

	test("planner: sudo-prefixed git push denies", () => {
		assert.equal(verdict("planner", "sudo -E env git push"), "deny");
	});

	test("xargs-wrapped git push is blocked, never ask", () => {
		for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
			const kind = verdict(agent, "xargs git push");
			assert.notEqual(kind, "ask", agent);
			assert.notEqual(kind, "allow", agent);
		}
	});

	test("orchestrator: sudo option-flag writes ask", () => {
		for (const command of SUDO_FLAG_WRITES) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: sudo option-flag writes deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of SUDO_FLAG_WRITES) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});



describe("opencode: env-prefix bypass and branch gate", () => {
	test("orchestrator: writes ask", () => {
		// A plain add or commit allows the opencode orchestrator (owner choice).
		// git pull, the env-prefixed forms, push, and gh pr still ask.
		const plainHistory = new Set(["git add .", "git commit -m x"]);
		for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
			const expected = plainHistory.has(command) ? "allow" : "ask";
			assert.equal(opencodeVerdict("orchestrator", command), expected, command);
		}
	});

	test("non-orchestrators: env-prefixed and bare writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of BRANCH_DESTRUCTIVE) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: destructive branch asks", () => {
		for (const command of BRANCH_DESTRUCTIVE) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: read-only branch stays not denied", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of READ_ONLY_BRANCH) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: xargs-wrapped writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of XARGS_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: xargs-wrapped writes ask", () => {
		for (const command of XARGS_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});
});

describe("kiro: bare forms, env-prefix bypass, and branch gate", () => {
	test("orchestrator: writes default to ask", () => {
		for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: bare and env-prefixed writes deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of BRANCH_DESTRUCTIVE) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: destructive branch asks", () => {
		for (const command of BRANCH_DESTRUCTIVE) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("xargs-wrapped git push denies for non-orchestrators and asks for orchestrator", () => {
		for (const agent of KIRO_SHELL_AGENTS) assert.equal(kiroVerdict(agent, "xargs git push"), "deny", agent);
		assert.equal(kiroVerdict("orchestrator", "xargs git push"), "ask");
	});

	test("non-orchestrators: a branch listing is not denied", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of READ_ONLY_BRANCH) {
				// A regex can tell a create from a listing, so the deny fences only
				// the create and the write flags.
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

describe("opencode: command-substitution and option-form bypass", () => {
	test("orchestrator: substitution and option-form writes ask", () => {
		for (const command of SUBSTITUTION_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: substitution and option-form writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of SUBSTITUTION_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

describe("kiro: command-substitution and option-form bypass", () => {
	// Kiro has no ask list: an unlisted command falls to its default ask, so the
	// orchestrator's substitution forms ask without an explicit rule.
	test("orchestrator: substitution and option-form writes default to ask", () => {
		for (const command of SUBSTITUTION_WRITES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: substitution and option-form writes deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of SUBSTITUTION_WRITES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Kiro read-only verdicts. All six shell templates set the detector off, so
// the three tiers decide: an allow entry runs silently, a deny entry blocks,
// and an unmatched command asks. The deny entries fence the fetch, remote, and
// branch write forms; the allow list carries the reads a role needs.
// ---------------------------------------------------------------------------

const KIRO_READONLY_DETECTOR_DENIES = [
	"git fetch",
	"git fetch origin",
	"git fetch --tags origin",
	"cd /repo && git fetch origin",
	"cd /repo && git fetch",
	"x; git fetch",
	"git fetch; git log",
	"git fetch&&git log",
	"git remote update origin",
	"x; git remote update",
	"cd /repo && git remote update",
	"git remote show origin",
	"git branch feature-x",
	"git branch -t origin/main",
	"git branch --contains HEAD newbranch",
	"git branch --format=%(refname) newbranch",
];

// A listing keeps the value on the option, so no name token follows it. These
// forms must stay not denied, because only a create carries a second token.
const KIRO_BRANCH_LISTINGS = ["git branch --contains HEAD", "git branch --format=%(refname)"];

const KIRO_SHELL_TEMPLATES = ["orchestrator", ...KIRO_SHELL_AGENTS];

const KIRO_BRANCH_LISTING_ALLOWS = [
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch -v",
	"git branch -vv",
	"git branch -l",
	"git branch --list",
	"git branch --all",
	"git branch --remotes",
	"git branch --verbose",
	"git branch --show-current",
	"git branch --merged",
	"git branch --no-merged",
	"git branch --contains HEAD",
	"git branch --points-at HEAD",
	"git branch --sort=-committerdate",
	"git branch --format=%(refname)",
	"git branch --column=always",
	"git branch --omit-empty",
	"git branch --ignore-case",
];

const KIRO_TAG_READ_ALLOWS = ["git tag", "git tag -l", "git tag --list"];

// A value option must hold exactly one token. A trailing name token is a create.
const KIRO_BRANCH_VALUE_CREATES = [
	"git branch --sort=-committerdate evil",
	"git branch --column=always evil",
	"git status && git branch --sort=-committerdate evil",
	"git status && git branch --column=always evil",
];

const KIRO_BRANCH_VALUE_LISTINGS = ["git branch --sort=-committerdate", "git branch --column=always"];

// A tag create is any option sequence plus a name token. These flags escaped the
// old fence, which named only the write letters it knew.
const KIRO_TAG_WRITE_FLAGS = [
	"git tag -s v1 -m m",
	"git tag --sign v1",
	"git tag -S v1 -m m",
	"git tag -e v1",
	"git tag --annotate v1 -m m",
	"git status && git tag -s v1 -m m",
];

const KIRO_REMOTE_READ_ALLOWS = ["git remote", "git remote -v", "git remote get-url"];

const KIRO_READ_VERB_ALLOWS = [
	"git blame",
	"git describe",
	"git shortlog",
	"git reflog",
	"git rev-parse",
	"git rev-list",
	"git ls-files",
	"git show-ref",
	"git for-each-ref",
	"git cat-file",
	"git count-objects",
	"git log",
	"git diff",
	"git show",
	"git status",
];

const KIRO_SYSTEM_READ_ALLOWS = [
	"ls",
	"cat",
	"head",
	"tail",
	"find",
	"grep",
	"wc",
	"echo",
	"pwd",
	"date",
	"diff",
	"file",
	"uname",
	"which",
];

const KIRO_ORCH_READ_FORMS = [
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch --show-current",
	"git tag",
	"git tag -l",
	"git remote",
	"git remote -v",
];

describe("kiro: the six shell templates decide by allow, deny, and ask", () => {
	for (const agent of KIRO_SHELL_AGENTS) {
		test(`${agent}: fetch, remote show/update, and a branch create deny`, () => {
			for (const command of KIRO_READONLY_DETECTOR_DENIES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});

		test(`${agent}: branch, tag, remote, read verbs, and system reads allow`, () => {
			for (const command of [
				...KIRO_BRANCH_LISTING_ALLOWS,
				...KIRO_TAG_READ_ALLOWS,
				...KIRO_REMOTE_READ_ALLOWS,
				...KIRO_READ_VERB_ALLOWS,
				...KIRO_SYSTEM_READ_ALLOWS,
			]) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
	}

	test("all six shell templates set the read-only detector off", () => {
		for (const agent of KIRO_SHELL_TEMPLATES) {
			assert.equal(
				loadKiroConfig(agent).toolsSettings?.shell?.autoAllowReadonly,
				false,
				`${agent}: autoAllowReadonly`,
			);
		}
	});

	test("a branch listing that keeps its value on the option stays not denied", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of KIRO_BRANCH_LISTINGS) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("a branch create behind a value option denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of KIRO_BRANCH_VALUE_CREATES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("a value-option branch listing stays allowed", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of KIRO_BRANCH_VALUE_LISTINGS) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("a tag create with any write flag denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of KIRO_TAG_WRITE_FLAGS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("an exact tag listing still allows", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of ["git tag -l", "git tag --list"]) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("no value-taking allow entry ends in a bare dot-star", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			const allowed = loadKiroConfig(agent).toolsSettings?.shell?.allowedCommands ?? [];
			for (const entry of allowed) {
				const isValueEntry =
					/^git branch --(?:contains|points-at|sort=|format=|column=)/.test(entry) ||
					/^git remote get-url /.test(entry);
				if (!isValueEntry || !entry.endsWith(".*")) continue;
				assert.fail(`${agent}: a value allow entry ends in a bare dot-star: ${entry}`);
			}
		}
	});

	test("a boolean listing option followed by a branch name denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			assert.equal(kiroVerdict(agent, "git branch --no-color evil"), "deny", `${agent}: boolean listing create`);
		}
	});

	test("orchestrator: branch, tag, and remote read forms still allow", () => {
		for (const command of KIRO_ORCH_READ_FORMS) {
			assert.equal(kiroVerdict("orchestrator", command), "allow", command);
		}
	});
});

// ---------------------------------------------------------------------------
// Kiro fence table. The five role templates must deny every branch and tag
// write behind every wrapper, keep the read forms silent, and leave a tag
// listing with a pattern argument to ask.
// ---------------------------------------------------------------------------

const KIRO_FENCE_AGENTS = ["implementer", "tester", "researcher", "reviewer", "planner"];

const KIRO_BRANCH_BOOLEAN_LISTING = [
	"-a",
	"-r",
	"-v",
	"-vv",
	"-l",
	"-i",
	"--all",
	"--remotes",
	"--verbose",
	"--omit-empty",
	"--ignore-case",
	"--quiet",
	"--no-color",
];

const KIRO_BRANCH_WRITE_FORMS = [
	"git branch evil",
	"git branch feature-x",
	...KIRO_BRANCH_BOOLEAN_LISTING.map((option) => `git branch ${option} evil`),
	"git branch -d x",
	"git branch -D x",
	"git branch -m a b",
	"git branch -M a b",
	"git branch -c a b",
	"git branch -C a b",
	"git branch -f x y",
	"git branch -u origin/main",
	"git branch -t origin/main",
	"git branch --set-upstream-to=origin/main",
	"git branch --contains HEAD evil",
	"git branch --points-at HEAD evil",
	"git branch --merged main evil",
	"git branch --no-merged main evil",
	"git branch --sort=-committerdate evil",
	"git branch --column=always evil",
	"git branch --format=%(refname) evil",
];

const KIRO_TAG_WRITE_BARE_FORMS = [
	"git tag v1",
	"git tag -a v1",
	"git tag -s v1 -m m",
	"git tag -S v1 -m m",
	"git tag -e v1",
	"git tag -u k v1",
	"git tag -m m v1",
	"git tag -F f v1",
	"git tag --annotate v1",
	"git tag --sign v1",
	"git tag --local-user k v1",
	"git tag --cleanup=strip v1",
	"git tag -d v1",
	"git tag -f v1",
];

/** The bare form plus the wrapper forms the fence must cover. */
function kiroFenceForms(command: string): string[] {
	const rest = command.replace(/^git /, "");
	return [
		command,
		`git status; ${command}`,
		`git status && ${command}`,
		`git status | ${command}`,
		`echo $(${command})`,
		`echo \`${command}\``,
		`git -C /repo ${rest}`,
		` ${command}`,
	];
}

const KIRO_BRANCH_WRITE_DENY = KIRO_BRANCH_WRITE_FORMS.flatMap(kiroFenceForms);
const KIRO_TAG_WRITE_DENY = KIRO_TAG_WRITE_BARE_FORMS.flatMap(kiroFenceForms);

const KIRO_BRANCH_READ_ALLOW = [
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch -v",
	"git branch -vv",
	"git branch -l",
	"git branch --list",
	"git branch --all",
	"git branch --remotes",
	"git branch --verbose",
	"git branch --show-current",
	"git branch --merged",
	"git branch --no-merged",
	"git branch --omit-empty",
	"git branch --ignore-case",
	"git branch --contains HEAD",
	"git branch --points-at HEAD",
	"git branch --merged main",
	"git branch --no-merged main",
	"git branch --sort=-committerdate",
	"git branch --column=always",
	"git branch --format=%(refname)",
];

const KIRO_TAG_READ_ALLOW = [
	"git tag",
	"git tag -l",
	"git tag --list",
	"git tag --contains HEAD",
	"git tag --merged main",
	"git tag --points-at HEAD",
	"git tag -v v1",
];

const KIRO_TAG_FILTERED_ASK = ["git tag -l v1"];

describe("kiro: the five role templates fence every branch and tag write", () => {
	for (const agent of KIRO_FENCE_AGENTS) {
		test(`${agent}: branch write forms deny, wrapped or not`, () => {
			for (const command of KIRO_BRANCH_WRITE_DENY) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});

		test(`${agent}: tag write forms deny, wrapped or not`, () => {
			for (const command of KIRO_TAG_WRITE_DENY) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});

		test(`${agent}: branch and tag read forms allow`, () => {
			for (const command of [...KIRO_BRANCH_READ_ALLOW, ...KIRO_TAG_READ_ALLOW]) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});

		test(`${agent}: a tag listing with a pattern argument asks`, () => {
			for (const command of KIRO_TAG_FILTERED_ASK) {
				assert.equal(kiroVerdict(agent, command), "ask", `${agent}: ${command}`);
			}
		});

		test(`${agent}: a tag read with an option stays allowed`, () => {
			for (const command of [
				"git tag --contains HEAD",
				"git tag --merged main",
				"git tag --points-at HEAD",
				"git tag -v v1",
			]) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
	}
});
