/**
 * Read the change a commit would record from git output, for every adapter.
 *
 * Each adapter runs git its own way (Pi through `pi.exec`, Kiro through
 * `spawnSync`), but the arguments and the parsing live here, so a git option
 * the change count depends on cannot be present in one adapter and missing in
 * another.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { failedChange, makeChange, untrackedFiles, type Change } from "./review.ts";

/** Global options for every change read: keep non-ASCII paths readable. */
export const GIT_OPTIONS = ["-c", "core.quotePath=false"];
/** `-uall` lists each file of an untracked directory, not just the folder. */
export const STATUS_ARGS = ["status", "--porcelain", "-uall"];
/**
 * `--no-color` beats `color.ui=always`: an escape code before each `+` or `-`
 * would make every changed line uncounted, so a large change would look
 * trivial to the commit gate.
 */
export const DIFF_ARGS = ["diff", "HEAD", "--no-color"];
/** A clean tree commits nothing, so the last commit is read instead. */
export const SHOW_ARGS = ["show", "HEAD", "--format=", "--no-color"];

/** Files over this size are measured, not read. */
const READ_CAP = 1024 * 1024;

/** The output of one git call. */
export interface GitOutput {
	/** The exit code; null when git did not exit normally. */
	code: number | null;
	stdout: string;
}

/** True when neither the diff nor the status shows a change. */
export function isCleanTree(status: GitOutput, diff: GitOutput): boolean {
	return diff.stdout.trim() === "" && status.stdout.trim() === "";
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
				// Git tracks only the executable bit, so the key does too.
				const stat = statSync(join(cwd, path));
				const mode = stat.mode & 0o111 ? "exec" : "file";
				if (stat.size > READ_CAP) return `${path}:${mode}:${stat.size}:${stat.mtimeMs}`;
				const content = createHash("sha256").update(readFileSync(join(cwd, path))).digest("hex");
				return `${path}:${mode}:${content}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("\n");
}

/**
 * The text of each untracked file. An untracked file is not in the diff, but
 * its lines still count toward the trivial-change limit; a file over the cap
 * stands in as one line per KiB, so a huge artifact cannot stall the hook.
 */
function untrackedTexts(cwd: string, statusText: string): string[] {
	return untrackedFiles(statusText).map((path) => {
		try {
			const size = statSync(join(cwd, path)).size;
			if (size > READ_CAP) return "\n".repeat(Math.ceil(size / 1024));
			return readFileSync(join(cwd, path), "utf8");
		} catch {
			return "";
		}
	});
}

/** The change from the status and diff output; a failed git call is never trivial. */
export function changeFromGit(cwd: string, status: GitOutput, diff: GitOutput): Change {
	if (status.code !== 0 || diff.code !== 0) return failedChange();
	const change = makeChange(diff.stdout, status.stdout, "", untrackedTexts(cwd, status.stdout));
	return { ...change, signature: signatureOf(cwd, change.files) };
}
