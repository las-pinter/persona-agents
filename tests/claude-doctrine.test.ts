/**
 * The Claude Code doctrine hook (platforms/claude/scripts/doctrine.ts).
 *
 * Per persona-agents agent: a plain git add/commit/pull/merge/rebase/tag is
 * allowed for the companion; git push, gh pr/release/run writes, the ask exceptions,
 * and wrapped forms ask for the companion; every other agent (the reviewer)
 * is denied all of these and every shell write it can see. Agents outside the
 * plugin get no decision.
 *
 * Run: node --experimental-strip-types --test tests/claude-doctrine.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, shellWords } from "../platforms/claude/scripts/doctrine.ts";
import { parseShellCommand } from "../platforms/shared/shell/shell-parse.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctrineScript = path.join(repoRoot, "platforms", "claude", "scripts", "doctrine.ts");

const PROFESSIONS = ["companion", "reviewer"];

/** The verdict for one agent running one shell command ("none" for no decision). */
function bash(profession: string, command: string): string {
	return decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.verdict ?? "none";
}

/** The verdict with a session cwd and its additional directories. */
function bashAt(profession: string, command: string, cwd: string, additionalDirs: string[] = []): string {
	return (
		decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command }, cwd }, additionalDirs)
			?.verdict ?? "none"
	);
}

/** Plain history writes: the companion runs them without a prompt. */
const ALLOWED = [
	"git add .",
	"git commit -m 'ai: x'",
	"git commit -m 'a; b && c'",
	"git pull --rebase",
	"git merge feature",
	"git rebase main",
	"git rebase -i main",
	"git rebase --exec 'npm test' main",
	"git tag v1.0.0",
	"git tag -a v1.0.0 -m 'release'",
	"git -C /repo commit -m 'a; b'",
	"git --no-pager commit -m x",
	"git --git-dir=/repo/.git add .",
	"git commit -m x 2>&1",
	"git add . > /dev/null",
	"git commit -F - < msg.txt",
	// A quoted heredoc that only feeds `git commit -F -` is data.
	"git commit -F - <<'EOF'\nmsg\nEOF",
	"git commit -m m >&2",
	"git commit -m m 2>&1 >/dev/null",
	"git -p commit -m x",
	"git --work-tree /tmp commit -m x",
	"git -C x tag v1",
	"git merge -X ours main",
	"git pull --rebase=interactive",
	"git rebase -X ours main",
	"git rebase -Xours main",
	"git rebase -S main",
	"git rebase -x 'npm test' main",
	"git add . && git commit -m m",
	"git add .; git commit -m m",
	// Read-only git and a filter are inert beside a history command.
	"git status && git commit -m x",
	"git log | tail -5 && git add .",
	// Local git work the owner allowed: tag writes, amend, and the destructive verbs.
	"git tag -d v1",
	"git tag --delete v1",
	"git tag -f v1",
	"git tag --force v1",
	"git tag -fa v1 -m x",
	"git tag --del v1",
	"git tag -fm1 v1",
	"git tag -fFmsg v1",
	"git tag -fm. v1",
	"git tag -dv1",
	"git tag -n1 -f v1",
	"git tag --sort=x --delete v1",
	"git commit --amend",
	"git commit --amen",
	"git checkout -- file.ts",
	"git stash",
	"git reset --hard",
	"git branch -D topic",
	// `-l` after a value-taking option is a message, not the list flag.
	"git tag -m msg -l v1",
	"git tag -m -l v1",
	"git tag -fm -l v1",
	"git tag --mess -l v1",
	"git commit -m 'fix: std::vector'",
	"git merge -m 'note::x' feature",
	"git merge --mess 'note::x' feature",
];

