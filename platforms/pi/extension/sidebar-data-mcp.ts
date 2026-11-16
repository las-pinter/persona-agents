/**
 * Sidebar data: the MCP server list and the per-server call count.
 *
 * One `mcp.json` read per refresh serves the list. The count folds the root
 * process count with the session tally from the shared tree log.
 */

import type { ExtensionAPI, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { ENV_TREE_LOG } from "./depth.ts";
import { countMcpTool, mergeMcpUsage } from "./mcp-usage.ts";
import type { InternalState } from "./sidebar-data.ts";
import { guard } from "./sidebar-data-guard.ts";
import { readMcpJsonServers } from "./sidebar-sources.ts";
import type { McpServerSnapshot, McpServerStatus } from "./sidebar-types.ts";
import { readEvents } from "./tree-log.ts";

/** MCP poll cadence. */
export const MCP_POLL_MS = 5000;

/** A raw MCP record. `status` may be absent when only the legacy flag is set. */
interface McpServerInput {
	name: string;
	configured?: boolean;
	connected?: boolean;
	status?: McpServerStatus;
}

/**
 * Resolve one MCP record to one truth: `status`. The legacy `connected` flag is
 * read here only, so a record that carries it alone still gets a status.
 */
export function normalizeMcpStatus(server: McpServerInput): McpServerSnapshot {
	const status: McpServerStatus = server.status ?? (server.connected === true ? "connected" : "disconnected");
	return {
		name: server.name,
		configured: server.configured === true,
		connected: status === "connected",
		status,
	};
}

/** Rebuild the MCP usage map from the root count plus the session tally. */
export function applyMcpUsage(state: InternalState): void {
	state.snapshot.mcpUsage = mergeMcpUsage(state.rootMcpUsage, state.mcpTally.usage());
}

/** Adopt the current log as already counted, then zero the session tally. */
export function resetMcpUsage(state: InternalState): void {
	const logPath = process.env[ENV_TREE_LOG];
	if (logPath) {
		for (const event of readEvents(logPath)) state.mcpTally.observe(event.runId, event.mcpUsage);
	}
	state.mcpTally.reset();
	state.rootMcpUsage = {};
	state.rootCallIds.clear();
	applyMcpUsage(state);
}

/** Read `mcp.json` once per refresh, then paint the MCP list from it. */
export function refreshMcpFromDisk(state: InternalState, pi: ExtensionAPI): void {
	// A new server must appear without a reload, so the read is per refresh.
	refreshMcp(state, pi, readMcpJsonServers(state.mcpJsonPath));
}

/** Refresh the MCP list from one parsed `mcp.json` read and pi's servers. */
function refreshMcp(state: InternalState, pi: ExtensionAPI, jsonServers: string[]): void {
	const configured = new Set<string>(jsonServers);
	try {
		if (typeof pi.getMcpServers === "function") {
			for (const server of pi.getMcpServers() ?? []) {
				if (server && typeof server.name === "string") configured.add(server.name);
			}
		}
	} catch {
		/* keep the configured set from mcp.json */
	}

	const connected = new Set<string>();
	// True only when the MCP tool list was read successfully. A missing or
	// throwing `getAllTools` leaves this false, so a configured server becomes
	// `unknown` instead of a false `disconnected`.
	let toolsReadable = false;
	try {
		if (typeof pi.getAllTools === "function") {
			const tools = pi.getAllTools();
			// Only an array carries tool entries. A bare string would iterate its
			// characters and wrongly turn `unknown` into `disconnected`.
			if (Array.isArray(tools)) {
				for (const tool of tools) {
					const match = /^mcp__(.+?)__/.exec(tool?.name ?? "");
					if (match) connected.add(match[1]);
				}
				toolsReadable = true;
			}
		}
	} catch {
		/* the tool list is unavailable; every configured server is unknown */
	}

	state.snapshot.mcp = [...configured].sort().map((name) => {
		// pi sanitizes non `[A-Za-z0-9_]` characters in a tool name to `_`, so
		// `my-server` appears as `my_server`. Match the raw name first, then the
		// sanitized name, so a connected server is not painted red.
		const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
		const isConnected = toolsReadable && (connected.has(name) || connected.has(sanitized));
		const status: McpServerStatus = !toolsReadable
			? "unknown"
			: isConnected
				? "connected"
				: "disconnected";
		return normalizeMcpStatus({ name, configured: true, status });
	});
}

/**
 * Count one root MCP tool start. A repeated call id counts once, so the caller
 * must skip the session refresh for it.
 *
 * Returns true when the start was new.
 */
export function noteRootToolCall(state: InternalState, event: ToolExecutionStartEvent): boolean {
	if (typeof event.toolCallId === "string") {
		if (state.rootCallIds.has(event.toolCallId)) return false;
		state.rootCallIds.add(event.toolCallId);
	}
	state.rootMcpUsage = countMcpTool(state.rootMcpUsage, event.toolName);
	applyMcpUsage(state);
	return true;
}

/** Start the MCP poll. `teardown` clears the timer. */
export function startMcpPoll(state: InternalState, pi: ExtensionAPI): void {
	state.timers.push(setInterval(() => guard(() => refreshMcpFromDisk(state, pi)), MCP_POLL_MS));
}
