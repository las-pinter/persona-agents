/**
 * Permission regression harness for the orchestrator git and gh gates.
 *
 * Covers the read-only allows, the mutation forms, the object-write and sed
 * fences, process substitution, chain guards, and silent escapes.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	hasOpenCodeRule,
	kiroVerdict,
	loadKiroConfig,
	isRawChain,
	opencodeVerdict,
	readVerdict,
	verdict,
} from "./permission-templates.fixtures.ts";

describe("pi orchestrator: read allows follow the repo layout", () => {
	test("content and agent templates read silently", () => {
		for (const file of [
			"/repo/content/skills/orchestrator/task-routing/SKILL.md",
			"/repo/content/personas/goblin/bossnik-chief.md",
			"/repo/content/professions/orchestrator.md",
			"/repo/content/agents.json",
			"/repo/platforms/pi/frontmatters/orchestrator.yaml",
			"/repo/platforms/opencode/frontmatters/implementer.yaml",
			"/repo/platforms/kiro/templates/reviewer.json",
		]) {
			assert.equal(readVerdict("orchestrator", file), "allow", file);
		}
	});

	test("extension source and plugins are not a read allow", () => {
		for (const file of [
			"/repo/platforms/pi/extension/resolver.ts",
			"/repo/platforms/opencode/plugins/persona-agents.js",
		]) {
			assert.notEqual(readVerdict("orchestrator", file), "allow", file);
		}
	});
});

// ---------------------------------------------------------------------------
// Orchestrator read-only git and gh allows. The orchestrator may inspect refs
// (`git rev-parse`/`cat-file`/`rev-list`) and read its GitHub CLI version and
// auth state (`gh --version`/`gh auth status`). Kiro matches the raw command
// string, so those entries stay exact strings: an argument-bearing form asks by
// omission, and a chained gated write cannot ride the allow. opencode matches
// the raw command string with last-match-wins too, so a trailing-`*` read allow
// would cover a whole chain; opencode therefore carries explicit chain guards
// (`;`, `&`, `|`, `>`, `$(`, backtick, newline) as asks after the read allows,
// and a plain read with no separator still allows. `git fetch` is
// deliberately not allowed on pi or kiro: it writes refs, so it stays denied.
// opencode has no `git fetch` allow either; a bare `git fetch` asks by omission.
// ---------------------------------------------------------------------------

const PI_ORCH_GIT_READS = [
	"git rev-parse --short HEAD",
	"git cat-file -t HEAD",
	"git rev-list --count HEAD",
	"git grep -n TODO",
	"git describe --tags",
	"git blame README.md",
	"git shortlog -sn",
	"git whatchanged -1",
	"git ls-files",
	"git ls-tree HEAD",
	"git show-ref --heads",
	"git for-each-ref --format=%(refname)",
	"git name-rev HEAD",
	"git check-ignore README.md",
	"git check-attr text README.md",
	"git check-ref-format heads/main",
	"git diff-tree --no-commit-id -r HEAD",
	"git diff-index HEAD",
	"git diff-files",
	"git cherry -v",
	"git range-diff main..HEAD main..topic",
	"git var -l",
	"git version",
	"git help",
	"git show-branch",
	"git check-mailmap README.md",
	"git patch-id",
	"git stripspace",
	"git column",
	"git count-objects -v",
	"git verify-commit HEAD",
	"git verify-tag v1",
	"git verify-pack -v x.pack",
	"git hash-object README.md",
	"git fsck",
	"git commit-graph verify",
	"git multi-pack-index verify",
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch --list",
	"git branch --show-current",
	"git branch -v",
	"git branch -vv",
	"git branch --format=%(refname)",
	"git branch --contains HEAD",
	"git branch --merged",
	"git branch --no-merged",
	"git branch --points-at HEAD",
	"git tag",
	"git tag -l",
	"git tag --list",
	"git reflog",
	"git reflog show",
	"git reflog exists HEAD",
	"git remote",
	"git remote -v",
	"git remote get-url origin",
	"git config --get user.name",
	"git config --get-all user.name",
	"git config --get-regexp user",
	"git config --get-urlmatch http.proxy https://x",
	"git config -l",
	"git config --list",
	"git config --show-origin --get user.name",
	"git config --show-scope --get user.name",
	"git symbolic-ref HEAD",
	"git symbolic-ref --short HEAD",
	"git symbolic-ref -q HEAD",
	"git stash list",
	"git stash show",
	"git notes list",
	"git notes show",
	"git worktree list",
	"git submodule status",
	"git submodule summary",
	"git sparse-checkout list",
	"git -C /repo grep TODO",
	"git --no-pager log",
	"git -p status",
	"git -C /repo --no-pager show HEAD",
];

const ORCH_GH_READS = ["gh --version", "gh auth status"];

// `git fetch` writes refs (tags, HEAD, prefetch/refmap). It is not on the pi
// allow list, so it must not allow.
const PI_ORCH_FETCH_NOT_ALLOW = [
	"git fetch",
	"git fetch origin",
	"git fetch --tags origin",
	"git fetch -t origin",
	"git fetch --update-head-ok origin",
];

// The `--show-token` flag prints the GitHub auth token. It must not ride the
// `gh auth status` allow. pi denies by default; kiro and opencode fall to ask.
const GH_SHOW_TOKEN = "gh auth status --show-token";

// kiro allowedCommands entry -> the bare probe it must allow. The entries are
// exact strings. A wildcard would let a chained gated write ride the allow,
// because kiro matches the raw command string.
const KIRO_ORCH_GIT_ALLOWS: Array<[string, string]> = [
	["git rev-parse", "git rev-parse"],
	["git cat-file", "git cat-file"],
	["git rev-list", "git rev-list"],
	["git grep", "git grep"],
	["git describe", "git describe"],
	["git blame", "git blame"],
	["git shortlog", "git shortlog"],
	["git ls-files", "git ls-files"],
	["git ls-tree", "git ls-tree"],
	["git show-ref", "git show-ref"],
	["git for-each-ref", "git for-each-ref"],
	["git name-rev", "git name-rev"],
	["git check-ignore", "git check-ignore"],
	["git diff-tree", "git diff-tree"],
	["git cherry", "git cherry"],
	["git var", "git var"],
	["git version", "git version"],
	["git help", "git help"],
	["git show-branch", "git show-branch"],
	["git check-mailmap", "git check-mailmap"],
	["git patch-id", "git patch-id"],
	["git count-objects", "git count-objects"],
	["git verify-commit", "git verify-commit"],
	["git verify-tag", "git verify-tag"],
	["git verify-pack", "git verify-pack"],
	["git fsck", "git fsck"],
	["git hash-object", "git hash-object"],
	["git commit-graph verify", "git commit-graph verify"],
	["git multi-pack-index verify", "git multi-pack-index verify"],
	["git branch", "git branch"],
	["git branch -a", "git branch -a"],
	["git branch -r", "git branch -r"],
	["git branch --show-current", "git branch --show-current"],
	["git tag", "git tag"],
	["git tag -l", "git tag -l"],
	["git tag --list", "git tag --list"],
	["git reflog", "git reflog"],
	["git reflog show", "git reflog show"],
	["git remote", "git remote"],
	["git remote -v", "git remote -v"],
	["git remote get-url", "git remote get-url"],
	["git config --get", "git config --get"],
	["git config -l", "git config -l"],
	["git config --list", "git config --list"],
	["git symbolic-ref HEAD", "git symbolic-ref HEAD"],
	["git stash list", "git stash list"],
	["git stash show", "git stash show"],
	["git notes list", "git notes list"],
	["git worktree list", "git worktree list"],
	["git submodule status", "git submodule status"],
	["git sparse-checkout list", "git sparse-checkout list"],
];

// Argument-bearing forms must ask by omission on kiro. An exact allow cannot
// match them, and kiro has no ask tier, so an unmatched command asks. This is
// the fail-safe that stops a chained gated write from riding the allow.
const KIRO_ORCH_GIT_ASKS = [
	"git rev-parse --short HEAD",
	"git cat-file -t HEAD",
	"git rev-list --count HEAD",
	"git rev-parse HEAD && git push",
];

// opencode git read allows that must already exist for the orchestrator.
const OPENCODE_ORCH_GIT_ALLOWS = [
	"git rev-parse",
	"git cat-file",
	"git rev-list",
	"git grep",
	"git describe",
	"git ls-files",
	"git show-ref",
	"git for-each-ref",
	"git diff-tree",
	"git count-objects",
	"git branch",
	"git branch -l",
	"git branch --list",
	"git tag",
	"git tag -l*",
	"git tag --list*",
	"git reflog",
	"git reflog show",
	"git reflog show *",
	"git remote",
	"git remote -v",
	"git remote get-url *",
	"git config --get *",
	"git config -l",
	"git symbolic-ref HEAD",
	"git stash list",
	"git stash show",
	"git notes list",
	"git worktree list",
	"git submodule status",
	"git sparse-checkout list",
	"git hash-object",
	"git fsck",
	"git commit-graph verify",
	"git multi-pack-index verify",
];

// The pure-read verbs accept ordinary arguments on pi. On opencode a free
// argument read must not allow: the raw-match gate cannot dequote, so a
// quote/backslash escape or a chain can ride the allow. opencode allows only
// the literal reviewed forms below.
const PURE_READ_ARG_FORMS = [
	"git log --oneline",
	"git status --porcelain",
	"git diff --stat",
	"git show HEAD",
	"git cat-file -p HEAD",
	"git rev-parse --short HEAD",
	"git rev-list --count HEAD",
	"git -C /repo log --oneline",
	"git -C /repo status --porcelain",
	"git -C /repo diff --stat",
	"git -C /repo show HEAD",
	"git -C /repo cat-file -p HEAD",
	"git -C /repo rev-parse HEAD",
	"git -C /repo rev-list --count HEAD",
];

// The reviewed opencode exact-flag read allows. Each entry is a literal
// resource (no `*`) and the probe the rule must allow. These are the only
// argument-bearing pure-read forms that allow on opencode.
const OPENCODE_REVIEWED_READ_ALLOWS: Array<[string, string]> = [
	["git status -s", "git status -s"],
	["git status --short", "git status --short"],
	["git status --porcelain", "git status --porcelain"],
	["git log --oneline", "git log --oneline"],
	["git log --stat", "git log --stat"],
	["git diff --stat", "git diff --stat"],
	["git diff --cached", "git diff --cached"],
	["git diff --name-only", "git diff --name-only"],
	["git show --stat", "git show --stat"],
	["git ls-files", "git ls-files"],
	["git describe --tags", "git describe --tags"],
	["git shortlog -s", "git shortlog -s"],
	["git branch", "git branch"],
	["git branch -a", "git branch -a"],
	["git branch -r", "git branch -r"],
	["git branch --show-current", "git branch --show-current"],
	["git tag -l", "git tag -l"],
	["git tag --list", "git tag --list"],
	["git reflog", "git reflog"],
	["git remote -v", "git remote -v"],
	["git config --list", "git config --list"],
	["git stash list", "git stash list"],
	["git notes list", "git notes list"],
	["git worktree list", "git worktree list"],
	["git submodule status", "git submodule status"],
	["git commit-graph verify", "git commit-graph verify"],
];

// The PURE_READ_ARG_FORMS that are themselves in the reviewed exact list.
const OPENCODE_PURE_READ_EXACT = ["git log --oneline", "git status --porcelain", "git diff --stat"];
const OPENCODE_PURE_READ_ASKS = PURE_READ_ARG_FORMS.filter((command) => !OPENCODE_PURE_READ_EXACT.includes(command));

describe("orchestrator: read-only git and gh allows", () => {
	test("pi orchestrator: git reads and gh reads allow", () => {
		for (const command of [...PI_ORCH_GIT_READS, ...ORCH_GH_READS]) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("pi orchestrator: git fetch is not allow", () => {
		for (const command of PI_ORCH_FETCH_NOT_ALLOW) {
			assert.notEqual(verdict("orchestrator", command), "allow", command);
		}
	});

	test("pi orchestrator: gh --show-token does not ride the gh allow", () => {
		assert.notEqual(verdict("orchestrator", GH_SHOW_TOKEN), "allow");
		// pi is deny-by-default: no allow and no ask rule matches --show-token.
		assert.equal(verdict("orchestrator", GH_SHOW_TOKEN), "default");
	});

	test("kiro orchestrator: exact git/gh allowedCommands allow the bare form", () => {
		const allowed = loadKiroConfig("orchestrator").toolsSettings?.shell?.allowedCommands ?? [];
		for (const [entry, probe] of KIRO_ORCH_GIT_ALLOWS) {
			assert.ok(allowed.includes(entry), `missing allowedCommands ${entry}`);
			assert.equal(kiroVerdict("orchestrator", probe), "allow", probe);
		}
		for (const entry of ORCH_GH_READS) {
			assert.ok(allowed.includes(entry), `missing allowedCommands ${entry}`);
			assert.equal(kiroVerdict("orchestrator", entry), "allow", entry);
		}
	});

	test("kiro orchestrator: argument-bearing git reads ask by omission", () => {
		for (const command of KIRO_ORCH_GIT_ASKS) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro orchestrator: git fetch is absent from the allow list", () => {
		const allowed = loadKiroConfig("orchestrator").toolsSettings?.shell?.allowedCommands ?? [];
		assert.ok(!allowed.includes("git fetch"), "git fetch must not be an allowedCommand");
		for (const command of PI_ORCH_FETCH_NOT_ALLOW) {
			assert.notEqual(kiroVerdict("orchestrator", command), "allow", command);
		}
	});

	test("kiro orchestrator: no deniedCommands entry starts with git fetch", () => {
		const denied = loadKiroConfig("orchestrator").toolsSettings?.shell?.deniedCommands ?? [];
		assert.ok(
			!denied.some((pattern) => pattern.startsWith("git fetch")),
			"no deniedCommands entry may start with git fetch",
		);
	});

	test("kiro orchestrator: gh --show-token falls to ask", () => {
		assert.equal(kiroVerdict("orchestrator", GH_SHOW_TOKEN), "ask");
	});

	test("opencode orchestrator: gh read allows exist and allow", () => {
		for (const resource of ORCH_GH_READS) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "allow"), `missing {shell, ${resource}, allow}`);
			assert.equal(opencodeVerdict("orchestrator", resource), "allow", resource);
		}
	});

	test("opencode orchestrator: gh --show-token falls to ask", () => {
		assert.equal(opencodeVerdict("orchestrator", GH_SHOW_TOKEN), "ask");
	});

	test("opencode orchestrator: git reads allow the bare form", () => {
		for (const resource of OPENCODE_ORCH_GIT_ALLOWS) {
			assert.ok(
				hasOpenCodeRule("orchestrator", resource, "allow"),
				`missing {shell, ${resource}, allow}`,
			);
			assert.equal(opencodeVerdict("orchestrator", resource), "allow", resource);
		}
	});

	test("pi orchestrator: pure-read verbs allow ordinary arguments", () => {
		for (const command of PURE_READ_ARG_FORMS) {
			assert.equal(verdict("orchestrator", command), "allow", `pi: ${command}`);
		}
	});

	test("opencode orchestrator: an argument read allows only the reviewed exact forms", () => {
		for (const command of OPENCODE_PURE_READ_EXACT) {
			assert.equal(opencodeVerdict("orchestrator", command), "allow", `opencode: ${command}`);
		}
		for (const command of OPENCODE_PURE_READ_ASKS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", `opencode: ${command}`);
		}
	});

	test("opencode orchestrator: each reviewed exact read form allows", () => {
		for (const [resource, probe] of OPENCODE_REVIEWED_READ_ALLOWS) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "allow"), `missing {shell, ${resource}, allow}`);
			assert.equal(opencodeVerdict("orchestrator", probe), "allow", probe);
		}
	});

	test("opencode orchestrator: an argument-bearing read with no exact allow asks", () => {
		for (const command of ["git log --oneline HEAD", "git grep -n x", "git merge-base x", "git cat-file -p HEAD"]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});
});

// ---------------------------------------------------------------------------
// Every mutation form of a mutation-capable git verb must stay off the allow
// list on all three stacks. pi and opencode fall to ask or deny; kiro has no ask
// list, so an unmatched command asks by omission. This set covers the approved
// read verbs' mutation counterparts, the global escape hatches, the network
// verbs, and a chained write after a read.
// ---------------------------------------------------------------------------

const ORCH_GIT_MUTATIONS_NOT_ALLOW = [
	// branch create / upstream / edit-description
	"git branch newbranch",
	"git branch newbranch origin/main",
	"git branch --set-upstream-to=origin/main",
	"git branch -u origin/main",
	"git branch -t foo origin/main",
	"git branch --track foo origin/main",
	"git branch --unset-upstream",
	"git branch --edit-description",
	"git branch --format=%(refname) -u origin/main",
	"git branch --format=%(refname) -d topic",
	// A branch listing option must not absorb a trailing branch name.
	"git branch --format=%(refname) newbranch",
	"git -C /repo branch --format=%(refname) newbranch",
	"git branch --contains HEAD newbranch",
	"git branch --merged HEAD newbranch",
	"git branch --no-merged HEAD newbranch",
	"git branch --points-at HEAD newbranch",
	"git -C /repo branch --contains HEAD newbranch",
	// branch delete / force / move / copy
	"git branch -D topic",
	"git branch -d topic",
	"git branch -f topic",
	"git branch -m old new",
	"git branch -M old new",
	"git branch --delete topic",
	"git branch --force topic",
	"git branch --move old new",
	"git branch --copy old new",
	// tag delete / force
	"git tag -d v3.0.0",
	"git tag --delete v3.0.0",
	"git tag -f v3.0.0",
	"git tag --force v3.0.0",
	"git tag -l -f v1",
	// reflog writers
	"git reflog expire --expire=now --all",
	"git reflog delete",
	"git reflog drop",
	// remote (network or writer)
	"git remote add x url",
	"git remote remove x",
	"git remote rename old new",
	"git remote set-url x url",
	"git remote set-branches x y",
	"git remote set-head x y",
	"git remote prune x",
	"git remote update",
	"git remote show origin",
	"git ls-remote origin",
	// config writers
	"git config user.name Grubnik",
	"git config --add user.name Grubnik",
	"git config --unset user.name",
	"git config --unset-all user.name",
	"git config --replace-all user.name x",
	"git config --remove-section user",
	"git config --rename-section a b",
	"git config --edit",
	// symbolic-ref writers
	"git symbolic-ref HEAD refs/heads/main",
	"git symbolic-ref --delete HEAD",
	"git symbolic-ref -d HEAD",
	// stash writers
	"git stash",
	"git stash push",
	"git stash pop",
	"git stash apply",
	"git stash drop",
	"git stash clear",
	"git stash save",
	"git stash branch x",
	// notes writers
	"git notes add -m x",
	"git notes remove HEAD",
	"git notes edit",
	"git notes append -m x",
	// worktree writers
	"git worktree add ../x",
	"git worktree remove x",
	"git worktree prune",
	// submodule writers
	"git submodule foreach 'git push'",
	"git submodule add url path",
	"git submodule update --init",
	// sparse-checkout writers
	"git sparse-checkout set foo",
	"git sparse-checkout add foo",
	"git sparse-checkout disable",
	// hash-object / fsck fences
	"git hash-object -w README.md",
	"git hash-object --write README.md",
	"git fsck --lost-found",
	// global escape hatches (before the verb)
	"git -c alias.x='!sh' status",
	"git --git-dir=/x status",
	"git --work-tree=/x status",
	"git --bare status",
	"git --namespace=foo status",
	// network and writer verbs
	"git fetch origin",
	"git fetch --tags origin",
	"git pull",
	"git push",
	"git reset --soft HEAD~1",
	"git merge origin/main",
	"git rebase main",
	// remaining writer verbs from the approved list
	"git commit-tree HEAD^{tree}",
	"git write-tree",
	"git read-tree HEAD",
	"git mktree",
	"git mktag",
	"git pack-refs --all",
	"git filter-branch --tree-filter true",
	"git replace HEAD HEAD~1",
	"git fast-import",
	"git archive HEAD",
	"git format-patch HEAD~1",
	"git bundle create x.bundle HEAD",
	"git fast-export HEAD",
	"git merge-tree HEAD HEAD~1",
	"git merge-file a b c",
	"git gc",
	"git prune",
	"git repack",
	"git rm README.md",
	"git mv a b",
	"git checkout main",
	"git switch main",
	"git restore README.md",
	"git clean -fd",
	"git apply patch.diff",
	"git am patch.patch",
	"git cherry-pick HEAD~1",
	"git revert HEAD",
	"git update-ref refs/heads/x HEAD",
	"git update-index --add README.md",
	"git clone url",
	// a chained write after a read
	"git status && git reset --hard",
	"git log && git push",
];

// Fixing the pi branch allow (it once matched a bare `branch`) makes only the
// listing forms allow. The create and upstream forms must ask on every stack.
const ORCH_BRANCH_CREATE = [
	"git branch newbranch",
	"git branch newbranch origin/main",
	"git branch --set-upstream-to=origin/main",
	"git branch -u origin/main",
	"git branch -t foo origin/main",
	"git branch --track foo origin/main",
	"git branch --unset-upstream",
	"git branch --edit-description",
];

// An argument-bearing branch listing option with a trailing free token. Git
// parses the trailing token as a branch to create, so none of these may allow.
const BRANCH_CREATE_BY_LISTING_OPTION = [
	"git branch --format=%(refname) newbranch",
	"git branch --format=x newbranch",
	"git -C /repo branch --format=%(refname) newbranch",
	"git branch --contains HEAD newbranch",
	"git branch --merged HEAD newbranch",
	"git branch --no-merged HEAD newbranch",
	"git branch --points-at HEAD newbranch",
	"git -C /repo branch --contains HEAD newbranch",
];

describe("orchestrator: mutation forms are never a silent allow", () => {
	test("pi orchestrator: mutation forms are not allow", () => {
		// A plain pull, merge, or rebase allows the pi orchestrator (owner choice).
		// opencode and kiro still keep them off the allow list.
		const piPlainHistory = new Set(["git pull", "git merge origin/main", "git rebase main"]);
		for (const command of ORCH_GIT_MUTATIONS_NOT_ALLOW) {
			const kind = verdict("orchestrator", command);
			if (piPlainHistory.has(command)) assert.equal(kind, "allow", command);
			else assert.notEqual(kind, "allow", command);
		}
	});

	test("opencode orchestrator: mutation forms are not allow", () => {
		// A plain merge or rebase allows the opencode orchestrator too (owner
		// choice); git pull still asks. kiro keeps them off the allow list.
		const opencodePlainHistory = new Set(["git merge origin/main", "git rebase main"]);
		// opencode matches each command node on its own, so raw chains are skipped.
		for (const command of ORCH_GIT_MUTATIONS_NOT_ALLOW.filter((entry) => !isRawChain(entry))) {
			const kind = opencodeVerdict("orchestrator", command);
			if (opencodePlainHistory.has(command)) assert.equal(kind, "allow", command);
			else assert.notEqual(kind, "allow", command);
		}
	});

	test("kiro orchestrator: mutation forms are not allow", () => {
		for (const command of ORCH_GIT_MUTATIONS_NOT_ALLOW) {
			assert.notEqual(kiroVerdict("orchestrator", command), "allow", command);
		}
	});

	test("pi orchestrator: branch create and upstream ask", () => {
		for (const command of ORCH_BRANCH_CREATE) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode orchestrator: branch create and upstream ask", () => {
		for (const command of ORCH_BRANCH_CREATE) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro orchestrator: branch create and upstream ask", () => {
		for (const command of ORCH_BRANCH_CREATE) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	// A branch create can hide behind an argument-bearing listing option. The
	// opencode allow once carried `git branch --format=*`, whose glob swallowed
	// the trailing `newbranch`. These forms must ask, never allow.
	test("opencode orchestrator: a listing option cannot carry a branch create token", () => {
		for (const command of BRANCH_CREATE_BY_LISTING_OPTION) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("pi orchestrator: a listing option cannot carry a branch create token", () => {
		for (const command of BRANCH_CREATE_BY_LISTING_OPTION) {
			assert.notEqual(verdict("orchestrator", command), "allow", command);
		}
		// The pi branch-create ask matches a bare trailing name, not a name after
		// a listing flag. This form falls to the deny-by-default mode, which is
		// fail-safe (deny, never a silent allow).
		assert.equal(verdict("orchestrator", "git branch --format=x newbranch"), "default");
	});
});

// ---------------------------------------------------------------------------
// The allow probe is raw-only, so a mutation fence cannot live in an allow
// regex: a quote split or a git abbreviation slips past it. `git hash-object
// -w` writes an object and `git fsck --lost-found` writes `.git/lost-found`.
// Both fences must live in the ask tier, which tests the dequoted probe.
// ---------------------------------------------------------------------------

const PI_OBJECT_WRITE_FENCES_NOT_ALLOW = [
	// literal write forms
	"git hash-object -w f",
	"git hash-object --write f",
	"git fsck --lost-found",
	// quoted split: the raw probe cannot see the joined flag
	'git hash-object -"w" README.md',
	'git fsck --lo"st-found"',
	// git accepts a unique abbreviation of `--lost-found`
	"git fsck --los",
	"git fsck --lo",
	"git fsck --l",
];

const PI_OBJECT_READS_ALLOW = [
	"git hash-object f",
	"git hash-object --stdin",
	"git fsck",
	"git fsck --connectivity-only",
];

describe("pi: object-write fences live in the ask tier", () => {
	test("pi orchestrator: hash-object and fsck write forms ask, never allow", () => {
		for (const command of PI_OBJECT_WRITE_FENCES_NOT_ALLOW) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("pi orchestrator: safe hash-object and fsck forms still allow", () => {
		for (const command of PI_OBJECT_READS_ALLOW) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});
});

// A sed script can run a shell command, so no sed allow exists; `sed -i` asks.
const PI_SED_IN_PLACE_NOT_ALLOW = [
	"sed -i 's/a/b/' README.md",
	`sed -"i" 's/a/b/' README.md`,
	"sed -ni 'p' README.md",
	"sed --in-place README.md",
];

// The sed `e` command and the `s///e` flag run a shell command.
const PI_SED_EXECUTE_NOT_ALLOW = [
	"sed '1e id' README.md",
	"sed 's/a/b/e' README.md",
	"sed -n '1e id' README.md",
];

// No sed allow exists, so a read-only filter falls to the default verdict.
const PI_SED_READS_FALL_THROUGH = ["sed 's/a/b/' README.md", "sed -n '1p' README.md"];

describe("pi: sed in-place edits ask, never allow", () => {
	for (const agent of ["implementer", "tester", "reviewer", "researcher"]) {
		test(`pi ${agent}: sed -i forms ask, never allow`, () => {
			for (const command of PI_SED_IN_PLACE_NOT_ALLOW) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		});

		test(`pi ${agent}: sed execute forms deny`, () => {
			for (const command of PI_SED_EXECUTE_NOT_ALLOW) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		});

		test(`pi ${agent}: read-only sed falls to the default verdict`, () => {
			for (const command of PI_SED_READS_FALL_THROUGH) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		});
	}
});
