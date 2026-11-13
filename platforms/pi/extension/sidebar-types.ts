/**
 * Sidebar snapshot contract — pure types.
 *
 * The shapes the data collector produces and the painters consume: the tree,
 * the session, the workspace, the MCP list, the todos, the study rows, and the
 * log ring. No value, no fs, no timer, so the data layer reads its own contract
 * from here and not from the view.
 */

import type { AskLogEvent } from "./ask-record.ts";
import type { TreeNode } from "./tree-model.ts";

/**
 * Tri-state MCP connection status.
 * - `connected`: a tool named `mcp__<server>__*` exists.
 * - `disconnected`: configured, and the tool list was read but has none.
 * - `unknown`: the tool list is unavailable or errored.
 */
export type McpServerStatus = "connected" | "disconnected" | "unknown";

/** One line per MCP server. `status` is inferred, never live. */
export interface McpServerSnapshot {
	name: string;
	configured: boolean;
	/**
	 * @deprecated Legacy flag. The producer derives it from `status` and no
	 * renderer reads it. Read `status` instead.
	 */
	connected: boolean;
	/** Tri-state connection status. The one truth for the dot and the count. */
	status: McpServerStatus;
}

/** MCP panel data. */
export type McpSnapshot = McpServerSnapshot[];

/** One todo item. */
export interface TodoItem {
	id: string;
	text: string;
	done: boolean;
}

/** TODOS panel data. */
export type TodoSnapshot = TodoItem[];

/** SESSION panel data. Null means "unknown"; the renderer prints `n/a`. */
export interface SessionSnapshot {
	model: string | null;
	thinkingLevel: string | null;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
	cost: number | null;
	tps: number | null;
	/** Prompt tokens summed over the session's assistant messages. */
	tokensIn: number;
	/** Completion tokens summed over the session's assistant messages. */
	tokensOut: number;
	/** Assistant turns, one per assistant message. */
	turns: number;
	/** Epoch ms of the earliest session entry, or null when unknown. */
	sessionStartMs: number | null;
}

/** One changed file and its diff stats. `untracked` has no `removed` lines. */
export interface WorkspaceFileSnapshot {
	path: string;
	added: number;
	removed: number;
	untracked: boolean;
}

/** WORKSPACE panel data. */
export interface WorkspaceSnapshot {
	cwd: string;
	branch: string | null;
	changed: string[];
	changedCount: number;
	/** Per-file diff stats. Bounded to keep the snapshot small. */
	files: WorkspaceFileSnapshot[];
}

/** One study row in the STUDY STATUS panel. */
export interface StudyRowSnapshot {
	/** Folder name with its `YYYY-MM-DD-` prefix dropped. */
	name: string;
	/** Study stage word, or `null` when the `Stage` line is absent. */
	stage: string | null;
	/** Number of brief files under the study's `briefs/` folder. */
	briefs: number;
	/** The `Updated` field, an ISO date, or `null` when it is absent. */
	updated: string | null;
}

/**
 * STUDY STATUS panel data: the studies of the current project, newest first.
 * A missing value prints `-`; an empty list prints one dim line.
 */
export interface StatusSnapshot {
	/** Studies to paint. The panel caps the list and marks the overflow. */
	studies: StudyRowSnapshot[];
}

/**
 * One LOG panel row: one ring entry, newest first at index 0. The shape is the
 * ring shape from `ask-record.ts`, so the snapshot field needs no copy.
 */
export type AskLogRow = AskLogEvent;

/** Everything the sidebar paints in one frame. */
export interface SidebarSnapshot {
	cwd: string;
	tree: TreeNode[];
	/** STUDY STATUS panel data. Absent means nothing was probed yet. */
	status?: StatusSnapshot;
	/** The newest ring entries, newest first. Absent means no log read yet. */
	askLog?: AskLogRow[];
	session: SessionSnapshot;
	workspace: WorkspaceSnapshot;
	mcp: McpSnapshot;
	/** Session-wide MCP tool-call count per server. Absent means usage is not tracked. */
	mcpUsage?: Record<string, number>;
	todos: TodoSnapshot;
	/** True when the TODOS panel paints the last turn boundary. */
	todosTurnMarker?: boolean;
	tps: number;
}
