/**
 * Permission regression harness for the read-only role fences.
 *
 * Covers the pi, kiro, and opencode read-only roles and the allow-list shrink
 * that closes the known write and exec holes.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { compileRegex } from "../platforms/pi/extension/command-segments.ts";
import {
	hasKiroDeny,
	hasOpenCodeRule,
	kiroVerdict,
	loadAgentRules,
	loadKiroConfig,
	opencodeVerdict,
	ruleSetMatches,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// Process substitution and chain-guard over-ask.
// ---------------------------------------------------------------------------

describe("process substitution and chain-guard over-ask", () => {
	test("pi orchestrator: an inner process substitution asks", () => {
		// pi parses `<(...)`, so the git read plus the inner `echo` would both
		// allow; the process-substitution ask rule fires on the raw segment.
		assert.equal(verdict("orchestrator", "git grep x <(echo y)"), "ask");
	});

	test("opencode orchestrator: the & and > guards over-ask URL arguments (fail-safe)", () => {
		// Accepted trade-off: `*&*` and `*>*` match argument content, so a
		// harmless `git remote get-url 'https://x?a=1&b=2'` asks.
		for (const command of [
			"git remote get-url 'https://x?a=1&b=2'",
			"git remote get-url 'https://x?a=1>b=2'",
		]) {
			assert.notEqual(opencodeVerdict("orchestrator", command), "allow", command);
		}
	});
});

// ---------------------------------------------------------------------------
// opencode matches the raw command string with last-match-wins, so a read allow
// that ends in `*` covers a whole chain. The chain guards must make every chain
// ask (or deny) while a single read with no separator still allows.
// ---------------------------------------------------------------------------

const CHAIN_GUARD_WRITES = [
	"git grep x && git rm -rf y",
	"git grep x; git config user.email evil@x",
	"git grep x && git update-ref refs/heads/x HEAD",
	"git grep x && git stash push",
	"git grep x && git branch newbranch",
	"git grep x && git notes add -m x",
	"git grep x && git worktree add ../x",
	"git grep x && git reflog expire --all",
	"git grep x && git remote add x url",
	"git grep x && git hash-object -w f",
	"git grep x && git fsck --lost-found",
	"git grep x && rm -rf /",
	"git tag -l; git rm -rf y",
	"git merge-base x && rm -rf y",
	"git grep x || git rm -rf y",
	"git grep x | git rm -rf y",
	"git grep x & git rm -rf y",
	"git grep x `rm -rf y`",
	"git grep x $(rm -rf y)",
	"git grep x\nrm -rf y",
	"git grep x > /etc/passwd",
	"git grep x >> /etc/passwd",
	// widened pure-read verbs must not swallow a chained write
	"git log --oneline && git push",
	"git show HEAD; git tag -f v1",
	"git diff --stat | git commit -F -",
	"git cat-file -p HEAD && git reset --hard",
];

const OPENCODE_PLAIN_READ_ALLOWS = ["git tag -l", "git tag --list", "git branch"];

// Argument reads that no longer carry a free-argument allow on opencode. A
// raw-match engine cannot dequote, so these fall to the shell default: ask.
const OPENCODE_PLAIN_READ_ASKS = ["git grep -n x", "git merge-base x"];

describe("opencode: chain guards and read allows", () => {
	test("orchestrator: a chained read plus write asks", () => {
		for (const command of CHAIN_GUARD_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: pi and kiro never allow the same chains", () => {
		// pi tests each segment on its own. A read piped into a plain commit is
		// two allowed segments, so it allows the pi orchestrator (owner choice:
		// a plain commit runs without a prompt). kiro keeps asking for it.
		const piPlainChains = new Set(["git diff --stat | git commit -F -"]);
		for (const command of CHAIN_GUARD_WRITES) {
			if (piPlainChains.has(command)) assert.equal(verdict("orchestrator", command), "allow", `pi: ${command}`);
			else assert.notEqual(verdict("orchestrator", command), "allow", `pi: ${command}`);
			assert.notEqual(kiroVerdict("orchestrator", command), "allow", `kiro: ${command}`);
		}
	});

	test("orchestrator: a plain read with no separator allows the exact forms", () => {
		for (const command of OPENCODE_PLAIN_READ_ALLOWS) {
			assert.equal(opencodeVerdict("orchestrator", command), "allow", command);
		}
		for (const command of OPENCODE_PLAIN_READ_ASKS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: the chain-guard rules exist", () => {
		for (const resource of ["*;*", "*&*", "*|*", "*>*", "*$(*", "*`*", "*\n*", "*<(*", "*=(*"]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "ask"), `missing {shell, ${resource}, ask}`);
		}
	});

	test("orchestrator: a piped read asks (fail-safe over-ask without a parser)", () => {
		assert.equal(opencodeVerdict("orchestrator", "git grep x | head"), "ask");
	});
});

// ---------------------------------------------------------------------------
// Silent escapes that carry NO shell separator. The read allows are broad
// enough to admit `git grep -O<pager>` (the pager runs as a shell command),
// the diff-family `--output=<file>` write, and process substitution. The chain
// guards cannot see them, because no guarded character is present. Every form
// must ask (or deny), never allow, on pi and opencode.
// ---------------------------------------------------------------------------

const SILENT_ESCAPE_COMMANDS = [
	"git grep -O'touch /tmp/x' TODO",
	'git grep -O"touch /tmp/x" TODO',
	"git grep --open-files-in-pager='touch /tmp/x' TODO",
	"git grep --open-files-in-pager=touch TODO",
	"git grep --open-files-in-pager touch TODO",
	"git -C /repo grep -O'touch /tmp/x' TODO",
	"git --no-pager grep -O'touch /tmp/x' TODO",
	"git diff-tree --output=/tmp/x",
	"git diff-index --output=/tmp/x HEAD",
	"git diff-files --output=/tmp/x",
	"git whatchanged --output=/tmp/x",
	"git log --output=/tmp/x",
	"git diff --output=/tmp/x",
	"git show --output=/tmp/x HEAD",
	"git diff-tree --output /tmp/x",
	"git log --ext-diff",
	"git diff --textconv",
	"git cat-file --filters HEAD",
	"git grep x <(rm -rf y)",
	"git grep x =(rm -rf y)",
];

const OPENCODE_SILENT_ESCAPE_ASKS = [
	"*grep -O*",
	"*grep --open-files-in-pager*",
	"*--output=*",
	"*--output *",
	"*--ext-diff*",
	"*--textconv*",
	"*--filters*",
	"*<(*",
	"*=(*",
];

describe("silent escapes never allow (no shell separator)", () => {
	test("pi orchestrator: the silent-escape ask rules exist", () => {
		const { ruleSets } = loadAgentRules("orchestrator");
		for (const command of SILENT_ESCAPE_COMMANDS) {
			assert.ok(ruleSetMatches(ruleSets.agentAsk, command), `missing pi ask rule for ${command}`);
		}
	});

	test("pi orchestrator: every silent escape asks or denies, never allows", () => {
		for (const command of SILENT_ESCAPE_COMMANDS) {
			assert.notEqual(verdict("orchestrator", command), "allow", command);
		}
	});

	test("opencode orchestrator: the silent-escape ask rules exist", () => {
		for (const resource of OPENCODE_SILENT_ESCAPE_ASKS) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "ask"), `missing {shell, ${resource}, ask}`);
		}
	});

	test("opencode orchestrator: every silent escape asks or denies, never allows", () => {
		for (const command of SILENT_ESCAPE_COMMANDS) {
			assert.notEqual(opencodeVerdict("orchestrator", command), "allow", command);
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only roles: an allowed read verb must not carry a write option or a
// command-execution option. The plain read form stays allowed. The roles differ
// in which verbs they allow, so the cases are grouped by the verb set.
// ---------------------------------------------------------------------------

const PI_READ_ONLY_COMMON_WRITES_AND_EXECS = [
	"mkdir foo",
	"sort -o out in",
	"sort --output=out in",
	"uniq in out",
	"rg --pre 'cmd' x",
	"rg --pre=cmd x",
	"rg -z x",
	"date -s '2020-01-01'",
];

const PI_READ_ONLY_GIT_WRITES = [
	"git log --output=/tmp/x",
	"git diff --output=/tmp/x",
	"git show --output=/tmp/x HEAD",
	"git grep -O'touch /tmp/x' TODO",
	"git grep --open-files-in-pager=touch TODO",
	"git branch newbranch",
	"git branch -u origin/main",
	"git branch --format=%(refname) newbranch",
	"git branch --contains HEAD newbranch",
];

const PI_READ_ONLY_READS = [
	"rg -n x",
	"date -Iseconds",
];

describe("read-only roles: an allowed read never carries a write or an exec", () => {
	for (const agent of ["reviewer", "researcher", "planner"]) {
		test(`pi ${agent}: common file writes deny`, () => {
			for (const command of PI_READ_ONLY_COMMON_WRITES_AND_EXECS) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`pi ${agent}: common read forms stay allowed`, () => {
			for (const command of PI_READ_ONLY_READS) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
	}

	for (const agent of ["reviewer", "researcher"]) {
		test(`pi ${agent}: git write options deny`, () => {
			for (const command of PI_READ_ONLY_GIT_WRITES) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`pi ${agent}: plain git reads allow`, () => {
			for (const command of ["git status", "git log --oneline", "git diff HEAD"]) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
		test(`pi ${agent}: removed git verbs fall to the default verdict`, () => {
			for (const command of [
				"git grep -n x",
				"git branch -a",
				"git cat-file -p HEAD",
				"git ls-remote origin",
			]) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		});
	}

	for (const agent of ["reviewer", "researcher"]) {
		test(`pi ${agent}: xxd outfile and cat-file filters deny`, () => {
			for (const command of [
				"xxd in out",
				"git cat-file --filters HEAD",
				"git cat-file --textconv HEAD",
			]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`pi ${agent}: the xxd read is no longer allowed`, () => {
			assert.equal(verdict(agent, "xxd in"), "default", `${agent}: xxd in`);
		});
		test(`pi ${agent}: the cat-file read falls to the default verdict`, () => {
			assert.equal(verdict(agent, "git cat-file -p HEAD"), "default", `${agent}: git cat-file`);
		});
	}

	test("pi reviewer: the no-emit type check allows, the emitting form denies", () => {
		for (const command of ["tsc", "tsc --build"]) {
			assert.equal(verdict("reviewer", command), "deny", command);
		}
		for (const command of ["tsc --noEmit", "tsc -p . --noEmit"]) {
			assert.equal(verdict("reviewer", command), "allow", command);
		}
	});

	test("pi reviewer: the project gate forms allow", () => {
		for (const command of ["npm test", "npm run typecheck", "npm run lint", "tsc --noEmit"]) {
			assert.equal(verdict("reviewer", command), "allow", command);
			assert.ok(piAllowMatches("reviewer", command), `allow missing: ${command}`);
		}
	});

	test("pi reviewer: the emitting and fixing forms still deny", () => {
		assert.equal(verdict("reviewer", "tsc"), "deny");
		assert.equal(verdict("reviewer", "tsc --build"), "deny");
		for (const command of ["pytest --junitxml=out.xml", "mypy .", "ruff check --fix", "ruff format"]) {
			assert.notEqual(verdict("reviewer", command), "allow", command);
		}
	});

	test("pi read-only roles: the uniq option terminator and dash operand forms deny", () => {
		for (const agent of ["reviewer", "researcher", "planner"]) {
			for (const command of ["uniq -- in out", "uniq in -- out", "uniq in -out"]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
				assert.ok(!piAllowMatches(agent, command), `allow re-added: ${command}`);
			}
		}
	});

	test("pi reviewer and researcher: the xxd option terminator and dash operand forms deny", () => {
		for (const agent of ["reviewer", "researcher"]) {
			for (const command of ["xxd -- in out", "xxd in -- out", "xxd in -out"]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
				assert.ok(!piAllowMatches(agent, command), `allow re-added: ${command}`);
			}
		}
	});

	test("pi implementer and tester: the ls-remote upload and exec options deny", () => {
		for (const agent of ["implementer", "tester"]) {
			for (const command of ["git ls-remote --upload-pack=cmd origin", "git ls-remote --exec=cmd origin"]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
			assert.equal(verdict(agent, "git ls-remote origin"), "allow", `${agent}: plain ls-remote`);
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only roles on kiro and opencode. Both engines match the raw command
// string with globs, so each write class is fenced by an explicit deny entry.
// The common, git, and xxd classes follow the pi per-role split. A blanket
// redirect deny also denies the harmless fd-dup form; that fail-safe over-deny
// is pinned here.
// ---------------------------------------------------------------------------

// A bare `git branch NAME` cannot be fenced by a glob without also denying a
// listing, so the branch-create option forms carry the class on these engines.
const RAW_READ_ONLY_GIT_WRITES = [
	"git log --output=/tmp/x",
	"git diff --output=/tmp/x",
	"git show --output=/tmp/x HEAD",
	"git grep -O'touch /tmp/x' TODO",
	"git grep --open-files-in-pager=touch TODO",
	"git branch -u origin/main",
	"git branch --format=%(refname) newbranch",
	"git branch --contains HEAD newbranch",
];

const RAW_READ_ONLY_XXD_WRITES = [
	"xxd in out",
	"git cat-file --filters HEAD",
	"git cat-file --textconv HEAD",
];

const RAW_READ_ONLY_COMMON_READS = ["cat", "date", "uniq"];
const RAW_READ_ONLY_GIT_READS = ["git status", "git log", "git diff"];
const RAW_READ_ONLY_GIT_NOT_DENIED = ["git branch -a", "git grep -n x"];
const RAW_READ_ONLY_OTHER_READS = ["rg -n x", "date -Iseconds"];

const RAW_READ_ONLY_COMMON_DENIES = [
	"*mkdir*",
	"*sort*-o*",
	"*uniq* * ?*",
	"*rg*--pre*",
	"*rg*-z*",
	"*date*-s*",
	"*>*",
];

const RAW_READ_ONLY_GIT_DENIES = [
	"*git*--output*",
	"*git*--ext-diff*",
	"*git*--textconv*",
	"*git*--filters*",
	"*git*grep*-O*",
	"*git*grep*--open-files-in-pager*",
	"*git*branch*-u*",
	"*git*branch*-t ?*",
	"*git*branch*--track*",
	"*git*branch*--edit-description*",
	"*git*branch*--format*=* ?*",
	"*git*branch*--contains * ?*",
];

describe("kiro: read-only roles deny writes and keep the read forms", () => {
	for (const agent of ["reviewer", "researcher", "planner"]) {
		test(`kiro ${agent}: common write paths deny`, () => {
			for (const command of PI_READ_ONLY_COMMON_WRITES_AND_EXECS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`kiro ${agent}: common read forms allow`, () => {
			for (const command of RAW_READ_ONLY_COMMON_READS) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
		test(`kiro ${agent}: a redirect denies and the fd-dup form is over-denied`, () => {
			assert.equal(kiroVerdict(agent, "echo hi > out.txt"), "deny", "file redirect");
			assert.equal(kiroVerdict(agent, "echo hi 2>&1"), "deny", "fd-dup over-deny");
		});
		test(`kiro ${agent}: common and redirect deny entries exist`, () => {
			for (const pattern of RAW_READ_ONLY_COMMON_DENIES) {
				assert.ok(hasKiroDeny(agent, pattern), `missing deniedCommands ${pattern}`);
			}
		});
		test(`kiro ${agent}: the search and date reads are not denied`, () => {
			for (const command of RAW_READ_ONLY_OTHER_READS) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
	}

	for (const agent of ["researcher", "reviewer"]) {
		test(`kiro ${agent}: git write options deny`, () => {
			for (const command of RAW_READ_ONLY_GIT_WRITES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`kiro ${agent}: git reads allow and listings are not denied`, () => {
			for (const command of RAW_READ_ONLY_GIT_READS) {
				assert.equal(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
			for (const command of RAW_READ_ONLY_GIT_NOT_DENIED) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`kiro ${agent}: git deny entries exist`, () => {
			for (const pattern of RAW_READ_ONLY_GIT_DENIES) {
				assert.ok(hasKiroDeny(agent, pattern), `missing deniedCommands ${pattern}`);
			}
		});
	}

	for (const agent of ["researcher", "reviewer"]) {
		test(`kiro ${agent}: xxd second output and cat-file filters deny`, () => {
			for (const command of RAW_READ_ONLY_XXD_WRITES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`kiro ${agent}: the xxd read is not denied and the deny entry exists`, () => {
			assert.notEqual(kiroVerdict(agent, "xxd in"), "deny", `${agent}: xxd in`);
			assert.ok(hasKiroDeny(agent, "*xxd* * ?*"), "missing deniedCommands *xxd* * ?*");
		});
	}

	test("kiro reviewer: bare tsc denies, the no-emit form is not denied", () => {
		for (const command of ["tsc", "tsc --build"]) {
			assert.equal(kiroVerdict("reviewer", command), "deny", command);
		}
		assert.ok(hasKiroDeny("reviewer", "tsc"), "missing deniedCommands tsc");
		assert.ok(hasKiroDeny("reviewer", "tsc --build*"), "missing deniedCommands tsc --build*");
		for (const command of ["tsc --noEmit", "tsc -p . --noEmit"]) {
			assert.notEqual(kiroVerdict("reviewer", command), "deny", command);
		}
	});
});

describe("opencode: read-only roles deny writes and keep the read forms", () => {
	for (const agent of ["reviewer", "researcher", "planner"]) {
		test(`opencode ${agent}: common write paths deny`, () => {
			for (const command of PI_READ_ONLY_COMMON_WRITES_AND_EXECS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`opencode ${agent}: common read forms allow`, () => {
			for (const command of RAW_READ_ONLY_COMMON_READS) {
				assert.equal(opencodeVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		});
		test(`opencode ${agent}: a redirect denies and the fd-dup form is over-denied`, () => {
			assert.equal(opencodeVerdict(agent, "echo hi > out.txt"), "deny", "file redirect");
			assert.equal(opencodeVerdict(agent, "echo hi 2>&1"), "deny", "fd-dup over-deny");
		});
		test(`opencode ${agent}: common and redirect deny entries exist`, () => {
			for (const pattern of RAW_READ_ONLY_COMMON_DENIES) {
				assert.ok(hasOpenCodeRule(agent, pattern, "deny"), `missing {shell, ${pattern}, deny}`);
			}
		});
		test(`opencode ${agent}: the search and date reads are not denied`, () => {
			for (const command of RAW_READ_ONLY_OTHER_READS) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
	}

	for (const agent of ["researcher", "reviewer"]) {
		test(`opencode ${agent}: git write options deny`, () => {
			for (const command of RAW_READ_ONLY_GIT_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`opencode ${agent}: git reads allow and listings are not denied`, () => {
			for (const command of RAW_READ_ONLY_GIT_READS) {
				assert.equal(opencodeVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
			for (const command of RAW_READ_ONLY_GIT_NOT_DENIED) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`opencode ${agent}: git deny entries exist`, () => {
			for (const pattern of RAW_READ_ONLY_GIT_DENIES) {
				assert.ok(hasOpenCodeRule(agent, pattern, "deny"), `missing {shell, ${pattern}, deny}`);
			}
		});
	}

	for (const agent of ["researcher", "reviewer"]) {
		test(`opencode ${agent}: xxd second output and cat-file filters deny`, () => {
			for (const command of RAW_READ_ONLY_XXD_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		});
		test(`opencode ${agent}: the xxd read is not denied and the deny entry exists`, () => {
			assert.notEqual(opencodeVerdict(agent, "xxd in"), "deny", `${agent}: xxd in`);
			assert.ok(hasOpenCodeRule(agent, "*xxd* * ?*", "deny"), "missing xxd deny");
		});
	}

	test("opencode reviewer: bare tsc denies, the no-emit form is not denied", () => {
		for (const command of ["tsc", "tsc --build"]) {
			assert.equal(opencodeVerdict("reviewer", command), "deny", command);
		}
		assert.ok(hasOpenCodeRule("reviewer", "tsc", "deny"), "missing tsc deny");
		assert.ok(hasOpenCodeRule("reviewer", "tsc --build*", "deny"), "missing tsc --build deny");
		for (const command of ["tsc --noEmit", "tsc -p . --noEmit"]) {
			assert.notEqual(opencodeVerdict("reviewer", command), "deny", command);
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only allow-list shrink. Every entry that can write a file or run a
// command is removed from the allow list. With no allow, pi falls to its
// deny-by-default verdict and kiro/opencode fall to ask. These pins fail if a
// removal is undone.
// ---------------------------------------------------------------------------

const READ_ONLY_ROLES = ["reviewer", "researcher", "planner"];

// The abbreviated long option and the glued flag value close by removal.
const REMOVED_PI_HOLE_FORMS = [
	"mkdir foo",
	"sort --compress-program=cat in",
	"sort -T /tmp in",
	"git ls-remote --upload-pack=cmd origin",
	"git ls-remote --exec=cmd origin",
	"git cat-file --fil HEAD",
	"git grep --open TODO",
	"git branch -uorigin/main",
	"git branch --track=origin/main",
];

// A read form the removed reviewer test and lint tools would have admitted.
const REMOVED_REVIEWER_TOOL_FORMS = [
	"pytest --junitxml=out.xml",
	"python -m pytest --junit-xml=out.xml",
	"mypy .",
	"ruff check --fix",
	"ruff format",
];

// A read form the removed researcher test tools would have admitted.
const REMOVED_RESEARCHER_TOOL_FORMS = [
	"pytest --junitxml=out.xml",
	"python -m pytest --junit-xml=out.xml",
	"PYTHONDONTWRITEBYTECODE=1 python3 -m pytest",
	".venv/bin/python -m pytest",
];

const REMOVED_KIRO_ALLOWS: Record<string, string[]> = {
	researcher: ["sort", "git branch"],
	reviewer: ["sort", "git branch", "mypy", "ruff"],
	planner: ["sort", "mkdir"],
};

const REMOVED_OPENCODE_ALLOWS: Record<string, string[]> = {
	researcher: [
		"sort",
		"mkdir",
		"git branch",
		"git grep",
		"python -m pytest",
		"python3 -m pytest",
		"PYTHONDONTWRITEBYTECODE=1 python3 -m pytest",
		"PYTHONDONTWRITEBYTECODE=1 python -m pytest",
		".venv/bin/python -m pytest",
	],
	reviewer: [
		"sort",
		"git branch",
		"mypy",
		"ruff",
		"tsc",
		"pytest",
		"python -m pytest",
		"python3 -m pytest",
		".venv/bin/python -m pytest",
		".venv/bin/pre-commit",
	],
	planner: ["sort", "mkdir", "git branch"],
};

/** True when any pi allow rule matches the command text. */
function piAllowMatches(agent: string, command: string): boolean {
	const { ruleSets } = loadAgentRules(agent);
	return ruleSets.agentAllow.some(
		(rule) =>
			(rule.tool === "bash" || rule.tool === undefined) && compileRegex(rule.match).test(command),
	);
}

