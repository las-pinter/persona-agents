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
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeChange, reviewKey, untrackedFiles, failedChange, type Change } from "../../shared/review/review.ts";

/** The output of one git call. */
export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Run git in a folder; a missing git binary is a failed call, not an exception. */
export function git(cwd: string, args: string[]): GitResult {
	const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/**
 * The worktree fingerprint: a content hash and the mode per changed file, in
 * path order.
 *
 * It hashes every changed file, tracked or not, and ignores the index, so the
 * same review key covers a change before and after `git add`. The mode is part
 * of the hash, so a `chmod` after a review changes the key.
 */
export function signatureOf(cwd: string, files: string[]): string {
	return [...files]
		.sort()
		.map((path) => {
			try {
				// Git tracks only the executable bit, so the key does too. A file
				// over the cap is measured by size and mtime, not read whole.
				const stat = statSync(join(cwd, path));
				const mode = stat.mode & 0o111 ? "exec" : "file";
				if (stat.size > 1024 * 1024) return `${path}:${mode}:${stat.size}:${stat.mtimeMs}`;
				const content = createHash("sha256").update(readFileSync(join(cwd, path))).digest("hex");
				return `${path}:${mode}:${content}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("\n");
}

/** The change a commit would record: the diff, the untracked paths, and their signature. */
export function readChange(cwd: string): Change {
	// `-uall` lists each file of an untracked directory, not just the folder.
	const status = git(cwd, ["status", "--porcelain", "-uall"]);
	let diff = git(cwd, ["diff", "HEAD", "--no-color"]);
	if (diff.stdout.trim() === "" && status.stdout.trim() === "") diff = git(cwd, ["show", "HEAD", "--format=", "--no-color"]);
	// A failed read is not a small change; the gate must ask.
	if (status.status !== 0 || diff.status !== 0) return failedChange();
	// An untracked file is not in the diff; its lines still count toward the
	// trivial-change limit. A file over the cap is measured by size, not read,
	// so a huge artifact cannot stall the hook.
	const untrackedTexts = untrackedFiles(status.stdout).map((path) => {
		try {
			const size = statSync(join(cwd, path)).size;
			if (size > 1024 * 1024) return "\n".repeat(Math.ceil(size / 1024));
			return readFileSync(join(cwd, path), "utf8");
		} catch {
			return "";
		}
	});
	const change = makeChange(diff.stdout, status.stdout, "", untrackedTexts);
	return { ...change, signature: signatureOf(cwd, change.files) };
}

/** The change and its key. */
export function changeKey(cwd: string): { change: Change; key: string } {
	const change = readChange(cwd);
	return { change, key: reviewKey(change) };
}
