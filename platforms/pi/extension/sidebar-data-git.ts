/**
 * Sidebar data: the workspace fields and the git poll.
 *
 * One interval drives every git read. A failed read paints the unavailable
 * marker; it never throws.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InternalState } from "./sidebar-data.ts";
import { guardAsync } from "./sidebar-data-guard.ts";
import {
	GIT_TIMEOUT_MS,
	readGitWorkspace,
	unavailableGitWorkspace,
	type GitExec,
	type GitWorkspaceRead,
} from "./git-workspace.ts";

/** Git poll cadence. One interval drives every git read. */
export const GIT_POLL_MS = 2000;

/** Push the current git branch, changed list, and file stats into the workspace. */
export function applyWorkspace(state: InternalState): void {
	state.snapshot.workspace = {
		cwd: state.snapshot.workspace.cwd,
		branch: state.branch,
		changed: state.changed.slice(),
		changedCount: state.changedCount,
		files: state.files.slice(),
	};
}

/** Run one git command through pi, or `undefined` when pi has no exec. */
function gitExec(pi: ExtensionAPI): GitExec | undefined {
	if (typeof pi.exec !== "function") return undefined;
	return (command, args, options) => pi.exec(command, args, options);
}

/** Poll git for the workspace panel. A failure marks it unavailable. */
export async function refreshGit(state: InternalState, pi: ExtensionAPI): Promise<void> {
	const myGeneration = state.generation;
	const cwd = state.snapshot.workspace.cwd || state.snapshot.cwd;
	if (!cwd) return;
	const exec = gitExec(pi);
	// A pi without exec paints the marker now, not one microtask later.
	if (!exec) {
		applyGitRead(state, unavailableGitWorkspace());
		return;
	}
	const read = await readGitWorkspace(exec, cwd, GIT_TIMEOUT_MS);
	// dispose() bumps the generation; drop a stale write after the await.
	if (myGeneration !== state.generation) return;
	applyGitRead(state, read);
}

/** Copy one git read into the workspace fields, then repaint the panel. */
function applyGitRead(state: InternalState, read: GitWorkspaceRead): void {
	// An `undefined` name keeps the last one, so the panel does not flicker.
	if (read.branch !== undefined) state.branch = read.branch;
	state.changed = read.changed;
	state.changedCount = read.changedCount;
	state.files = read.files;
	applyWorkspace(state);
}

/** Start the git poll. `teardown` clears the timer. */
export function startGitPoll(state: InternalState, pi: ExtensionAPI): void {
	state.timers.push(setInterval(() => guardAsync(() => refreshGit(state, pi)), GIT_POLL_MS));
}
