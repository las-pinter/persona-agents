/**
 * Subagent tree events.
 *
 * Writes each child run's start, update, and end records to the shared tree
 * log with byte-safe text caps.
 */

import { ENV_TREE_LOG } from "./depth.ts";
import type { SubagentMcpCounter } from "./mcp-usage.ts";
import { type RunEvent, appendEvent } from "./tree-log.ts";

/** Tree-event text caps. The log writer also enforces a hard 4 KiB line cap. */
export const TREE_TASK_PREVIEW_BYTES = 1000;
export const TREE_OUTPUT_PREVIEW_BYTES = 2048;
/** One `update` event per run per second. */
export const TREE_UPDATE_INTERVAL_MS = 1000;

/** Byte-safe UTF-8 truncation for tree-event text fields. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let truncated = value.slice(0, maxBytes);
	while (truncated.length > 0 && Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return truncated;
}

/** Append one tree event when the shared log is enabled. Best-effort. */
export function appendTreeEvent(event: RunEvent, mcp?: SubagentMcpCounter): void {
	const logPath = process.env[ENV_TREE_LOG];
	if (!logPath) return;
	appendEvent(logPath, mcp ? { ...event, mcpUsage: mcp.usage() } : event);
}
