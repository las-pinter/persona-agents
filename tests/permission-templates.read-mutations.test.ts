/**
 * Permission regression harness for the read-only git mutation fences.
 *
 * Covers the tightened catch-alls, the branch flag-order gate, reset, remote,
 * and fetch gates on every stack.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	KIRO_SHELL_AGENTS,
	OPENCODE_SHELL_AGENTS,
	PI_SHELL_AGENTS,
	kiroVerdict,
	opencodeVerdict,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// Read-only boundary after the tightened catch-alls.
// A substring catch-all like `*gh*pr*` denies `cat high-priority.md`, and
// `*git*push*` denies `git log --all --grep=push`. These read-only commands
// must never be denied on any platform.
// ---------------------------------------------------------------------------

const READ_ONLY_AFTER_CATCHALL = [
	"cat high-priority.md",
	"grep -rn highlight src/projects",
	"git log --all --grep=push",
	"git log --oneline",
];

describe("read-only commands survive the tightened catch-alls", () => {
	test("opencode: read-only commands are not denied", () => {
		for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
			for (const command of READ_ONLY_AFTER_CATCHALL) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: read-only commands are not denied", () => {
		for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
			for (const command of READ_ONLY_AFTER_CATCHALL) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro orchestrator: read-only command with an argument is not denied", () => {
		for (const command of ["cat high-priority.md", "echo hello world", "ls -la src"]) {
			assert.notEqual(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("kiro orchestrator: bash -n cannot smuggle a write through the shell", () => {
		assert.equal(kiroVerdict("orchestrator", "bash -n $(git push)"), "ask");
		assert.equal(kiroVerdict("orchestrator", "bash -n script.sh"), "ask");
	});
});

// ---------------------------------------------------------------------------
// Final lockdown: a destructive branch flag anywhere in the branch arguments,
// and a write hidden behind a previously broad allow. Every allow that carried
// arguments was narrowed to its literal base, so `git log && git push` and
// `echo $(git --paginate push)` can no longer ride a broad read-only allow.
// ---------------------------------------------------------------------------

const BRANCH_FLAG_ORDER = [
	"git branch -a -d topic",
	"git branch --all -M old new",
];

const HIDDEN_WRITES = [
	"git log && git push",
	"echo $(git --paginate push)",
	// kiro matches the raw command string, so a wildcard allow would admit a
	// chained gated write. These exact-string reads must not allow the chain.
	"git fetch origin && git push",
	"git rev-parse HEAD && git push",
	"git cat-file -t HEAD && gh pr create",
	"git fetch origin ; git commit -m x",
];

const READ_ONLY_BRANCH_PLAIN = [
	"git branch",
	"git branch -a",
	"git branch --show-current",
];

describe("branch flag-order bypass and broad-allow writes", () => {
	test("pi: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(verdict("orchestrator", command), "ask", command);
			for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
				assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(verdict("orchestrator", command), "ask", command);
			for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_SHELL_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_SHELL_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_SHELL_AGENTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_SHELL_AGENTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only git subcommands that mutate state: reflog expiry, fetch refspecs,
// and remote config edits. These ride the broad read-only git allow on pi.
// ---------------------------------------------------------------------------

const READONLY_ABUSE = [
	"git reflog expire --expire=now --all",
	"git reflog delete",
	"git reflog drop",
	"git fetch origin +HEAD:refs/heads/x",
	"git remote add x url",
	"git remote remove x",
	"git remote rm x",
	"git remote rename old new",
	"git remote set-url x url",
	"git remote set-branches x y",
	"git remote set-head x y",
	"git remote prune x",
	"env git reflog expire",
];

const READONLY_SAFE = [
	"git reflog",
	"git reflog show",
	"git remote",
	"git remote -v",
	"git remote show",
];

// `git fetch` writes local refs (`--tags`/`-t` writes tags, `--update-head-ok`
// can move HEAD, `--prefetch`/`--refmap` write refs), so it is not a silent
// read. It is absent from the read-only allow on every non-orchestrator agent.
const FETCH_ARG_FORMS = [
	"git fetch",
	"git fetch origin",
	"git fetch --tags origin",
	"git fetch -t origin",
];

// Fetch argument forms that write refs (`--all`, `--update-head-ok`) must never
// be a silent allow either.
const FETCH_ARG_WRITE_FORMS = [
	"git fetch --all",
	"git fetch --update-head-ok origin",
];

// Wrapper and anchor prefixes around `git fetch`. The inner fetch must stay
// gated through every wrapper, so none of these may be allow.
const FETCH_WRAPPER_FORMS = [
	"cd /repo && git fetch",
	"env FOO=1 git fetch",
	"time git fetch",
	"command git fetch",
	"git -C /repo fetch",
	"timeout 5 git fetch",
	"chrt 1 git fetch",
];

// The pi agents that previously allowed `git fetch`. They now ASK.
const PI_FETCH_CHANGED_AGENTS = ["implementer", "researcher", "tester", "reviewer"];

// A read-only `git log` must never carry a chained `git fetch` into a silent
// allow. The chain is not allow on any stack.
const FETCH_CHAIN_NOT_ALLOW = [
	"git log && git fetch",
	"git log && git fetch --tags",
	"git log && git fetch --tags origin",
	"git log && git fetch -t origin",
];

// ---------------------------------------------------------------------------
// `git reset --soft` is a history squash. The rule is orchestrator-only and
// always asks the orchestrator before it runs; everyone else denies by default.
// ---------------------------------------------------------------------------

const RESET_SOFT = ["git reset --soft HEAD~1", "cd /repo && git reset --soft HEAD~1"];

describe("pi: git reset --soft is orchestrator-gated", () => {
	test("orchestrator: git reset --soft asks", () => {
		for (const command of RESET_SOFT) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: git reset --soft denies", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			const kind = verdict(agent, "git reset --soft HEAD~1");
			assert.notEqual(kind, "ask", agent);
			assert.notEqual(kind, "allow", agent);
		}
	});
});

describe("pi: mutating read-only git forms are gated", () => {
	test("orchestrator: reflog/fetch/remote mutations ask", () => {
		for (const command of READONLY_ABUSE) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: reflog/fetch/remote mutations deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of READONLY_ABUSE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("all agents: plain read-only reflog/remote are not denied", () => {
		for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
			for (const command of READONLY_SAFE) assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});
});

// `git remote update` runs a fetch and writes remote-tracking refs. The bare
// read-only allow `remote\b` let it through, and the remote deny alternation
// omitted `update`. `update` now sits next to the other remote mutations on the
// four non-orchestrator pi agents; the plain read forms still allow.
const REMOTE_UPDATE_FORMS = ["git remote update", "git remote update --prune"];
const PI_REMOTE_UPDATE_AGENTS = ["implementer", "researcher", "tester", "reviewer"];

const REMOTE_READ_FORMS = ["git remote", "git remote -v", "git remote show"];

describe("pi: git remote update is gated like the other remote mutations", () => {
	test("changed agents: remote update denies", () => {
		for (const agent of PI_REMOTE_UPDATE_AGENTS) {
			for (const command of REMOTE_UPDATE_FORMS) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("changed agents: plain remote reads still allow", () => {
		for (const agent of PI_REMOTE_UPDATE_AGENTS) {
			for (const command of REMOTE_READ_FORMS) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});
});

// Fetch writes refs. The pre-existing silent allow is gone: the changed pi
// agents now ASK, and every other agent must not allow the fetch forms.
describe("pi: fetch is gated, never a silent allow", () => {
	test("pi: changed agents ask for every fetch argument and wrapper form", () => {
		for (const agent of PI_FETCH_CHANGED_AGENTS) {
			for (const command of [...FETCH_ARG_FORMS, ...FETCH_ARG_WRITE_FORMS, ...FETCH_WRAPPER_FORMS]) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("pi: fetch never allows on the other shell agents or the orchestrator", () => {
		for (const agent of ["orchestrator", "planner"]) {
			for (const command of [...FETCH_ARG_FORMS, ...FETCH_ARG_WRITE_FORMS, ...FETCH_WRAPPER_FORMS]) {
				assert.notEqual(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});
});

describe("opencode: fetch is gated, never a silent allow", () => {
	test("opencode researcher: fetch asks by omission after the allow is removed", () => {
		for (const command of FETCH_ARG_FORMS) {
			assert.equal(opencodeVerdict("researcher", command), "ask", command);
		}
	});

	test("opencode orchestrator: fetch asks by omission after the allow is removed", () => {
		for (const command of [...FETCH_ARG_FORMS, ...FETCH_ARG_WRITE_FORMS]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode: fetch never allows on the non-orchestrator agents", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of [...FETCH_ARG_FORMS, ...FETCH_ARG_WRITE_FORMS, ...FETCH_WRAPPER_FORMS]) {
				assert.notEqual(opencodeVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});
});

// A read-only segment must not carry a chained fetch into a silent allow.
describe("fetch chain writes are never a silent allow", () => {
	test("pi: a chained git fetch is not allow", () => {
		for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
			for (const command of FETCH_CHAIN_NOT_ALLOW) {
				assert.notEqual(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: a chained git fetch is not allow", () => {
		for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
			for (const command of FETCH_CHAIN_NOT_ALLOW) {
				assert.notEqual(opencodeVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: a chained git fetch is not allow", () => {
		for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
			for (const command of FETCH_CHAIN_NOT_ALLOW) {
				assert.notEqual(kiroVerdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});
});
