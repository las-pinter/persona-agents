/**
 * Permission regression harness for the pi ask gates and file migrations.
 *
 * Covers the dequoted ask probes, shell expansions, the branch and -c gates,
 * the cp/mv/rsync doctrine, and its wrapper boundaries.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	KIRO_AGENTS,
	OPENCODE_AGENTS,
	OTHER_AGENTS,
	hasOpenCodeRule,
	kiroDeniedCommands,
	kiroPattern,
	kiroHasShellTool,
	kiroVerdict,
	loadAgentRules,
	isRawChain,
	opencodeVerdict,
	piHasBashTool,
	ruleSetMatches,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// pi ask dequote. The ask probes now test the dequoted command, mirroring the
// deny path, so a quote or a backslash that splits an escape guard cannot ride
// the read allow. The guards still see the raw form first. opencode and kiro
// keep raw matching, because the owner chose exact-only reads there.
// ---------------------------------------------------------------------------

const PI_DEQUOTE_ASKS = [
	'git log --out"put"=/tmp/x',
	"git log --out'put'=/tmp/x",
	'git diff --ext"-diff"',
	"git log --ext\\-diff",
	"git show --out\\put=/tmp/x HEAD",
	'git cat-file --filt"ers" HEAD',
	"git grep '-O'\"touch /tmp/x\" f",
];

describe("pi: the ask probes match the dequoted command", () => {
	test("quoted and backslash-obfuscated escape guards ask", () => {
		for (const command of PI_DEQUOTE_ASKS) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("normal argument reads still allow", () => {
		for (const command of ["git log --oneline", "git grep -n x", "git cat-file -p HEAD", "git -C /repo diff HEAD"]) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("the grep pager guard survives a split quote", () => {
		for (const command of ["git grep '-O'touch /tmp/x f", "git -C /repo grep -O'touch /tmp/x' TODO"]) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("a git -c config override after a -C dir asks, a plain -C read allows", () => {
		assert.equal(verdict("orchestrator", "git -C /r -c diff.external=touch diff HEAD"), "ask");
		assert.equal(verdict("orchestrator", "git -C /r diff HEAD"), "allow");
	});

	// Accepted residual: a raw ANSI-C quote is a fail-closed construct in the
	// parser, so `git log --out$'put'=/tmp/x` denies before the ask runs. The
	// important property is that it never allows. The owner asked for ask here;
	// the deny is stronger and the parser's fail-closed guard is not weakened.
	test("a raw ANSI-C quoted escape guard is never allowed", () => {
		const kind = verdict("orchestrator", "git log --out$'put'=/tmp/x");
		assert.notEqual(kind, "allow");
		assert.equal(kind, "deny");
	});

	test("opencode keeps raw matching: the exact form allows, the obfuscated form asks", () => {
		assert.equal(opencodeVerdict("orchestrator", "git log --oneline"), "allow");
		assert.equal(opencodeVerdict("orchestrator", 'git log --out"put"=/tmp/x'), "ask");
	});
});

// ---------------------------------------------------------------------------
// Locale quoting `$"..."` and shell-variable carriers `$W` / `${W}`.
//
// `dequoteProbe` strips `"`/`'` and resolves `\x`, but it does not model bash
// `$"..."` (locale translation) or `$VAR`. The allow probe is raw-only, so a
// guard that splits on `$"` or that hides the flag inside a variable rides the
// read allow. bash 5.2 expands `$"--lost-found"` to `--lost-found`, so the
// villain reaches the write. Every form must ask or deny, never allow.
// ---------------------------------------------------------------------------

const PI_SHELL_EXPANSION_ESCAPES_NOT_ALLOW = [
	// bash locale quote `$"..."` splits a guard before its discriminating letters
	'git fsck $"--lost-found"',
	'git hash-object -$"w" README.md',
	'git hash-object -$"w" --stdin',
	'git log --out$"put"=/tmp/x',
	'git log --$"output"=/tmp/x',
	'git grep -$"O" touch /tmp/x f',
	'git diff --ext$"-diff"',
	'git diff --text$"conv"',
	'git cat-file --fil$"ters" HEAD',
	// an unset variable can carry the write flag into an allowed read verb
	"git fsck $W",
	"git fsck ${W}",
	'git fsck "$W"',
	"git hash-object $W",
	"git hash-object ${W}",
];

describe("pi: shell expansions cannot carry a write flag past a read allow", () => {
	test("orchestrator: locale-quoted and variable escapes never allow", () => {
		for (const command of PI_SHELL_EXPANSION_ESCAPES_NOT_ALLOW) {
			assert.notEqual(verdict("orchestrator", command), "allow", command);
		}
	});
});

describe("orchestrator: rule entries back the branch and -c gates", () => {
	test("opencode orchestrator: branch upstream ask entries exist", () => {
		for (const resource of [
			"git branch -u*",
			"git branch --set-upstream*",
			"git branch --edit-description*",
		]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "ask"), `missing {shell, ${resource}, ask}`);
		}
	});

	test("pi orchestrator: branch create asks from an explicit rule", () => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		assert.equal(mode, "deny-by-default");
		assert.ok(
			ruleSetMatches(ruleSets.agentAsk, "git branch newbranch"),
			"the orchestrator ask list must carry a branch-create rule",
		);
	});

	test("pi orchestrator: the branch allow no longer matches a bare name", () => {
		const { ruleSets } = loadAgentRules("orchestrator");
		assert.ok(
			!ruleSetMatches(ruleSets.agentAllow, "git branch newbranch"),
			"a bare branch name must not match the branch allow",
		);
	});

	test("pi orchestrator: the -c alias ask entry exists", () => {
		const { ruleSets } = loadAgentRules("orchestrator");
		assert.ok(
			ruleSetMatches(ruleSets.agentAsk, "git -c alias.x=!sh status"),
			"the orchestrator ask list must carry a git -c rule",
		);
	});
});

// ---------------------------------------------------------------------------
// File migrations (cp/mv/rsync) prompt the orchestrator and the implementer on
// every stack, so the user can approve a migration on demand. Every other agent
// stays hard-gated: pi blocks by deny-by-default mode; opencode and kiro carry
// explicit deny rules, so the command never runs silently.
// ---------------------------------------------------------------------------

const FILE_MIGRATION_COMMANDS = [
	"cp src/a.txt dest/b.txt",
	"mv src/a.txt dest/b.txt",
	"rsync -a src/ dest/",
	"cd /repo && cp src/a dest/b",
	"env cp src/a dest/b",
];

// opencode matches each command node on its own, so it never sees a raw chain.
const OPENCODE_FILE_MIGRATION_COMMANDS = FILE_MIGRATION_COMMANDS.filter((command) => !isRawChain(command));

const FILE_MIGRATION_TARGETS = ["orchestrator", "implementer"];

describe("file-migration permission doctrine (cp/mv/rsync)", () => {
	const MIGRATION_RESOURCES = ["cp *", "mv *", "rsync *"];

	test("pi orchestrator and implementer: cp/mv/rsync ask", () => {
		for (const agent of ["orchestrator", "implementer"]) {
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("pi other agents: cp/mv/rsync deny by default", () => {
		for (const agent of OTHER_AGENTS) {
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	// opencode: the ask must come from an explicit rule, not the default ask.
	test("opencode orchestrator and implementers: explicit ask rules exist", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			for (const resource of MIGRATION_RESOURCES) {
				assert.ok(hasOpenCodeRule(agent, resource, "ask"), `${agent}: missing {shell, ${resource}, ask}`);
			}
		}
	});

	test("opencode orchestrator and implementers: cp/mv/rsync ask", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			for (const command of OPENCODE_FILE_MIGRATION_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("opencode other agents: explicit deny rules deny cp/mv/rsync", () => {
		for (const agent of OPENCODE_AGENTS.filter((name) => !FILE_MIGRATION_TARGETS.includes(name))) {
			for (const resource of MIGRATION_RESOURCES) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
			for (const command of OPENCODE_FILE_MIGRATION_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	// kiro: orchestrator/implementer are unlisted, so the platform default asks.
	// Assert no deniedCommands pattern matches them.
	test("kiro orchestrator and implementers: unlisted -> ask, no deny matches", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			const denied = kiroDeniedCommands(agent);
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.ok(!denied.some((pattern) => kiroPattern(pattern, command)), `${agent}: deny matches ${command}`);
				assert.equal(kiroVerdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("kiro other agents: explicit deniedCommands deny cp/mv/rsync", () => {
		for (const agent of KIRO_AGENTS.filter((name) => !FILE_MIGRATION_TARGETS.includes(name))) {
			if (!kiroHasShellTool(agent)) {
				// Mascot gets no shell at all, so cp/mv/rsync cannot run. That is
				// stronger than a deny entry; assert the tool is absent instead.
				assert.ok(!kiroHasShellTool(agent), `${agent}: a shell-less agent cannot run cp/mv/rsync`);
				continue;
			}
			for (const command of ["cp", "mv", "rsync"]) {
				assert.ok(kiroDeniedCommands(agent).includes(command), `${agent}: missing deniedCommands ${command}`);
			}
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("mascot: no shell surface on any stack", () => {
		assert.ok(!piHasBashTool("mascot"), "pi mascot must not have a bash tool");
		assert.ok(!kiroHasShellTool("mascot"), "kiro mascot must not have a shell tool");
		for (const resource of MIGRATION_RESOURCES) {
			assert.ok(hasOpenCodeRule("mascot", resource, "deny"), `opencode mascot must explicitly deny ${resource}`);
		}
	});
});

// ---------------------------------------------------------------------------
// File-migration wrapper boundaries on pi: the `command -v` read-only probe
// must stay allowed, `timeout`/`chrt`-wrapped migrations must still ask, and
// near-miss tokens must never over-match the ask rule.
// ---------------------------------------------------------------------------

const PI_MIGRATION_AGENTS = ["orchestrator", "implementer"];

const COMMAND_VERSION_PROBES = [
	"command -v cp",
	"command -V cp",
	"command -v mv",
	"command -V mv",
	"command -v rsync",
	"command -V rsync",
];

const COMMAND_PREFIXED_MIGRATIONS = ["command cp a b", "command mv a b", "command rsync a b"];

const TIMEOUT_WRAPPED_MIGRATIONS = [
	"timeout 5 cp a b",
	"timeout 5 mv a b",
	"timeout 5 rsync a b",
	"timeout -s TERM 5 cp a b",
	"timeout -s TERM 5 mv a b",
	"timeout -s TERM 5 rsync a b",
	"chrt 5 cp a b",
];

const MIGRATION_NEAR_MISS_ALLOWED = ["grep cp"];

const MIGRATION_NEAR_MISS_DEFAULT = ["scp a b", "cpfoo", "mvn test", "MCP", "mvfoo", "rsyncd"];

describe("pi: cp/mv/rsync wrapper boundaries", () => {
	test("command -v/-V probes stay allowed, never asked", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of COMMAND_VERSION_PROBES) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("command-prefixed migrations fall through to deny-by-default", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of COMMAND_PREFIXED_MIGRATIONS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	test("timeout/chrt-wrapped migrations still ask", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of TIMEOUT_WRAPPED_MIGRATIONS) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("near-miss tokens never over-match the ask rule", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of MIGRATION_NEAR_MISS_ALLOWED) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
			for (const command of MIGRATION_NEAR_MISS_DEFAULT) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});
});
