/**
 * Git workspace reader — impure.
 *
 * Runs the three git commands behind the WORKSPACE panel and folds their output
 * into the row list the snapshot carries. This module holds no state and no
 * timers. A failed command gives an unavailable read, never a throw.
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { WorkspaceFileSnapshot } from "./sidebar-types.ts";

/** Git command timeout. Every git read uses this one value. */
export const GIT_TIMEOUT_MS = 2000;
/** Changed names kept in the snapshot. This is the only changed-name cap. */
const CHANGED_SHOWN = 4;
/** Per-file diff rows kept in the snapshot. Bounds the cross-timer payload. */
const WORKSPACE_FILES_CAP = 50;
/** The degraded marker a failed read paints in the changed list. */
const GIT_UNAVAILABLE = "(git unavailable)";

/** Run one git command. This is `pi.exec`, or a stand-in with the same shape. */
export type GitExec = (
	command: string,
	args: string[],
	options: ExecOptions,
) => Promise<ExecResult>;

/** One git read in the shape the WORKSPACE panel needs. */
export interface GitWorkspaceRead {
	/**
	 * The new branch name, or `undefined` when the read gave no name. An
	 * `undefined` name keeps the last one, so the panel does not flicker.
	 */
	branch?: string | null;
	changed: string[];
	changedCount: number;
	files: WorkspaceFileSnapshot[];
}

/** One row parsed from `git status --porcelain`. */
interface StatusFile {
	path: string;
	untracked: boolean;
}

/** One row parsed from `git diff --numstat HEAD`. */
interface DiffStat {
	path: string;
	added: number;
	removed: number;
}

/**
 * Parse `git status --porcelain` v1. The first two columns hold the status;
 * a rename uses the destination path. A short or empty line is skipped.
 */
function parsePorcelain(output: string): StatusFile[] {
	const files: StatusFile[] = [];
	for (const line of output.split("\n")) {
		if (line.length < 4) continue;
		const status = line.slice(0, 2);
		let path = line.slice(3);
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		if (path.length === 0) continue;
		files.push({ path, untracked: status === "??" });
	}
	return files;
}

/** Resolve a numstat rename path (`old => new` or `dir/{old => new}.ts`). */
function normalizeNumstatPath(rawPath: string): string {
	const path = rawPath.trim();
	const braced = path.match(/^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/);
	if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
	const arrow = path.lastIndexOf(" => ");
	if (arrow >= 0) return path.slice(arrow + 4).trim();
	return path;
}

/** Parse `git diff --numstat`. A binary row (`-`) counts as zero lines. */
function parseNumstat(output: string): Map<string, DiffStat> {
	const stats = new Map<string, DiffStat>();
	for (const line of output.split("\n")) {
		if (line.trim().length === 0) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
		const removed = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
		const path = normalizeNumstatPath(parts.slice(2).join("\t"));
		if (path.length === 0) continue;
		stats.set(path, {
			path,
			added: Number.isFinite(added) ? added : 0,
			removed: Number.isFinite(removed) ? removed : 0,
		});
	}
	return stats;
}

/**
 * Merge the status rows with the numstat rows. A status row keeps its order and
 * its untracked flag; numstat supplies added/removed lines. A numstat-only path
 * is tracked. An untracked file has no numstat row, so it stays added/removed 0.
 */
function combineWorkspaceFiles(
	statusFiles: StatusFile[],
	diffByPath: Map<string, DiffStat>,
): WorkspaceFileSnapshot[] {
	const files: WorkspaceFileSnapshot[] = [];
	const seen = new Set<string>();
	for (const status of statusFiles) {
		if (seen.has(status.path)) continue;
		seen.add(status.path);
		const diff = diffByPath.get(status.path);
		files.push({
			path: status.path,
			added: diff?.added ?? 0,
			removed: diff?.removed ?? 0,
			untracked: status.untracked,
		});
	}
	for (const [path, diff] of diffByPath) {
		if (seen.has(path)) continue;
		seen.add(path);
		files.push({ path, added: diff.added, removed: diff.removed, untracked: false });
	}
	return files;
}

/** A read that paints the degraded marker. Git gave no usable answer. */
export function unavailableGitWorkspace(branch?: string | null): GitWorkspaceRead {
	return { branch, changed: [GIT_UNAVAILABLE], changedCount: 1, files: [] };
}

/**
 * Read the branch, the changed list, and the file stats for one directory.
 *
 * The branch name is `undefined` when its own command failed, so the caller can
 * keep the last name. A failed status read marks the panel unavailable. This
 * function never throws.
 */
export async function readGitWorkspace(
	exec: GitExec,
	cwd: string,
	timeoutMs: number,
): Promise<GitWorkspaceRead> {
	// Held outside the try block so a late throw still carries a read name.
	let branchName: string | null | undefined;
	try {
		const [status, numstat, branch] = await Promise.all([
			exec("git", ["status", "--porcelain"], { cwd, timeout: timeoutMs }),
			exec("git", ["diff", "--numstat", "HEAD"], { cwd, timeout: timeoutMs }),
			exec("git", ["branch", "--show-current"], { cwd, timeout: timeoutMs }),
		]);
		// A failed branch read keeps the last name, so the panel does not flicker.
		if (branch && branch.code === 0) {
			const name = String(branch.stdout ?? "").trim();
			branchName = name.length > 0 ? name : null;
		}
		if (!status || status.code !== 0) return unavailableGitWorkspace(branchName);
		// A numstat failure (for example a repo with no HEAD) still leaves the
		// status list intact; only the per-file line counts are missing.
		const statusFiles = parsePorcelain(String(status.stdout ?? ""));
		const diffByPath =
			numstat && numstat.code === 0
				? parseNumstat(String(numstat.stdout ?? ""))
				: new Map<string, DiffStat>();
		const files = combineWorkspaceFiles(statusFiles, diffByPath);
		return {
			branch: branchName,
			changedCount: files.length,
			changed: files.slice(0, CHANGED_SHOWN).map((file) => file.path),
			files: files.slice(0, WORKSPACE_FILES_CAP),
		};
	} catch {
		return unavailableGitWorkspace(branchName);
	}
}