/** Publish commands and the ask exceptions. */
const ASKED = [
	"git push origin main",
	"gh pr create --fill",
	"gh pr merge 4 --squash",
	"gh pr close 4",
	"gh release create v1.0.0",
	// AGENTS.md gates every gh pr, gh release, and gh run write; a read action
	// (view, list, status, diff, checks, search) is ungated.
	"gh run delete 3",
	"gh run cancel 3",
	// A gh global option before the subcommand does not hide the gate.
	"gh --repo=owner/repo run delete 1",
	"git -c core.hooksPath=/x commit -m m",
	"git -c user.name=x --no-pager commit -m x",
	"git --config-env=core.hooksPath=X commit -m m",
	"git --exec-path=/tmp/x commit -m m",
	"git pull --upload-pack='touch x' origin",
	"git add . && git push",
	// Unknown global options: the subcommand git runs is not known.
	"git --attr-source commit push origin main",
	"git --attr-source HEAD push",
	"git --config-env core.hooksPath=X commit -m x",
	"git --exec-path commit -m m",
	// A verb that runs another program, writes config, or reaches a remote.
	"git config core.hooksPath=/tmp/x",
	"git config alias.x '!sh'",
	"git bisect run npm test",
	"git submodule foreach 'rm -rf x'",
	"git difftool --extcmd=sh",
	"git filter-branch --tree-filter x",
	"git fetch ext::sh origin",
	"git clone 'ext::sh -c x' dir",
	"git ls-remote ext::x",
	"git remote add evil ext::x",
	"git fetch --upload-pack='touch x' origin",
	"git lfs push origin",
	"git send-email patch",
	"git pull --upload='touch x' origin",
	"git archive --remote=ext::sh --output=/tmp/x HEAD",
	"git config --unset core.x",
	"git config --add core.x y",
	"git config --rem core.x",
	"git config --unset-all core.x",
	"git config --unset-a core.x",
	"git send-pack origin main",
	"git http-push origin main",
	"git fetch-pack origin",
	"git config --remove core.x",
	"git fetch-pack --upload-pack='touch x' origin",
	"git send-pack ext::sh origin main",
	// A dup redirect to a word that is not a plain fd writes a file.
	"git commit -m m >&0file",
	// Transport helper URLs and merge strategies run a program of the caller's choice.
	"git pull ext::sh origin",
	"git pull 'ext::sh -c touch% /tmp/x' main",
	"git merge fd::3 main",
	"git merge -s evil main",
	"git merge --strategy evil main",
	"git merge --strategy=evil main",
	"git merge -sevil main",
	"git merge -ns evil main",
	"git pull -s evil origin",
	"git pull --strategy=evil origin",
	"git rebase -s evil main",
	"git rebase --strategy=evil main",
	"git rebase --strategy evil main",
	"git rebase -sevil main",
	"git rebase -is evil main",
];

/** Disguised history writes: prefixes, wrappers, substitutions, runtime shapes. */
const DISGUISED_HISTORY = [
	"/usr/bin/git push",
	"/tmp/x/git commit -m m",
	"./git add .",
	"FOO=1 sudo -u root git push",
	"GIT_DIR=/x git commit -m m",
	"sudo git commit -m x",
	"env git add .",
	"env -u HOME git push",
	"command git commit -m m",
	"timeout 30 git add .",
	"eval git push",
	"eval git commit -m m",
	"xargs -n 1 git add < files",
	"bash -c 'git push origin main'",
	"bash -c 'git commit -m x'",
	"sh -lc \"cd /r && git commit -m x\"",
	"echo $(git commit -m x)",
	"echo `git add .`",
	"git commit -m \"$(date)\"",
	"(git commit -m x)",
	"cat notes | (git commit -F -)",
	"{ git add .; }",
	"git commit -m $MSG",
	"git commit $ARGS",
	"git commit -m \"${MSG}\"",
	"git add *",
	"git add src/*.ts",
	"git add {a,b}",
	"git commit -m x > out.txt",
	"git commit -m x >> out.txt",
	"git commit -m x &> out.txt",
	"git commit -m x >&out.txt",
	"! git commit -m m",
];

