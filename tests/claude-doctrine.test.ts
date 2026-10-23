/**
 * The Claude Code doctrine hook (platforms/claude/scripts/doctrine.ts).
 *
 * The commit and file doctrine from AGENTS.md, per persona-agents agent:
 * a plain git add/commit/pull/merge/rebase/tag is allowed for the
 * orchestrator; git push, gh pr/release, the ask exceptions, and wrapped
 * forms ask for the orchestrator; all of these deny the rest;
 * cp/mv/rsync ask for the orchestrator and the implementer and deny the rest;
 * edits outside an agent's notes zone ask (orchestrator) or deny (planner,
 * researcher, reviewer, mascot). Agents outside the plugin get no decision.
 *
 * Run: node --experimental-strip-types --test tests/claude-doctrine.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, shellWords } from "../platforms/claude/scripts/doctrine.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctrineScript = path.join(repoRoot, "platforms", "claude", "scripts", "doctrine.ts");

const PROFESSIONS = ["orchestrator", "planner", "researcher", "implementer", "reviewer", "tester", "mascot"];

/** The verdict for one agent running one shell command ("none" for no decision). */
function bash(profession: string, command: string): string {
	return decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.verdict ?? "none";
}

function edit(profession: string, filePath: string, tool = "Edit"): string {
	const key = tool === "NotebookEdit" ? "notebook_path" : "file_path";
	return decide({ agent_type: `persona-agents:${profession}`, tool_name: tool, tool_input: { [key]: filePath } })?.verdict ?? "none";
}

/** Plain history writes: the orchestrator runs them without a prompt. */
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
	"git commit -m m >&2",
	"git commit -m m 2>&1 >/dev/null",
	"git -p commit -m x",
	"git --work-tree /tmp commit -m x",
	"git -C x tag v1",
	"git merge -X ours main",
	"git merge --squash feature",
	"git pull --rebase=interactive",
	"git rebase -X ours main",
	"git rebase -Xours main",
	"git rebase -S main",
	"git rebase -x 'npm test' main",
	"git add . && git commit -m m",
	"git add .; git commit -m m",
];

