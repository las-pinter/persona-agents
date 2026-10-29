/**
 * The Claude Code doctrine hook (platforms/claude/scripts/doctrine.ts).
 *
 * The commit and file doctrine from AGENTS.md, per persona-agents agent:
 * a plain git add/commit/pull/merge/rebase/tag is allowed for the
 * orchestrator; git push, gh pr/release/run, the ask exceptions, and wrapped
 * forms ask for the orchestrator; all of these deny the rest;
 * cp/mv/rsync ask for the orchestrator and the implementer and deny the rest;
 * the installed journal write script is allowed for the orchestrator;
 * the orchestrator writes anywhere in the repository, anywhere in the
 * agent-notes tree under the home folder, and anywhere in the shared temporary
 * folder, and asks on every other path; the planner, researcher, reviewer, and
 * mascot deny an edit outside their own zone, the temporary folder included.
 * The agent-notes zone is anchored to the home folder, and a leading `~`
 * expands to it. A cwd places no repository when it holds the home folder or
 * sits at a system-wide folder such as `/tmp`. A path resolves through its
 * deepest existing ancestor before a parent segment folds, so a symlink that
 * leaves a zone asks. Agents outside the plugin get no decision.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctrineScript = path.join(repoRoot, "platforms", "claude", "scripts", "doctrine.ts");

const PROFESSIONS = ["orchestrator", "planner", "researcher", "implementer", "reviewer", "tester", "mascot"];

/** The verdict for one agent running one shell command ("none" for no decision). */
function bash(profession: string, command: string): string {
	return decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.verdict ?? "none";
}

function edit(profession: string, filePath: string, tool = "Edit", cwd?: string): string {
	const key = tool === "NotebookEdit" ? "notebook_path" : "file_path";
	return (
		decide({
			agent_type: `persona-agents:${profession}`,
			tool_name: tool,
			tool_input: { [key]: filePath },
			...(cwd === undefined ? {} : { cwd }),
		})?.verdict ?? "none"
	);
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
	"gh pr create --fill",
	"gh release create v1.0.0",
	// AGENTS.md gates every gh pr, gh release, and gh run command, reads included.
	"gh pr list",
	"gh release list",
	"gh run list",
	"gh run delete 3",
	// A gh global option before the subcommand does not hide the gate.
	"gh -R owner/repo run list",
	"gh --repo owner/repo run list",
	"gh --repo=owner/repo run delete 1",
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

describe("doctrine: git push, gh pr/release/run, ask exceptions, wrapped forms", () => {
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
		assert.equal(bash("orchestrator", "git status && git push"), "ask");
		assert.equal(bash("orchestrator", "git commit -m m && cp a b"), "ask");
	});
});

const COPY = ["cp a b", "mv a b", "rsync -a src/ dst/", "sudo cp a /etc/b", "bash -c 'mv a b'"];