/** True when a kiro agent's allowedCommands carries the exact pattern. */
function hasKiroAllow(agent: string, pattern: string): boolean {
	return (loadKiroConfig(agent).toolsSettings?.shell?.allowedCommands ?? []).includes(pattern);
}

describe("read-only roles: the allow shrink closes the known holes", () => {
	for (const agent of READ_ONLY_ROLES) {
		test(`pi ${agent}: removed write and exec allows never match`, () => {
			for (const command of REMOVED_PI_HOLE_FORMS) {
				assert.notEqual(verdict(agent, command), "allow", `${agent}: ${command}`);
				assert.ok(!piAllowMatches(agent, command), `allow re-added: ${command}`);
			}
		});
		test(`kiro ${agent}: removed allows stay off the list`, () => {
			for (const pattern of REMOVED_KIRO_ALLOWS[agent] ?? []) {
				assert.ok(!hasKiroAllow(agent, pattern), `allow re-added: ${pattern}`);
			}
		});
		test(`opencode ${agent}: removed allows stay off the list`, () => {
			for (const pattern of REMOVED_OPENCODE_ALLOWS[agent] ?? []) {
				assert.ok(!hasOpenCodeRule(agent, pattern, "allow"), `allow re-added: ${pattern}`);
			}
		});
	}

	test("pi reviewer: removed test and lint tools never match", () => {
		for (const command of REMOVED_REVIEWER_TOOL_FORMS) {
			assert.notEqual(verdict("reviewer", command), "allow", command);
			assert.ok(!piAllowMatches("reviewer", command), `allow re-added: ${command}`);
		}
	});

	test("pi researcher: removed test tools never match", () => {
		for (const command of REMOVED_RESEARCHER_TOOL_FORMS) {
			assert.notEqual(verdict("researcher", command), "allow", command);
			assert.ok(!piAllowMatches("researcher", command), `allow re-added: ${command}`);
		}
	});

	test("kiro reviewer: the project gate forms allow", () => {
		for (const command of ["npm test", "npm run typecheck", "npm run lint", "tsc --noEmit"]) {
			assert.equal(kiroVerdict("reviewer", command), "allow", command);
		}
		for (const pattern of ["npm test", "npm run typecheck", "npm run lint", "tsc *--noEmit*"]) {
			assert.ok(hasKiroAllow("reviewer", pattern), `missing allowedCommands ${pattern}`);
		}
	});

	// The fixing forms ask on kiro and opencode; this assertion requires only not-allow.
	test("kiro reviewer: the emitting forms deny and the fixing forms ask", () => {
		for (const command of ["tsc", "tsc --build"]) {
			assert.equal(kiroVerdict("reviewer", command), "deny", command);
		}
		for (const command of ["mypy .", "ruff check --fix", "pytest --junitxml=out.xml"]) {
			assert.notEqual(kiroVerdict("reviewer", command), "allow", command);
		}
	});

	test("opencode reviewer: the project gate forms allow", () => {
		for (const command of ["npm test", "npm run typecheck", "npm run lint", "tsc --noEmit"]) {
			assert.equal(opencodeVerdict("reviewer", command), "allow", command);
		}
		for (const pattern of ["npm test", "npm run typecheck", "npm run lint", "tsc *--noEmit*"]) {
			assert.ok(hasOpenCodeRule("reviewer", pattern, "allow"), `missing allow ${pattern}`);
		}
	});

	test("opencode reviewer: the emitting forms deny and the fixing forms ask", () => {
		for (const command of ["tsc", "tsc --build"]) {
			assert.equal(opencodeVerdict("reviewer", command), "deny", command);
		}
		for (const command of ["mypy .", "ruff check --fix"]) {
			assert.notEqual(opencodeVerdict("reviewer", command), "allow", command);
		}
	});

	test("pi: the abbreviated and glued forms fall to the default verdict", () => {
		for (const command of ["git cat-file --fil HEAD", "git grep --open TODO", "git branch -uorigin/main"]) {
			assert.equal(verdict("reviewer", command), "default", `pi: ${command}`);
		}
	});

	test("kiro and opencode: the abbreviated forms are never allowed", () => {
		for (const command of ["git cat-file --fil HEAD", "git grep --open TODO"]) {
			assert.notEqual(kiroVerdict("researcher", command), "allow", `kiro: ${command}`);
			assert.notEqual(opencodeVerdict("researcher", command), "allow", `opencode: ${command}`);
		}
	});

	test("kept read forms still allow on every engine", () => {
		for (const command of ["git status", "git log", "git diff"]) {
			assert.equal(verdict("reviewer", command), "allow", `pi: ${command}`);
			assert.equal(kiroVerdict("reviewer", command), "allow", `kiro: ${command}`);
			assert.equal(opencodeVerdict("reviewer", command), "allow", `opencode: ${command}`);
		}
	});
});