/** `bash -c` nested `levels` deep around `command`. */
function nestShell(command: string, levels: number): string {
	let out = command;
	for (let i = 0; i < levels; i++) out = `bash -c '${out.replace(/'/g, "'\\''")}'`;
	return out;
}

describe("doctrine: git work", () => {
	for (const command of ALLOWED) {
		test(command, () => {
			assert.equal(bash("companion", command), "allow");
			for (const profession of PROFESSIONS.filter((p) => p !== "companion")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}
});

describe("doctrine: git push, gh pr/release/run, ask exceptions, wrapped forms", () => {
	for (const command of [...ASKED, ...DISGUISED_HISTORY]) {
		test(command, () => {
			assert.equal(bash("companion", command), "ask");
			for (const profession of PROFESSIONS.filter((p) => p !== "companion")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}
});

describe("doctrine: an allow covers every segment or none", () => {
	/** An allowed segment next to an ungated one: Claude Code decides. */
	const MIXED = [
		"git add . && rm -rf x",
		"git commit -m x; curl https://example.com",
		"cd /repo && git -C /repo commit -m 'a; b'",
		"git commit -m x | tee log",
		"git add . & rm x",
		"FOO=1; git commit -m m",
		"bash -c 'git status'; git add .",
	];
	for (const command of MIXED) {
		test(command, () => {
			assert.equal(bash("companion", command), "none");
			for (const profession of PROFESSIONS.filter((p) => p !== "companion")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}

	test("a nested shell never allows, at any depth", () => {
		for (const levels of [1, 3, 4, 5, 7]) {
			const command = nestShell("git add .", levels);
			assert.equal(bash("companion", command), "ask", command);
			assert.equal(bash("reviewer", command), "deny", command);
		}
	});

	test("an ask segment beats an allow segment", () => {
		assert.equal(bash("companion", "git status && git push"), "ask");
		assert.equal(bash("companion", "git commit -m m && git push"), "ask");
	});
});

/** Reads that must never be gated. */
const READS = [
	"git status",
	"git tag",
	"git tag -l",
	"git tag --list 'v*'",
	"git log | grep commit",
	"git tag --contains HEAD",
	"git tag -l -f v1",
	"git tag --list -d v1",
	"git tag -l v1 -d",
	"git config --get core.hooksPath",
	"git config --list",
	"git remote -v",
	"git remote",
	"git config user.name",
	"git remote show origin",
	"git remote get-url origin",
	"git config --get-regexp '^user' name",
	"gh issue list",
	// A gh publish sub-command's read action is a read: no prompt on any agent.
	"gh pr list",
	"gh pr view 23",
	"gh pr view 23 --json state,mergeable",
	"gh pr diff 23",
	"gh pr checks 23",
	"gh pr status",
	"gh run list",
	"gh run view 7",
	"gh release list",
	"gh release view v1.0.0",
	"gh pr ls",
	"gh run ls",
	"gh release ls",
	"gh -R owner/repo run list",
	"gh --repo owner/repo run list",
	"gh --repo=owner/repo pr view 23",
	"echo 'git push is gated'",
	"grep -r 'git commit' docs",
	"command -v git",
	"git --version",
	"git --help commit",
	"npm test",
];

describe("doctrine: reads stay untouched", () => {
	for (const command of READS) {
		test(command, () => {
			for (const profession of PROFESSIONS) assert.equal(bash(profession, command), "none", profession);
		});
	}
});

describe("doctrine: a commit chain with inert parts", () => {
	const chain = [
		"cd /repo && cargo fmt && git add -A && git commit -q -F - <<'EOF' | grep -v Passed | tail -5",
		"msg",
		"EOF",
		"git log --oneline -1",
	].join("\n");

	test("the companion allows the observed chain; the reviewer denies it", () => {
		assert.equal(bashAt("companion", chain, "/repo"), "allow");
		assert.equal(bashAt("reviewer", chain, "/repo"), "deny");
	});

	test("a cd inside the session allows; one outside gives no decision", () => {
		assert.equal(bashAt("companion", "cd /repo/sub && git commit -m x", "/repo"), "allow");
		assert.equal(bashAt("companion", "cd /elsewhere && git commit -m x", "/repo"), "none");
		assert.equal(bashAt("reviewer", "cd /elsewhere && git commit -m x", "/repo"), "deny");
	});

	test("an additional working directory is a session directory", () => {
		assert.equal(bashAt("companion", "cd /notes && git commit -m x", "/repo", ["/notes"]), "allow");
		assert.equal(bashAt("companion", "cd /notes && git commit -m x", "/repo"), "none");
	});

	test("a publish in the chain asks", () => {
		assert.equal(bashAt("companion", "cd /repo && cargo fmt && git add -A && git push", "/repo"), "ask");
	});

	test("a file redirect, a substitution, and an outside write keep the prompt", () => {
		assert.equal(bashAt("companion", "git add -A && git log > out.txt", "/repo"), "none");
		assert.equal(bashAt("companion", 'git commit -m "$(cat x)"', "/repo"), "ask");
		assert.equal(bashAt("companion", "git add -A && rm -rf x", "/repo"), "none");
	});

	test("a git read hidden behind an expansion or a program option gives no decision", () => {
		assert.equal(bashAt("companion", "git log $OPS && git add -A", "/repo"), "none");
		assert.equal(bashAt("companion", "git config $X && git add -A", "/repo"), "none");
		assert.equal(bashAt("companion", "git diff --ext-diff && git add -A", "/repo"), "none");
		assert.equal(bashAt("companion", "git grep -O sh foo && git add -A", "/repo"), "none");
		assert.equal(bashAt("companion", "git remote show origin && git add -A", "/repo"), "none");
	});

	test("a cd carries across segments", () => {
		assert.equal(bashAt("companion", "cd /work && git add -A; cd ../evil && git commit -m x", "/work/repo", ["/work"]), "none");
	});

	test("without a cwd no cd is a session directory", () => {
		assert.equal(bash("companion", "cd /repo && git commit -m x"), "none");
	});
});

describe("doctrine: fail closed", () => {
	test("an unreadable command that names git is a hit", () => {
		const heredoc = "cat <<EOF\ngit push\nEOF";
		assert.equal(bash("companion", heredoc), "ask");
		assert.equal(bash("reviewer", heredoc), "deny");
	});

	test("an unreadable command that names no gated program and writes no file is left alone", () => {
		assert.equal(bash("reviewer", "cat <<EOF\nhello\nEOF"), "none");
	});

	test("an unreadable command that redirects into a file is a write", () => {
		assert.equal(bash("reviewer", "cat <<EOF > notes.txt\nhello\nEOF"), "deny");
		assert.equal(bash("companion", "cat <<EOF > notes.txt\nhello\nEOF"), "none");
	});

	test("an unreadable command with only a git read is left alone", () => {
		const command = "git status && python3 - <<EOF\nprint(1)\nEOF";
		assert.equal(bash("reviewer", command), "none");
		assert.equal(bash("companion", command), "none");
	});

	/** Unreadable commands whose raw text holds a gated form or a form the scan cannot read. */
	const FAIL_CLOSED_TEXT = [
		"git status && python3 - <<EOF\nprint(1)\nEOF\ngit commit -m x",
		"git status && python3 - <<EOF\nprint(1)\nEOF\ngit push",
		"git status && python3 - <<EOF\nprint(1)\nEOF\ngh pr create",
		"git -c x=y status && python3 - <<EOF\nprint(1)\nEOF",
		"git status && python3 - <<EOF\ngit commit -m x\nEOF",
		"git $(echo commit) && python3 - <<EOF\nprint(1)\nEOF",
		"git --no-pager -C /x commit && python3 - <<EOF\nprint(1)\nEOF",
		// A quoted option value with a space must not leak its second half as a word.
		'git -C "a b" commit\npython3 - <<EOF\nprint(1)\nEOF',
		"git -C 'a b' commit\npython3 - <<EOF\nprint(1)\nEOF",
		'git --git-dir "a b" commit\npython3 - <<EOF\nprint(1)\nEOF',
		'git -C "$(echo a b)" commit\npython3 - <<EOF\nprint(1)\nEOF',
		'git -C "a  b" push\npython3 - <<EOF\nprint(1)\nEOF',
		'gh -R "o r" pr create\npython3 - <<EOF\nprint(1)\nEOF',
		'git --git-dir="a b" commit\npython3 - <<EOF\nprint(1)\nEOF',
		"git --git-dir=x commit\npython3 - <<EOF\nprint(1)\nEOF",
		"gh --repo=o/r pr\npython3 - <<EOF\nprint(1)\nEOF",
		"command git commit\npython3 - <<EOF\nprint(1)\nEOF",
		"env git commit\npython3 - <<EOF\nprint(1)\nEOF",
		"/usr/bin/git commit\npython3 - <<EOF\nprint(1)\nEOF",
		"git -ccore.x=y commit\npython3 - <<EOF\nprint(1)\nEOF",
		// A quoted program name is still found.
		'"git" commit\npython3 - <<EOF\nprint(1)\nEOF',
		"'git' commit\npython3 - <<EOF\nprint(1)\nEOF",
	];
	for (const command of FAIL_CLOSED_TEXT) {
		test(`an unreadable command with a gated form stays a hit: ${JSON.stringify(command)}`, () => {
			assert.equal(bash("companion", command), "ask");
			assert.equal(bash("reviewer", command), "deny");
		});
	}

	/** Quoted heredoc bodies that the shell passes as plain data. */
	const DATA_HEREDOCS = [
		"python3 - <<'PY'\n# then run git commit\nprint(1)\nPY",
		"python3 - <<'PY'\nshutil.copy(a, b)  # like cp a b\nPY",
		'python3 - <<"PY"\nx = "mv old new"\nPY',
		"cat <<'EOF' > notes.md\ngit push\nEOF",
		"tee notes.md <<'EOF'\ngit push\nEOF\n",
		"cat\t<<'EOF'\t>\tf\ngit push\nEOF",
		"cat <<'EOF'\ngit push\nEOF\n   ",
		// Known limit: interpreter code in a body is not inspected.
		"node - <<'JS'\nrequire('child_process').execSync('git push');\nJS",
	];
	for (const command of DATA_HEREDOCS) {
		test(`a quoted heredoc body is data: ${JSON.stringify(command)}`, () => {
			assert.equal(bash("companion", command), "none");
			// A body is data, but a redirect or tee in the header still writes a file.
			const writes = /^(?:cat[^\n]*>|tee )/.test(command);
			assert.equal(bash("reviewer", command), writes ? "deny" : "none");
		});
	}

	/** Heredocs that still hit the history gate. */
	const GATED_HEREDOCS = [
		"cat <<'EOF' > f && git push\nhello\nEOF",
		"bash <<'EOF'\ngit push\nEOF",
		"sh -s <<'EOF'\ngit push\nEOF",
		"xargs git <<'EOF'\npush\nEOF",
		"cat <<EOF\n$(git push)\nEOF",
		"cat <<'EOF'\ngit push",
		'bash <<< "git push"',
		"cat <<EOF\n/usr/bin/git push\nEOF",
		"cat <<'EOF'\ngit push\nEOF \n",
		"cat <<'EOF'\nEOF\ngit push",
		// Each one runs a real git push.
		"cat <<'EO'F\nEOF\ngit push\nEO",
		"echo $'a' \"\n<<'X'\n\"; git push\nX",
		"cat <<'A'\na\nA\necho '\n<<\"X\"\n'; git push\nX",
		"cat <<'EOF' \\\n| bash\ngit push\nEOF",
		"echo $(bash <<'EOF'\ngit push\nEOF\n)",
		"x=$(bash <<'EOF'\ngit push\nEOF\n)",
		"if bash <<'EOF'\ngit push\nEOF\nthen :; fi",
		"! bash <<'EOF'\ngit push\nEOF",
		"( (bash <<'EOF'\ngit push\nEOF\n) )",
		"cat <<'EOF' | (bash)\ngit push\nEOF",
		"cat <<'EOF' | tee >(bash)\ngit push\nEOF",
		"$SHELL <<'EOF'\ngit push\nEOF",
		"busybox sh <<'EOF'\ngit push\nEOF",
		"setsid bash <<'EOF'\ngit push\nEOF",
		"cat <<'EOF' | sudo -s\ngit push\nEOF",
		"cat <<'EOF' | parallel\ngit push\nEOF",
		"at now <<'EOF'\ngit push\nEOF",
		"2>/dev/null bash <<'EOF'\ngit push\nEOF",
		"stdbuf -o 0 bash <<'EOF'\ngit push\nEOF",
		"cat <<'EOF' > s.sh\ngit push\nEOF\nbash s.sh",
		"fish <<'EOF'\ngit push\nEOF",
		"cat <<'EOF'\r\ngit push\r\nEOF\r",
		"cat <<'EOF' | bash\ngit push\nEOF",
		"sudo bash <<'EOF'\ngit push\nEOF",
		"/bin/bash <<'EOF'\ngit push\nEOF",
	];
	for (const command of GATED_HEREDOCS) {
		test(`a heredoc stays gated: ${JSON.stringify(command)}`, () => {
			assert.equal(bash("companion", command), "ask");
			assert.equal(bash("reviewer", command), "deny");
			assert.equal(bash("reviewer", command), "deny");
		});
	}

	test("the fail-closed scan returns only the gate it matched", () => {
		const command = "python3 - <<EOF\nmv a b\nEOF";
		const reason = (profession: string): string =>
			decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";
		assert.equal(bash("companion", command), "none");
		assert.equal(bash("reviewer", command), "deny");
		assert.match(reason("reviewer"), /read-only/);
		assert.doesNotMatch(reason("reviewer"), /git history/);
	});

	test("an ask explains the approval; a deny names who may run it", () => {
		const reason = (profession: string, command: string): string =>
			decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";
		assert.match(reason("companion", "git push"), /needs your approval/);
		assert.match(reason("companion", "git commit --amend"), /without a prompt/);
		assert.match(reason("companion", "git pull --upload-pack='touch x' origin"), /needs your approval/);
		assert.match(reason("companion", "git commit -m m"), /without a prompt/);
		assert.match(reason("reviewer", "git push"), /only the companion/);
		assert.match(reason("reviewer", "git commit -m m"), /only the companion/);
		assert.match(reason("reviewer", "cp a b"), /read-only/);
	});

	test("a mixed compound takes the strongest verdict", () => {
		assert.equal(bash("reviewer", "cp a b && git commit -m x"), "deny");
		// For the companion, cp is ungated, so the commit allow does not cover the call.
		assert.equal(bash("companion", "cp a b && git commit -m x"), "none");
		assert.equal(bash("companion", "git commit -m x && git push && cp a b"), "ask");
	});

	test("a quoted commit heredoc allows; an expanding form still asks", () => {
		assert.equal(bash("companion", "git commit -F - <<'EOF'\nmsg\nEOF"), "allow");
		assert.equal(bash("reviewer", "git commit -F - <<'EOF'\nmsg\nEOF"), "deny");
		for (const command of [
			"git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
			"cat <<'EOF' | git commit -F -\nmsg\nEOF",
		]) {
			assert.equal(bash("companion", command), "ask", command);
			assert.equal(bash("reviewer", command), "deny", command);
		}
	});
});

describe("doctrine: the shell parser contract", () => {
	test("an unreadable heredoc reaches the hook as unsupported", () => {
		const command = "cat <<EOF\ngit push\nEOF";
		assert.equal(parseShellCommand(command).unsupported, "heredoc");
		assert.equal(bash("companion", command), "ask");
		assert.equal(bash("reviewer", command), "deny");
	});
});

describe("doctrine: scope", () => {
	test("sessions and agents outside the plugin get no decision", () => {
		for (const agent_type of [undefined, "Explore", "general-purpose", "other-plugin:implementer"]) {
			assert.equal(
				decide({ agent_type, tool_name: "Bash", tool_input: { command: "git push" } }),
				null,
				String(agent_type),
			);
		}
	});

	test("other tools are left alone", () => {
		assert.equal(decide({ agent_type: "persona-agents:reviewer", tool_name: "Read", tool_input: { file_path: "/x" } }), null);
	});

	test("shell words drop quotes and keep escapes", () => {
		assert.deepEqual(shellWords(`git commit -m "a b" 'c d' e\\ f`), ["git", "commit", "-m", "a b", "c d", "e f"]);
	});
});

describe("doctrine: hook wiring", () => {
	/** Run the script the way hooks.json does, with optional extra arguments. */
	function run(input: Record<string, unknown>, env: Record<string, string> = {}, args: string[] = []): string {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", doctrineScript, ...args], {
			input: JSON.stringify(input),
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	}

	test("a hit prints a PreToolUse permission decision", () => {
		const out = JSON.parse(
			run({ agent_type: "persona-agents:reviewer", tool_name: "Bash", tool_input: { command: "git push" } }),
		) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
		assert.match(out.hookSpecificOutput.permissionDecisionReason, /persona-agents doctrine \(reviewer\)/);
	});

	test("a plain commit prints an allow for the companion", () => {
		const out = JSON.parse(
			run({ agent_type: "persona-agents:companion", tool_name: "Bash", tool_input: { command: "git commit -m m" } }),
		) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
	});

	test("no hit prints nothing", () => {
		assert.equal(run({ agent_type: "persona-agents:reviewer", tool_name: "Bash", tool_input: { command: "git status" } }), "");
	});

	test("the hook reads the additional directories from the settings", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-doctrine-"));
		try {
			const project = path.join(root, "project");
			const config = path.join(root, "config");
			const extra = path.join(root, "extra");
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(config, { recursive: true });
			fs.mkdirSync(extra);
			fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [extra] } }));
			// The managed file is a temp seam, so the real system file cannot widen the set.
			const managed = path.join(root, "managed-settings.json");
			fs.writeFileSync(managed, "{}");
			const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project };
			const args = [`--managed-settings=${managed}`];
			const input = (command: string) => ({ agent_type: "persona-agents:companion", tool_name: "Bash", tool_input: { command }, cwd: project });
			const allowed = JSON.parse(run(input(`cd ${extra} && git commit -m x`), env, args)) as {
				hookSpecificOutput: Record<string, string>;
			};
			assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
			assert.equal(run(input("cd /elsewhere && git commit -m x"), env, args), "");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});


});

/** Shell writes: the reviewer is denied, the companion gets no decision. */
const WRITES = [
	"rm -rf build",
	"echo x > out.txt",
	"npm test > /tmp/log.txt",
	"sed -i s/a/b/ file.ts",
	"perl -pi -e s/a/b/ file.ts",
	"cp a b",
	"bash -c 'mv a b'",
	"tee log.txt < input",
	"gh issue create -t x",
	"curl -o x https://example.com",
	"cat <<EOF > notes.txt\nhello\nEOF",
];

describe("doctrine: shell writes", () => {
	for (const command of WRITES) {
		test(command, () => {
			assert.equal(bash("reviewer", command), "deny");
			assert.equal(bash("companion", command), "none");
		});
	}

	test("reads with a harmless redirect stay untouched", () => {
		for (const command of ["npm test 2>&1", "git diff > /dev/null", "git branch", "git branch -a", "git branch --show-current", "gh pr view 1"]) {
			assert.equal(bash("reviewer", command), "none", command);
		}
	});
});
