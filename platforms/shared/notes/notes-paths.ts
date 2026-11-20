/**
 * Project notes paths for the adapters.
 *
 *   <home>/agent-notes/project-notes/<project>/
 *
 * <project> is the name of the folder that holds the repository's shared git
 * directory, so every worktree of one repository maps to one project folder.
 * A bare repository uses its own folder name without ".git"; a submodule uses
 * its module name. Outside a git repository the project is "common".
 *
 * The same layout as the Claude adapter, so notes and journals written by one
 * harness are read by the other.
 */

import { spawnSync } from "node:child_process";
import { basename, dirname, join, sep } from "node:path";

export const COMMON_PROJECT = "common";

/** The absolute shared git directory of `cwd`, or "" outside a repository. */
export function gitCommonDir(cwd: string): string {
	const run = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	});
	return run.status === 0 ? run.stdout.trim() : "";
}

/** The project name for a shared git directory path; "common" for "". */
export function projectFromCommonDir(commonDir: string): string {
	if (!commonDir) return COMMON_PROJECT;
	const modules = `${sep}.git${sep}modules${sep}`;
	if (commonDir.includes(modules)) return basename(commonDir);
	if (basename(commonDir) === ".git") return basename(dirname(commonDir));
	return basename(commonDir).replace(/\.git$/, "") || COMMON_PROJECT;
}

/** The project name for a working directory. */
export function projectName(cwd: string): string {
	return projectFromCommonDir(gitCommonDir(cwd));
}

/** The project notes folder for a working directory and a home folder. */
export function projectDir(cwd: string, home: string): string {
	return join(home, "agent-notes", "project-notes", projectName(cwd));
}
