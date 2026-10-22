/**
 * The Claude Code doctrine hook (platforms/claude/scripts/doctrine.ts).
 *
 * The commit and file doctrine from AGENTS.md, per persona-agents agent:
 * git history and gh pr/release ask for the orchestrator and deny the rest;
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

const HISTORY = [
	"git add .",
	"git commit -m 'ai: x'",
	"git push origin main",
	"git pull --rebase",
	"git merge feature",
	"git rebase main",
	"git tag v1.0.0",
	"git tag -d v1.0.0",
	"gh pr create --fill",
	"gh release create v1.0.0",
	// AGENTS.md gates every gh pr and gh release command, reads included.
	"gh pr list",
	"gh release list",
];

/** Disguised history writes: prefixes, wrappers, compounds, substitutions. */
const DISGUISED_HISTORY = [
	"git status && git commit -m x",
	"cd /repo && git -C /repo commit -m 'a; b'",
	"git -c user.name=x --no-pager commit -m x",
	"/usr/bin/git push",
	"FOO=1 sudo -u root git push",
	"env -u HOME git push",
	"timeout 30 git push",
	"eval git push",
	"xargs -n 1 git add < files",
	"bash -c 'git push origin main'",
	"sh -lc \"cd /r && git commit -m x\"",
	"echo $(git commit -m x)",
	"cat notes | (git commit -F -)",
];

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
	"npm test",
];

describe("doctrine: git history and gh pr/release", () => {
	for (const command of [...HISTORY, ...DISGUISED_HISTORY]) {
		test(command, () => {
			assert.equal(bash("orchestrator", command), "ask");
			for (const profession of PROFESSIONS.filter((p) => p !== "orchestrator")) {
				assert.equal(bash(profession, command), "deny", profession);
			}
		});
	}
});

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

	test("an ask explains the approval; a deny names who may run it", () => {
		const reason = (profession: string, command: string): string =>
			decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";
		assert.match(reason("orchestrator", "git push"), /needs your approval/);
		assert.match(reason("implementer", "git push"), /only the orchestrator/);
		assert.match(reason("implementer", "cp a b"), /need your approval/);
		assert.match(reason("tester", "cp a b"), /for the orchestrator and the implementer only/);
	});

	test("a mixed compound takes the strongest verdict", () => {
		// The implementer may ask for cp, but the commit in the same call denies it.
		assert.equal(bash("implementer", "cp a b && git commit -m x"), "deny");
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

	test("no hit prints nothing", () => {
		assert.equal(run({ agent_type: "persona-agents:tester", tool_name: "Bash", tool_input: { command: "git status" } }), "");
	});
});
