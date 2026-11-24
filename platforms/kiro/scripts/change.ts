/**
 * The change a commit would record, read from git.
 *
 * The commit gate and the review brief must name the same change, so both use
 * this reader and the shared `reviewKey`. The git arguments and the parsing
 * live in `shared/review/change.ts`, which the Pi adapter uses too.
 */

import { spawnSync } from "node:child_process";
import { reviewKey, type Change } from "../../shared/review/review.ts";
import { changeFromGit, DIFF_ARGS, GIT_OPTIONS, isCleanTree, SHOW_ARGS, STATUS_ARGS } from "../../shared/review/change.ts";

/** The output of one git call. */
export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Run git in a folder; a missing git binary is a failed call, not an exception. */
export function git(cwd: string, args: string[]): GitResult {
	const run = spawnSync("git", ["-C", cwd, ...GIT_OPTIONS, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function output(result: GitResult): { code: number; stdout: string } {
	return { code: result.status, stdout: result.stdout };
}

/** The change a commit would record: the diff, the untracked paths, and their signature. */
export function readChange(cwd: string): Change {
	const status = output(git(cwd, STATUS_ARGS));
	let diff = output(git(cwd, DIFF_ARGS));
	if (isCleanTree(status, diff)) diff = output(git(cwd, SHOW_ARGS));
	return changeFromGit(cwd, status, diff);
}

/** The change and its key. */
export function changeKey(cwd: string): { change: Change; key: string } {
	const change = readChange(cwd);
	return { change, key: reviewKey(change) };
}