/** Reads that must never be gated. */
const READS = [
	"git status",
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
	const userHome = os.homedir();
	const home = path.join(userHome, "agent-notes");
	const repo = path.join(userHome, "repo");
	const reason = (profession: string, filePath: string, cwd?: string): string =>
		decide({
			agent_type: `persona-agents:${profession}`,
			tool_name: "Write",
			tool_input: { file_path: filePath },
			...(cwd === undefined ? {} : { cwd }),
		})?.reason ?? "";

	test("implementer and tester write anywhere", () => {
		for (const profession of ["implementer", "tester"]) {
			assert.equal(edit(profession, "/repo/src/main.ts"), "none", profession);
			assert.equal(edit(profession, "/repo/src/main.ts", "Write"), "none", profession);
		}
	});

	test("the orchestrator writes a relative repository path freely", () => {
		assert.equal(edit("orchestrator", "src/main.ts", "Edit", repo), "none");
		assert.equal(edit("orchestrator", "README.md", "Write", repo), "none");
		// The path resolves against the hook's cwd before the zone is tested.
		assert.equal(edit("orchestrator", "src/../README.md", "Write", repo), "none");
		assert.equal(edit("orchestrator", ".", "Write", repo), "none");
	});

	test("the orchestrator writes an absolute repository path freely", () => {
		assert.equal(edit("orchestrator", `${repo}/src/main.ts`, "Edit", repo), "none");
		assert.equal(edit("orchestrator", `${repo}/content/professions/x.md`, "Write", repo), "none");
	});

	test("the orchestrator writes anywhere in the agent-notes tree", () => {
		assert.equal(edit("orchestrator", `${home}/orchestrator/journal.md`), "none");
		assert.equal(edit("orchestrator", `${home}/project-notes/repo/study.md`, "Write"), "none");
		assert.equal(edit("orchestrator", `${home}/researcher/findings.md`, "Write"), "none");
		assert.equal(edit("orchestrator", "agent-notes/orchestrator/j.md", "Edit", userHome), "none");
		assert.equal(edit("orchestrator", "~/agent-notes/planner/x.md", "Write"), "none");
	});

	test("the orchestrator writes anywhere in the temporary folder", () => {
		for (const tool of ["Edit", "Write", "NotebookEdit"]) {
			assert.equal(edit("orchestrator", "/tmp", tool, repo), "none", tool);
			assert.equal(edit("orchestrator", "/tmp/a.txt", tool, repo), "none", tool);
			assert.equal(edit("orchestrator", "/tmp/a/b/c.txt", tool, repo), "none", tool);
		}
	});

	test("a temp path that is not under /tmp asks", () => {
		for (const target of ["/tmpfoo", "/tmp2/x", "/etc/tmp", "/alphabet/tmp", "/tmp/../etc/passwd", "/tmp/../tmpfoo/x"]) {
			assert.equal(edit("orchestrator", target, "Write", repo), "ask", target);
			assert.equal(edit("orchestrator", target, "Edit", repo), "ask", target);
		}
	});

	test("a symlink under /tmp that leaves /tmp asks", (t) => {
		let base = "";
		try {
			base = fs.mkdtempSync("/tmp/doctrine-temp-");
		} catch {
			t.skip("/tmp is not writable in this environment");
			return;
		}
		try {
			// The link sits inside /tmp and resolves to a folder outside it.
			fs.symlinkSync("/etc", path.join(base, "link"));
			assert.equal(edit("orchestrator", path.join(base, "link", "passwd"), "Edit", repo), "ask");
			assert.equal(edit("orchestrator", path.join(base, "link", "x.md"), "Write", repo), "ask");
			// A plain path in the same folder still writes freely.
			assert.equal(edit("orchestrator", path.join(base, "x.md"), "Write", repo), "none");
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test("a parent segment after a link does not escape the temporary zone", (t) => {
		let base = "";
		try {
			// The escape case runs only where the system temporary folder resolves
			// to /tmp, so the fixture must sit under it.
			if (fs.realpathSync(os.tmpdir()) !== "/tmp") {
				t.skip("the system temporary folder is not /tmp");
				return;
			}
			base = fs.mkdtempSync(path.join(os.tmpdir(), "doctrine-link-"));
		} catch {
			t.skip("the system temporary folder is not writable in this environment");
			return;
		}
		try {
			// The link sits in /tmp and resolves outside it. The kernel follows the
			// link, then folds the parent segment, so this target writes at /x. A
			// fold of the parent segment first would say /tmp/x and pass.
			fs.symlinkSync("/etc", path.join(base, "link"));
			assert.equal(edit("orchestrator", `${base}/link/../x.md`, "Write", repo), "ask");
			assert.equal(edit("orchestrator", `${base}/link/../x.md`, "Edit", repo), "ask");
			// A parent segment that stays in /tmp still writes freely.
			fs.mkdirSync(path.join(base, "sub"));
			assert.equal(edit("orchestrator", `${base}/sub/../y.md`, "Write", repo), "none");
			// A link that resolves inside /tmp keeps the parent fold inside it.
			fs.mkdirSync(path.join(base, "inner"));
			fs.symlinkSync(path.join(base, "inner"), path.join(base, "inside"));
			assert.equal(edit("orchestrator", `${base}/inside/../z.md`, "Write", repo), "none");
			assert.equal(edit("orchestrator", `${base}/plain.md`, "Write", repo), "none");
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test("the orchestrator asks on a path outside the repository, the notes, and the temporary folder", () => {
		assert.equal(edit("orchestrator", "/etc/passwd", "Write", repo), "ask");
		assert.equal(edit("orchestrator", `${repo}/../etc/passwd`, "Write", repo), "ask");
		assert.equal(edit("orchestrator", "../other/x.md", "Write", repo), "ask");
		assert.equal(edit("orchestrator", "/home/u/not-agent-notes/x.md", "Write", repo), "ask");
		// Without an absolute cwd the hook cannot place an absolute path.
		assert.equal(edit("orchestrator", `${repo}/src/main.ts`, "Write"), "ask");
		// An empty path is not a repository path.
		assert.equal(edit("orchestrator", "", "Write"), "ask");
		assert.match(
			reason("orchestrator", "/etc/passwd", repo),
			/outside the repository, the agent-notes tree, and the temporary folder/,
		);
	});

	test("an ask reason names the approval, not a capability limit", () => {
		const text = reason("orchestrator", "/etc/passwd", repo);
		assert.match(text, /needs your approval/);
		assert.doesNotMatch(text, /does not edit/);
	});

	test("the agent-notes zone is anchored to the home folder", () => {
		// A parent segment after agent-notes leaves the tree.
		assert.equal(edit("orchestrator", `${home}/../etc/passwd`, "Write", repo), "ask");
		assert.equal(edit("orchestrator", `${home}/orchestrator/../../etc/passwd`, "Write"), "ask");
		// agent-notes in another folder is not the tree; the /tmp path writes
		// through the temporary folder zone, not through this one.
		assert.equal(edit("orchestrator", "/tmp/agent-notes/x", "Write", repo), "none");
		assert.equal(edit("orchestrator", "/tmp/agent-notes/orchestrator/j.md", "Edit", repo), "none");
		// agent-notes as a middle segment of another folder.
		assert.equal(edit("orchestrator", `${userHome}/x/agent-notes/y.md`, "Write", repo), "ask");
		assert.equal(edit("orchestrator", "/var/lib/agent-notes/project-notes/x.md", "Write", repo), "ask");
	});

	test("a leading tilde expands to the home folder", () => {
		assert.equal(edit("orchestrator", "~/agent-notes/planner/x.md", "Write", repo), "none");
		assert.equal(edit("orchestrator", "~/agent-notes/orchestrator/j.md", "Write"), "none");
		// Outside both zones the expanded path asks.
		assert.equal(edit("orchestrator", "~/other/x.md", "Write", repo), "ask");
		assert.equal(edit("orchestrator", "~", "Write", repo), "ask");
	});

	test("a cwd of / or of the home folder places no repository path", () => {
		for (const cwd of ["/", userHome]) {
			assert.equal(edit("orchestrator", "src/main.ts", "Write", cwd), "ask", cwd);
			assert.equal(edit("orchestrator", path.join(cwd, "src/main.ts"), "Write", cwd), "ask", cwd);
		}
		// The notes tree stays writable from the home folder.
		assert.equal(edit("orchestrator", "agent-notes/orchestrator/j.md", "Write", userHome), "none");
		// `/` must not turn a relative notes path into the root tree.
		assert.equal(edit("orchestrator", "agent-notes/x.md", "Write", "/"), "ask");
	});

	test("a cwd that holds the home folder places no repository path", () => {
		const homeParent = path.dirname(userHome);
		assert.equal(edit("orchestrator", "src/main.ts", "Write", homeParent), "ask");
		assert.equal(edit("orchestrator", path.join(homeParent, "repo/src/main.ts"), "Write", homeParent), "ask");
		// The home parent holds the notes tree, so a notes path is not free either.
		assert.equal(edit("orchestrator", "agent-notes/x.md", "Write", homeParent), "ask");
	});

	test("a cwd of /tmp places no repository path but writes in the temp zone", () => {
		// These paths write through the temporary zone. A system-wide folder
		// places no repository base, but both zones give the same verdict here,
		// so this test does not separate the two zones.
		assert.equal(edit("orchestrator", "src/main.ts", "Write", "/tmp"), "none");
		assert.equal(edit("orchestrator", "/tmp/repo/src/main.ts", "Write", "/tmp"), "none");
		assert.equal(edit("orchestrator", "agent-notes/x.md", "Write", "/tmp"), "none");
		// A path that leaves /tmp still asks.
		assert.equal(edit("orchestrator", "../etc/passwd", "Write", "/tmp"), "ask");
		// A system folder other than /tmp gives no zone, so a path under it asks.
		assert.equal(edit("orchestrator", "/etc/repo/x.md", "Write", "/etc"), "ask");
		assert.equal(edit("orchestrator", "/usr/x.md", "Write", "/usr"), "ask");
	});

	test("an empty path with a cwd of the temporary folder asks", () => {
		assert.equal(edit("orchestrator", "", "Write", "/tmp"), "ask");
	});

	test("a symlink that leaves the zone asks", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctrine-zone-"));
		try {
			const repoDir = path.join(tmp, "repo");
			fs.mkdirSync(repoDir);
			// The base sits in /tmp, so the link must leave /tmp as well as the
			// repository to leave the zone of the session.
			fs.symlinkSync("/etc", path.join(repoDir, "link"));
			fs.symlinkSync("/etc/new.md", path.join(repoDir, "dangling"));
			// The link sits inside the repository but resolves outside it.
			assert.equal(edit("orchestrator", path.join(repoDir, "link", "x.md"), "Write", repoDir), "ask");
			assert.equal(edit("orchestrator", "link/x.md", "Edit", repoDir), "ask");
			// A link that resolves to a missing path outside the zone still asks.
			assert.equal(edit("orchestrator", "dangling", "Write", repoDir), "ask");
			// A real path in the repository still writes freely.
			assert.equal(edit("orchestrator", path.join(repoDir, "x.md"), "Write", repoDir), "none");
			assert.equal(edit("orchestrator", "x.md", "Edit", repoDir), "none");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("a doubled slash resolves to one path", () => {
		assert.equal(edit("orchestrator", `${repo}//src/main.ts`, "Write", repo), "none");
		assert.equal(edit("orchestrator", "src//main.ts", "Write", repo), "none");
		assert.equal(edit("orchestrator", `${home}//orchestrator/j.md`, "Write", repo), "none");
		assert.equal(edit("orchestrator", "//etc/passwd", "Write", repo), "ask");
	});

	test("the planner and researcher write only their own zone", () => {
		assert.equal(edit("planner", `${home}/project-notes/repo/study.md`, "Edit", repo), "none");
		assert.equal(edit("planner", "agent-notes/project-notes/x.md", "Write", userHome), "none");
		assert.equal(edit("researcher", "agent-notes/researcher/x.md", "Write", userHome), "none");
		assert.equal(edit("planner", `${home}/project-notes/repo/study.md`), "none");
		assert.equal(edit("planner", `${home}/researcher/x.md`), "deny");
		assert.equal(edit("researcher", `${home}/researcher/findings.md`, "Write"), "none");
		assert.equal(edit("researcher", `${repo}/src/main.ts`), "deny");
		assert.equal(edit("researcher", `${repo}/a.ipynb`, "NotebookEdit"), "deny");
	});

	test("the planner stays denied inside the orchestrator zone", () => {
		assert.equal(edit("planner", `${home}/orchestrator/journal.md`, "Write"), "deny");
		assert.equal(edit("planner", "~/agent-notes/orchestrator/j.md", "Write", repo), "deny");
		assert.equal(edit("planner", "src/main.ts", "Write", repo), "deny");
		assert.equal(edit("researcher", "/tmp/agent-notes/researcher/x.md", "Write", repo), "deny");
	});

	test("the reviewer and the mascot never write", () => {
		for (const profession of ["reviewer", "mascot"]) {
			assert.equal(edit(profession, `${home}/project-notes/x.md`), "deny", profession);
			assert.equal(edit(profession, `${repo}/src/main.ts`, "Write"), "deny", profession);
		}
	});

	test("the planner, researcher, reviewer, and mascot deny a temp path", () => {
		for (const profession of ["planner", "researcher", "reviewer", "mascot"]) {
			assert.equal(edit(profession, "/tmp/x.md", "Write", repo), "deny", profession);
			assert.equal(edit(profession, "/tmp/a/b/c.txt", "Edit", repo), "deny", profession);
		}
	});

	test("a zone name inside another path does not count", () => {
		assert.equal(edit("planner", `${repo}/not-agent-notes/project-notes/x.md`), "deny");
		assert.equal(edit("orchestrator", `${userHome}/not-agent-notes/x.md`, "Write", repo), "ask");
	});

	test("the widened orchestrator zone moves no other verdict", () => {
		const expected: Record<string, string> = {
			orchestrator: "none",
			planner: "deny",
			researcher: "deny",
			implementer: "none",
			tester: "none",
			reviewer: "deny",
			mascot: "deny",
		};
		for (const profession of PROFESSIONS) {
			assert.equal(edit(profession, "src/main.ts", "Write", repo), expected[profession], profession);
			assert.equal(edit(profession, `${repo}/src/main.ts`, "Edit", repo), expected[profession], profession);
		}
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

	test("the orchestrator write zone follows the cwd in the hook input", () => {
		const base = { agent_type: "persona-agents:orchestrator", tool_name: "Write" };
		const inside = { ...base, tool_input: { file_path: "src/main.ts" }, cwd: "/home/u/repo" };
		const outside = { ...base, tool_input: { file_path: "/home/u/elsewhere/x.md" }, cwd: "/home/u/repo" };
		assert.equal(run(inside), "");
		const out = JSON.parse(run(outside)) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
	});
});

describe("doctrine: the journal write script", () => {
	/** The script word the plugin installs: this repository tree. */
	const script = path.join(
		repoRoot, "content", "skills", "common", "journal-management-generic", "scripts", "journal-write.sh",
	);
	const home = "/home/u";
	const block = `${home}/agent-notes/orchestrator/journals/incoming/1.md`;
	const append = `bash ${script} append --agent orchestrator --section persona-agents --block ${block}`;
	const reason = (profession: string, command: string): string =>
		decide({ agent_type: `persona-agents:${profession}`, tool_name: "Bash", tool_input: { command } })?.reason ?? "";

	test("J1 an append from the installed skill path is allowed", () => {
		assert.equal(bash("orchestrator", append), "allow");
		assert.match(reason("orchestrator", append), /journal write script runs without a prompt/);
	});

	test("J2 check and replace are allowed", () => {
		const check = `bash ${script} check --agent orchestrator --level weekly --name 2026-W43 --show`;
		const replace = `bash ${script} replace --agent orchestrator --level weekly --name 2026-W43 --block ${block} --expect new`;
		assert.equal(bash("orchestrator", check), "allow");
		assert.equal(bash("orchestrator", replace), "allow");
	});

	test("J3 the hook process prints an allow", () => {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", doctrineScript], {
			input: JSON.stringify({ agent_type: "persona-agents:orchestrator", tool_name: "Bash", tool_input: { command: append } }),
			env: { ...process.env, CLAUDE_PLUGIN_ROOT: repoRoot },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const out = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
		assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
		assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
	});

	test("J4 another path, a copy, a symlink, a relative word, and a bad subcommand get no allow", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "journal-script-"));
		try {
			const copyDir = path.join(tmp, "content", "skills", "common", "journal-management-generic", "scripts");
			fs.mkdirSync(copyDir, { recursive: true });
			fs.copyFileSync(script, path.join(copyDir, "journal-write.sh"));
			const alias = path.join(tmp, "journal-write.sh");
			fs.symlinkSync(script, alias);
			const refused = [
				"bash /tmp/journal-write.sh append",
				`bash ${path.join(copyDir, "journal-write.sh")} append`,
				`bash ${alias} append`,
				`bash ${path.join(repoRoot, "install.sh")} append`,
				"bash content/skills/common/journal-management-generic/scripts/journal-write.sh append",
				`bash ${script}`,
				`bash ${script} --help`,
				`bash ${script} status`,
			];
			for (const command of refused) assert.equal(bash("orchestrator", command), "none", command);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("J5 a missing flag value is left to the script", () => {
		assert.equal(bash("orchestrator", `bash ${script} append --agent`), "allow");
	});

	test("J6 a second segment cancels the allow", () => {
		const cancelled = [
			`bash ${script} append --block x; rm -rf y`,
			`bash ${script} append --block x && git status`,
			`bash ${script} append --block x | tee log`,
			`bash ${script} append --block x $(date)`,
			// A newline, a backtick, a process substitution, and a heredoc each lose the allow.
			`bash ${script} append --block x\nrm -rf y`,
			`bash ${script} append --block x \`date\``,
			`bash ${script} append --block x <(date)`,
			`bash ${script} append --block x <<'EOF'\nhello\nEOF`,
			`cd /repo && ${append}`,
		];
		for (const command of cancelled) assert.equal(bash("orchestrator", command), "none", command);
	});

	test("J7 the other six professions stay ungated", () => {
		for (const profession of PROFESSIONS.filter((p) => p !== "orchestrator")) {
			assert.equal(bash(profession, append), "none", profession);
		}
	});

	test("J8 no wrapper and no redirect is ever allowed", () => {
		const wrapped = [
			`bash -c '${append}'`,
			`sudo ${append}`,
			`env ${append}`,
			`/tmp/bash ${script} append --agent orchestrator --block x`,
			`bash ${script} append --block x > /tmp/out`,
		];
		for (const command of wrapped) assert.notEqual(bash("orchestrator", command), "allow", command);
	});

	test("J9 a stronger verdict beats the allow", () => {
		assert.equal(bash("orchestrator", `${append} && git push`), "ask");
	});
});
