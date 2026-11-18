#!/usr/bin/env node
// notes-paths — where the companion's notes live for a working directory.
//
//   <home>/agent-notes/project-notes/<project>/
//
// <project> is the name of the repository that holds the working directory:
// the folder that holds the repository's shared git directory, so every
// worktree of one repository maps to one project. A bare repository uses its
// own folder name without ".git"; a submodule uses its module name. Outside a
// git repository the project is "common".
//
// CLI: node notes-paths.mjs [project|dir] [--cwd=<path>]  (default: dir)

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realHome } from "./plugin-options.mjs";

export const COMMON_PROJECT = "common";

/** The absolute shared git directory of `cwd`, or "" outside a repository. */
export function gitCommonDir(cwd) {
	const run = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	});
	return run.status === 0 ? run.stdout.trim() : "";
}

/** The project name for a shared git directory path; "common" for "". */
export function projectFromCommonDir(commonDir) {
	if (!commonDir) return COMMON_PROJECT;
	const modules = `${sep}.git${sep}modules${sep}`;
	if (commonDir.includes(modules)) return basename(commonDir);
	if (basename(commonDir) === ".git") return basename(dirname(commonDir));
	return basename(commonDir).replace(/\.git$/, "") || COMMON_PROJECT;
}

/** The project name for a working directory. */
export function projectName(cwd) {
	return projectFromCommonDir(gitCommonDir(cwd));
}

/** The agent-notes root under the owner's home folder. */
export function notesRoot(home = realHome() || homedir()) {
	return join(home, "agent-notes");
}

/** The project notes folder for a working directory. */
export function projectDir(cwd, home) {
	return join(notesRoot(home), "project-notes", projectName(cwd));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const cwdArg = process.argv.find((arg) => arg.startsWith("--cwd="));
	const cwd = cwdArg ? cwdArg.slice("--cwd=".length) : process.cwd();
	const what = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "dir";
	process.stdout.write(`${what === "project" ? projectName(cwd) : projectDir(cwd)}\n`);
}