/** Publish commands and the ask exceptions. */
const ASKED = [
	"git push origin main",
	"git push --tags",
	"gh pr create --fill",
	"gh release create v1.0.0",
	// AGENTS.md gates every gh pr and gh release command, reads included.
	"gh pr list",
	"gh release list",
	"git tag -d v1",
	"git tag --delete v1",
	"git tag -f v1",
	"git tag --force v1",
	"git tag -fa v1 -m x",
	"git tag --del v1",
	"git -c core.hooksPath=/x commit -m m",
	"git -c user.name=x --no-pager commit -m x",
	"git --config-env=core.hooksPath=X commit -m m",
	"git --exec-path=/tmp/x commit -m m",
	"git commit --amend",
	"git commit --amend --no-edit",
	"git commit --amen",
	"git pull --upload-pack='touch x' origin",
	"git add . && git push",
	// Unknown global options: the subcommand git runs is not known.
	"git --attr-source commit push origin main",
	"git --attr-source HEAD push",
	"git --config-env core.hooksPath=X commit -m x",
	"git --exec-path commit -m m",
	// Short tag bundles and values that hide -d or -f.
	"git tag -fm1 v1",
	"git tag -fFmsg v1",
	"git tag -fm. v1",
	"git tag -dv1",
	"git tag -n1 -f v1",
	"git tag -l -f v1",
	"git tag --list -d v1",
	"git tag -l v1 -d",
	"git tag --sort=x --delete v1",
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

describe("doctrine: plain git history", () => {
	for (const command of ALLOWED) {
		test(command, () => {
			assert.equal(bash("orchestrator", command), "allow");
			for (const profession of PROFESSIONS.filter((p) => p !== "orchestrator")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}
});

describe("doctrine: git push, gh pr/release, ask exceptions, wrapped forms", () => {
	for (const command of [...ASKED, ...DISGUISED_HISTORY]) {
		test(command, () => {
			assert.equal(bash("orchestrator", command), "ask");
			for (const profession of PROFESSIONS.filter((p) => p !== "orchestrator")) {
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
		"git status && git commit -m x",
		"cd /repo && git -C /repo commit -m 'a; b'",
		"git commit -m x | tee log",
		"git add . & rm x",
		"FOO=1; git commit -m m",
		"bash -c 'git status'; git add .",
	];
	for (const command of MIXED) {
		test(command, () => {
			assert.equal(bash("orchestrator", command), "none");
			for (const profession of PROFESSIONS.filter((p) => p !== "orchestrator")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}

	test("a nested shell never allows, at any depth", () => {
		for (const levels of [1, 3, 4, 5, 7]) {
			const command = nestShell("git add .", levels);
			assert.equal(bash("orchestrator", command), "ask", command);
			assert.equal(bash("implementer", command), "deny", command);
		}
	});

	test("an ask segment beats an allow segment", () => {
		assert.equal(bash("orchestrator", "git add . && git push"), "ask");
		assert.equal(bash("orchestrator", "git status && git push"), "ask");
		assert.equal(bash("orchestrator", "git commit -m m && cp a b"), "ask");
	});
});

const COPY = ["cp a b", "mv a b", "rsync -a src/ dst/", "sudo cp a /etc/b", "bash -c 'mv a b'"];

/** Reads that must never be gated. */
const READS = [
	"git status",
	"git log --oneline -5",
	"git diff HEAD~1",
	"git show HEAD",
	"git tag",
	"git tag -l",
	"git tag --list 'v*'",
	"git log | grep commit",
	"git tag --contains HEAD",
	"gh issue list",
	"echo 'git push is gated'",
	"grep -r 'git commit' docs",
	"command -v git",
	"git --version",
	"git --help commit",
	"npm test",
];

describe("doctrine: cp, mv, rsync", () => {
	for (const command of COPY) {
		test(command, () => {
			for (const profession of PROFESSIONS) {
				const expected = profession === "orchestrator" || profession === "implementer" ? "ask" : "deny";
				assert.equal(bash(profession, command), expected, profession);
			}
		});
	}
});

describe("doctrine: reads stay untouched", () => {
	for (const command of READS) {
		test(command, () => {
			for (const profession of PROFESSIONS) assert.equal(bash(profession, command), "none", profession);
		});
	}
});

describe("doctrine: fail closed", () => {
	test("an unreadable command that names git is a hit", () => {
		const heredoc = "cat <<EOF\ngit push\nEOF";
		assert.equal(bash("orchestrator", heredoc), "ask");
		assert.equal(bash("implementer", heredoc), "deny");
	});

	test("an unreadable command that names no gated program is left alone", () => {
		assert.equal(bash("implementer", "cat <<EOF > notes.txt\nhello\nEOF"), "none");
	});

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
			for (const profession of ["implementer", "orchestrator", "tester"]) {
				assert.equal(bash(profession, command), "none", profession);
			}
		});
	}

	/** Heredocs that still hit the history gate. */
	const GATED_HEREDOCS = [
		"cat <<'EOF' > f && git push\nhello\nEOF",
		"git commit -F - <<'EOF'\nmsg\nEOF",
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
			assert.equal(bash("orchestrator", command), "ask");
			assert.equal(bash("implementer", command), "deny");
			assert.equal(bash("tester", command), "deny");
		});
	}

	test("the fail-closed scan returns only the gate it matched", () => {
		const command = "python3 - <<EOF\nmv a b\nEOF";
		const reason = (profession: string): string =>
			decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";
		assert.equal(bash("orchestrator", command), "ask");
		assert.equal(bash("implementer", command), "ask");
		assert.equal(bash("tester", command), "deny");
		assert.match(reason("implementer"), /cp, mv, and rsync need your approval/);
		assert.match(reason("tester"), /for the orchestrator and the implementer only/);
		assert.doesNotMatch(reason("tester"), /git history/);
	});

	test("an ask explains the approval; a deny names who may run it", () => {
		const reason = (profession: string, command: string): string =>
			decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";
		assert.match(reason("orchestrator", "git push"), /needs your approval/);
		assert.match(reason("orchestrator", "git commit --amend"), /needs your approval/);
		assert.match(reason("orchestrator", "git commit -m m"), /without a prompt/);
		assert.match(reason("implementer", "git push"), /only the orchestrator/);
		assert.match(reason("implementer", "git commit -m m"), /only the orchestrator/);
		assert.match(reason("implementer", "cp a b"), /need your approval/);
		assert.match(reason("tester", "cp a b"), /for the orchestrator and the implementer only/);
	});

	test("a mixed compound takes the strongest verdict", () => {
		// The implementer may ask for cp, but the commit in the same call denies it.
		assert.equal(bash("implementer", "cp a b && git commit -m x"), "deny");
		// For the orchestrator, the cp ask beats the commit allow.
		assert.equal(bash("orchestrator", "cp a b && git commit -m x"), "ask");
		assert.equal(bash("orchestrator", "git commit -m x && git push && cp a b"), "ask");
	});

	test("a commit message from a heredoc asks, never allows", () => {
		for (const command of [
			"git commit -F - <<'EOF'\nmsg\nEOF",
			"git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
			"cat <<'EOF' | git commit -F -\nmsg\nEOF",
		]) {
			assert.equal(bash("orchestrator", command), "ask", command);
			assert.equal(bash("implementer", command), "deny", command);
		}
	});
});

describe("doctrine: file writes", () => {
	const home = "/home/u/agent-notes";
	test("implementer and tester write anywhere", () => {
		for (const profession of ["implementer", "tester"]) {
			assert.equal(edit(profession, "/repo/src/main.ts"), "none", profession);
			assert.equal(edit(profession, "/repo/src/main.ts", "Write"), "none", profession);
		}
	});

	test("the orchestrator writes its notes freely and asks elsewhere", () => {
		assert.equal(edit("orchestrator", `${home}/orchestrator/journal.md`), "none");
		assert.equal(edit("orchestrator", `${home}/project-notes/repo/study.md`, "Write"), "none");
		assert.equal(edit("orchestrator", "/repo/README.md"), "ask");
	});

	test("the planner and researcher write only their own zone", () => {
		assert.equal(edit("planner", `${home}/project-notes/repo/study.md`), "none");
		assert.equal(edit("planner", `${home}/researcher/x.md`), "deny");
		assert.equal(edit("researcher", `${home}/researcher/findings.md`, "Write"), "none");
		assert.equal(edit("researcher", "/repo/src/main.ts"), "deny");
		assert.equal(edit("researcher", "/repo/a.ipynb", "NotebookEdit"), "deny");
	});

	test("the reviewer and the mascot never write", () => {
		for (const profession of ["reviewer", "mascot"]) {
			assert.equal(edit(profession, `${home}/project-notes/x.md`), "deny", profession);
			assert.equal(edit(profession, "/repo/src/main.ts", "Write"), "deny", profession);
		}
	});

	test("a zone name inside another path does not count", () => {
		assert.equal(edit("planner", "/repo/not-agent-notes/project-notes/x.md"), "deny");
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
	/** Run the script the way hooks.json does. */
	function run(input: Record<string, unknown>): string {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", doctrineScript], {
			input: JSON.stringify(input),
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	}

	test("a hit prints a PreToolUse permission decision", () => {
		const out = JSON.parse(
			run({ agent_type: "persona-agents:tester", tool_name: "Bash", tool_input: { command: "git push" } }),
		) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
		assert.match(out.hookSpecificOutput.permissionDecisionReason, /persona-agents doctrine \(tester\)/);
	});

	test("a plain commit prints an allow for the orchestrator", () => {
		const out = JSON.parse(
			run({ agent_type: "persona-agents:orchestrator", tool_name: "Bash", tool_input: { command: "git commit -m m" } }),
		) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
	});

	test("no hit prints nothing", () => {
		assert.equal(run({ agent_type: "persona-agents:tester", tool_name: "Bash", tool_input: { command: "git status" } }), "");
	});
});
