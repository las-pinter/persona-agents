/**
 * Sidebar data: the tree rows and the ask-log ring.
 *
 * Both come from one read of the shared tree log, so one poll refreshes both.
 */

import { pendingLogEvents } from "./ask-record.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import type { InternalState } from "./sidebar-data.ts";
import { guard } from "./sidebar-data-guard.ts";
import { applyMcpUsage, observeMcpUsage } from "./sidebar-data-mcp.ts";
import { readEvents, type RunEvent } from "./tree-log.ts";
import { assembleTree } from "./tree-model.ts";

/** Tree-log poll cadence. */
export const TREE_POLL_MS = 500;

/** A running node with no log record for this long is stale. */
const STALE_MS = 5 * 60 * 1000;

/**
 * Rebuild the ring from the held lines and the log tail, newest first. A line
 * written before the log path existed is held in the writer, so it folds here
 * and paints with the first frame of the panel.
 */
function applyAskLog(state: InternalState, events: RunEvent[]): void {
	state.askLog.reset();
	for (const event of pendingLogEvents()) state.askLog.observe(event);
	for (const event of events) state.askLog.observe(event);
	state.snapshot.askLog = state.askLog.rows().reverse();
}

/** Read the shared tree log into the snapshot. */
export function refreshTree(state: InternalState): void {
	const logPath = process.env[ENV_TREE_LOG];
	if (!logPath) {
		state.snapshot.tree = [];
		applyAskLog(state, []);
		applyMcpUsage(state);
		return;
	}
	// readEvents keeps each run's start and end record and the newest clear,
	// so an old root start keeps its children attached through this refresh.
	const events = readEvents(logPath);
	state.snapshot.tree = assembleTree(events, Date.now(), STALE_MS);
	observeMcpUsage(state, events);
	// This read returns the whole kept tail, so the ring is rebuilt not appended.
	applyAskLog(state, events);
}

/** Start the tree poll. `teardown` clears the timer. */
export function startTreePoll(state: InternalState): void {
	state.timers.push(setInterval(() => guard(() => refreshTree(state)), TREE_POLL_MS));
}
