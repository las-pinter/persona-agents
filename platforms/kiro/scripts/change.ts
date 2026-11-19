/**
 * The change a commit would record, read from git.
 *
 * The commit gate and the review brief must name the same change, so both use
 * this reader and the shared `reviewKey`. On a clean tree there is no
 * uncommitted diff; the last commit is read instead, which is what the Pi
 * adapter also does.
 *
 * The untracked-file signature is size and mtime: an edit to an untracked file
 * after its review changes the key, so the review stops covering it.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { makeChange, reviewKey, type Change } from "../../shared/review/review.ts";

/** The output of one git call. */
export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Run git in a folder; a missing git binary is a failed call, not an exception. */
export function git(cwd: string, args: string[]): GitResult {
	const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** The untracked-file signature: path, size, and mtime. */
export function signatureOf(cwd: string, untracked: string[]): string {
	return untracked
		.map((path) => {
			try {
				const stat = statSync(join(cwd, path));
				return `${path}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("\n");
}

/** The change a commit would record: the diff, the untracked paths, and their signature. */
export function readChange(cwd: string): Change {
	const status = git(cwd, ["status", "--porcelain"]);
	let diff = git(cwd, ["diff", "HEAD", "--no-color"]);
	if (diff.stdout.trim() === "") diff = git(cwd, ["show", "HEAD", "--format=", "--no-color"]);
	const change = makeChange(diff.stdout, status.stdout);
	return { ...change, signature: signatureOf(cwd, change.untracked) };
}

/** The change and its key. */
export function changeKey(cwd: string): { change: Change; key: string } {
	const change = readChange(cwd);
	return { change, key: reviewKey(change) };
}
