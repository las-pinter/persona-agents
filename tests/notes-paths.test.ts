/**
 * Checks notes-paths.mjs: the project name for a working directory, and the
 * project notes folder.
 *
 * Run: node --experimental-strip-types --test tests/notes-paths.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMMON_PROJECT,
	projectDir,
	projectFromCommonDir,
	projectName,
} from "../platforms/claude/scripts/notes-paths.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms", "claude", "scripts", "notes-paths.mjs");

function git(cwd: string, ...args: string[]): void {
	const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
}

function withTmp(fn: (tmp: string) => void): void {
	// realpath: macOS tmp dirs are symlinks, and git reports the real path.
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-notes-")));
	try {
		fn(tmp);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

describe("notes-paths: project name", () => {
	test("two worktrees of one repository give one project, the repository folder name", () => {
		withTmp((tmp) => {
			const repo = path.join(tmp, "my-repo");
			fs.mkdirSync(repo);
			git(repo, "init", "-q");
			git(repo, "commit", "-q", "--allow-empty", "-m", "init");
			const worktree = path.join(tmp, "elsewhere", "feature-x");
			git(repo, "worktree", "add", "-q", "-b", "x", worktree);
			fs.mkdirSync(path.join(worktree, "sub"));
			assert.equal(projectName(repo), "my-repo");
			assert.equal(projectName(worktree), "my-repo");
			assert.equal(projectName(path.join(worktree, "sub")), "my-repo");
		});
	});

	test("a folder outside any repository is the common project", () => {
		withTmp((tmp) => {
			assert.equal(projectName(tmp), COMMON_PROJECT);
			assert.equal(COMMON_PROJECT, "common");
		});
	});

	test("a missing folder is the common project, not an error", () => {
		assert.equal(projectName(path.join(os.tmpdir(), "persona-agents-no-such-dir-x")), COMMON_PROJECT);
	});

	test("a bare repository drops the .git suffix; a submodule uses its module name", () => {
		assert.equal(projectFromCommonDir("/srv/git/tools.git"), "tools");
		assert.equal(projectFromCommonDir("/home/u/app/.git/modules/lib-core"), "lib-core");
		assert.equal(projectFromCommonDir("/home/u/app/.git"), "app");
		assert.equal(projectFromCommonDir(""), COMMON_PROJECT);
	});
});

describe("notes-paths: project folder", () => {
	test("the folder is <home>/agent-notes/project-notes/<project>", () => {
		withTmp((tmp) => {
			assert.equal(projectDir(tmp, "/h"), path.join("/h", "agent-notes", "project-notes", COMMON_PROJECT));
		});
	});

	test("the CLI prints the project and the folder for --cwd", () => {
		withTmp((tmp) => {
			const repo = path.join(tmp, "cli-repo");
			fs.mkdirSync(repo);
			git(repo, "init", "-q");
			const run = (what: string) =>
				spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, what, `--cwd=${repo}`], { encoding: "utf8" }).stdout.trim();
			assert.equal(run("project"), "cli-repo");
			assert.match(run("dir"), /agent-notes[\\/]project-notes[\\/]cli-repo$/);
		});
	});
});
