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
// The project naming lives in platforms/shared/notes/notes-paths.ts; this
// file adds the owner's real home folder and the CLI.
//
// CLI: node --experimental-strip-types notes-paths.mjs [project|dir] [--cwd=<path>]  (default: dir)

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectName } from "../../shared/notes/notes-paths.ts";
import { realHome } from "./plugin-options.mjs";

export { COMMON_PROJECT, gitCommonDir, projectFromCommonDir, projectName } from "../../shared/notes/notes-paths.ts";

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
