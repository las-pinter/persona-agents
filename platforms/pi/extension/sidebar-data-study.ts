/**
 * Sidebar data: the STUDY STATUS rows.
 *
 * One poll reads the current project's studies and paints the list.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { InternalState } from "./sidebar-data.ts";
import { guard } from "./sidebar-data-guard.ts";
import { isSafeName, readStudies } from "./sidebar-sources.ts";
import type { StatusSnapshot } from "./sidebar-types.ts";
import { visibleStudies } from "./study-status.ts";

/** Study status poll cadence. */
export const STUDY_POLL_MS = 5000;

/** A fully defined STUDY STATUS snapshot before the first read. */
export function emptyStatus(): StatusSnapshot {
	return { studies: [] };
}

/**
 * Read the current project's studies and write the STUDY STATUS list. A closed
 * study keeps its row for the life of the process, and a restart drops it. A
 * missing tree paints the empty list.
 */
export function refreshStudy(state: InternalState): void {
	const cwd = state.snapshot.cwd || state.snapshot.workspace.cwd;
	const project = cwd ? basename(cwd) : "";
	const rows =
		project && isSafeName(project)
			? readStudies(join(homedir(), "agent-notes", "project-notes", project, "studies"))
			: [];
	state.snapshot.status = {
		...(state.snapshot.status ?? emptyStatus()),
		studies: visibleStudies(rows, state.seenStudies),
	};
}

/** Start the study poll. `teardown` clears the timer. */
export function startStudyPoll(state: InternalState): void {
	state.timers.push(setInterval(() => guard(() => refreshStudy(state)), STUDY_POLL_MS));
}
