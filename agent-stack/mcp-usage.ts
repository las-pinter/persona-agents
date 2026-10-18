/**
 * MCP usage counting — pure helpers.
 *
 * The root process counts its own MCP tool starts. Each subagent reports its
 * cumulative per-server map through the shared tree log, and the root folds
 * the deltas into one session-wide tally. No fs, no timers, no pi import.
 */

/**
 * The server name in an `mcp__<server>__<tool>` name, or null.
 * pi sanitizes non `[A-Za-z0-9_]` characters in a tool name to `_`.
 */
export function parseMcpServerName(toolName: unknown): string | null {
	if (typeof toolName !== "string") return null;
	const match = /^mcp__(.+?)__/.exec(toolName);
	return match ? match[1] : null;
}

/** Add one to a server's count. Returns a new record; never mutates the input. */
export function incrementMcpCount(
	counts: Record<string, number>,
	server: string,
): Record<string, number> {
	return { ...counts, [server]: (counts[server] ?? 0) + 1 };
}

/**
 * Count one tool start. A non-MCP name returns the input record unchanged, so
 * the caller can skip a repaint.
 */
export function countMcpTool(counts: Record<string, number>, toolName: unknown): Record<string, number> {
	const server = parseMcpServerName(toolName);
	if (server === null) return counts;
	return incrementMcpCount(counts, server);
}

/** Add two per-server maps. Returns a new record; never mutates the input. */
export function mergeMcpUsage(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const merged: Record<string, number> = { ...a };
	for (const [server, count] of Object.entries(b)) {
		if (typeof count !== "number" || !Number.isFinite(count)) continue;
		merged[server] = (merged[server] ?? 0) + count;
	}
	return merged;
}

/**
 * The count for one server. A raw name is tried first, then the sanitized
 * form, so `my-server` and `my_server` resolve to the same counter.
 */
export function lookupMcpCount(counts: Record<string, number>, serverName: string): number {
	const direct = counts[serverName];
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	const normalized = serverName.replace(/[^A-Za-z0-9_]/g, "_");
	const value = counts[normalized];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum every server count. */
export function totalMcpCount(counts: Record<string, number>): number {
	let total = 0;
	for (const value of Object.values(counts)) {
		if (typeof value === "number" && Number.isFinite(value)) total += value;
	}
	return total;
}

/** Stateful tracker for one child run: MCP counts and the deduped tool total. */
export interface SubagentMcpCounter {
	/** Count one parsed child event. Returns true when a count changed. */
	count(event: unknown): boolean;
	/** The cumulative per-server map for the run. */
	usage(): Record<string, number>;
	/** The number of distinct tool calls the run started. */
	toolCount(): number;
}

/**
 * Make a counter for one child run. A repeated `toolCallId` is ignored, so a
 * duplicate start line never counts the same call twice.
 */
export function createSubagentMcpCounter(): SubagentMcpCounter {
	const counts: Record<string, number> = {};
	const seenCallIds = new Set<string>();
	return {
		count(event: unknown): boolean {
			if (typeof event !== "object" || event === null) return false;
			const record = event as { type?: unknown; toolName?: unknown; toolCallId?: unknown };
			if (record.type !== "tool_execution_start") return false;
			if (typeof record.toolCallId === "string") {
				if (seenCallIds.has(record.toolCallId)) return false;
				seenCallIds.add(record.toolCallId);
			}
			const server = parseMcpServerName(record.toolName);
			if (server === null) return false;
			counts[server] = (counts[server] ?? 0) + 1;
			return true;
		},
		usage(): Record<string, number> {
			return { ...counts };
		},
		toolCount(): number {
			return seenCallIds.size;
		},
	};
}

/** A session-wide MCP tally that never subtracts a finished run's count. */
export interface McpTally {
	/** Fold one run's cumulative map into the tally, adding only its delta. */
	observe(runId: string, cumulative: Record<string, number> | undefined): void;
	/** The session tally. */
	usage(): Record<string, number>;
	/** Zero the session tally but keep every run already counted. */
	reset(): void;
}

/**
 * Make a session tally. Each run's cumulative count is added once, so a clear
 * that prunes the run from the tree never subtracts its count.
 */
export function createMcpTally(): McpTally {
	let total: Record<string, number> = {};
	const counted = new Map<string, Record<string, number>>();
	return {
		observe(runId: string, cumulative: Record<string, number> | undefined): void {
			if (!cumulative) return;
			const prior = counted.get(runId) ?? {};
			let changed = false;
			for (const [server, value] of Object.entries(cumulative)) {
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				const before = prior[server] ?? 0;
				if (value <= before) continue;
				total[server] = (total[server] ?? 0) + (value - before);
				prior[server] = value;
				changed = true;
			}
			if (changed) counted.set(runId, prior);
		},
		usage(): Record<string, number> {
			return { ...total };
		},
		reset(): void {
			total = {};
		},
	};
}
