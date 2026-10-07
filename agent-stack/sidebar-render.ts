/**
 * Sidebar panel renderers — pure.
 *
 * Composes the five right-column panels: AGENTS (tree), SESSION, WORKSPACE,
 * MCP, TODOS. Every function is pure: no fs, no timers, no pi runtime import.
 * The only external import is `truncateToWidth`/`visibleWidth`, so every line
 * fits the column width.
 *
 * `sidebar-render.test.ts` runs under plain Node (type stripping).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TreeNode, TreeNodeStatus } from "./tree-model.ts";

/** One line per session field, max. */
export const SESSION_MAX_LINES = 5;
/** Changed names shown inline in WORKSPACE before the `… +N more` mark. */
export const WORKSPACE_CHANGED_SHOWN = 4;
/** Server lines shown in MCP before the `… +N more` mark. */
export const MCP_SERVERS_SHOWN = 4;
/** Todo lines shown in TODOS before the `… +N more` mark. */
export const TODOS_SHOWN = 4;
/** Output-preview lines kept in the node detail overlay. */
export const DETAIL_PREVIEW_LINES = 20;

/** Status spinner. One glyph per animation frame. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal theme duck type. Keeps the renderers free of the pi runtime, so the
 * tests need no theme object. `fg` is optional; a plain object is enough.
 */
export interface SidebarTheme {
	bold(text: string): string;
	dim(text: string): string;
	fg?(color: string, text: string): string;
}

/** One line per MCP server. `connected` is inferred, never live. */
export interface McpServerSnapshot {
	name: string;
	configured: boolean;
	connected: boolean;
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
}

/** WORKSPACE panel data. */
export interface WorkspaceSnapshot {
	cwd: string;
	branch: string | null;
	changed: string[];
	changedCount: number;
}

/** Everything the sidebar paints in one frame. */
export interface SidebarSnapshot {
	cwd: string;
	tree: TreeNode[];
	session: SessionSnapshot;
	workspace: WorkspaceSnapshot;
	mcp: McpSnapshot;
	todos: TodoSnapshot;
	tps: number;
}

/** Size and animation context shared by the compositor helpers. */
export interface PanelContext {
	width: number;
	height: number;
	frame: number;
}

/** Apply a theme color when the duck type has `fg`. */
function color(theme: SidebarTheme, name: string, text: string): string {
	return theme.fg ? theme.fg(name, text) : text;
}

/** Collapse all whitespace so a multi-line field stays on one line. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Clip one line to `width`. Never returns a line wider than `width`. */
export function clipLine(line: string, width: number): string {
	const w = Math.max(0, Math.floor(width));
	if (w <= 0) return "";
	const clipped = truncateToWidth(line, w, "…", true);
	// A wide char at the boundary can still overflow. Drop it if so.
	return visibleWidth(clipped) > w ? truncateToWidth(clipped, w, "", true) : clipped;
}

/** The spinner glyph for a running node at `frame`, or the status glyph. */
export function statusIcon(status: TreeNodeStatus, frame: number): string {
	if (status === "running") {
		if (!Number.isFinite(frame)) return SPINNER_FRAMES[0];
		const len = SPINNER_FRAMES.length;
		const index = ((Math.floor(frame) % len) + len) % len;
		return SPINNER_FRAMES[index];
	}
	if (status === "done") return "✓";
	if (status === "failed") return "✗";
	if (status === "stale") return "⚠";
	return "?";
}

/** The glyph for one node: an orphan mark wins over the status glyph. */
function nodeIcon(node: TreeNode, frame: number): string {
	return node.orphan ? "?" : statusIcon(node.status, frame);
}

/** Depth-first walk, parents before children, original sibling order. */
function walk(nodes: TreeNode[], out: TreeNode[]): void {
	for (const node of nodes) {
		out.push(node);
		walk(node.children, out);
	}
}

/** Flatten a forest depth-first. */
function flatten(nodes: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	walk(nodes, out);
	return out;
}

/**
 * The indented node lines only, no header and no clip. One line per node.
 * Indent grows with `node.depth`.
 *
 * Returns UNCLIPPED lines; the caller must clip them to the panel width.
 */
export function renderTreeLines(
	tree: TreeNode[],
	theme: SidebarTheme,
	frame: number,
): string[] {
	const nodes = flatten(tree ?? []);
	const lines: string[] = [];
	for (const node of nodes) {
		const depth = Math.max(0, node.depth);
		const indent = "  ".repeat(depth);
		const icon = color(theme, node.orphan ? "warning" : "accent", nodeIcon(node, frame));
		const agent = node.agent || "unknown";
		const task = oneLine(node.task ?? "");
		const preview = task.length > 0 ? `  ${color(theme, "muted", task)}` : "";
		lines.push(`${indent}${icon} ${agent}${preview}`);
	}
	return lines;
}

/**
 * The AGENTS panel: header plus one indented line per node, clipped to the
 * panel height. Zero nodes gives a single placeholder line.
 */
export function renderAgentTreePanel(
	tree: TreeNode[],
	width: number,
	height: number,
	theme: SidebarTheme,
	frame: number,
): string[] {
	const lines: string[] = [theme.bold(" AGENTS ")];
	const budget = Math.max(0, Math.floor(height) - 1);
	const nodes = flatten(tree ?? []);

	if (nodes.length === 0) {
		if (budget >= 1) lines.push("(no active agents)");
		return lines.map((line) => clipLine(line, width));
	}
	if (budget === 0) return lines.map((line) => clipLine(line, width));

	const nodeLines = renderTreeLines(tree, theme, frame);
	if (nodeLines.length <= budget) {
		lines.push(...nodeLines);
	} else {
		const shown = Math.max(0, budget - 1);
		lines.push(...nodeLines.slice(0, shown));
		lines.push(theme.dim(`… +${nodeLines.length - shown} more`));
	}
	return lines.map((line) => clipLine(line, width));
}

/** The SESSION panel: header plus up to five field lines. */
export function renderSessionPanel(
	session: SessionSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [theme.bold(" SESSION ")];
	const data = session ?? null;

	lines.push(`model: ${data?.model ?? "n/a"}`);
	lines.push(`thinking: ${data?.thinkingLevel ?? "n/a"}`);

	const tokens = data?.contextTokens ?? null;
	const window = data?.contextWindow ?? null;
	if (tokens === null || window === null) {
		lines.push("context: n/a");
	} else {
		const percent =
			data?.contextPercent ?? (window > 0 ? (tokens / window) * 100 : 0);
		lines.push(`context: ${tokens}/${window} (${Math.round(percent)}%)`);
	}

	const cost = data?.cost ?? null;
	lines.push(`cost: ${cost === null ? "n/a" : `$${cost.toFixed(4)}`}`);

	const tps = data?.tps ?? null;
	lines.push(`tps: ${tps === null ? "n/a" : tps.toFixed(1)}`);

	return lines.slice(0, SESSION_MAX_LINES + 1).map((line) => clipLine(line, width));
}

/** Basename of a path without importing `node:path`. */
function baseName(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const parts = trimmed.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

/** The WORKSPACE panel: header plus cwd, branch, and a changed-files line. */
export function renderWorkspacePanel(
	workspace: WorkspaceSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [theme.bold(" WORKSPACE ")];
	if (!workspace) {
		lines.push("(not a repo)");
		return lines.map((line) => clipLine(line, width));
	}

	lines.push(baseName(workspace.cwd));
	lines.push(workspace.branch ?? "(not a repo)");

	const changed = workspace.changed ?? [];
	const total = Math.max(workspace.changedCount ?? 0, changed.length);
	if (total === 0) {
		lines.push("(clean)");
	} else {
		const shown = changed.slice(0, WORKSPACE_CHANGED_SHOWN);
		const extra = Math.max(0, total - shown.length);
		let summary = `${total} changed`;
		if (shown.length > 0) summary += `: ${shown.join(", ")}`;
		if (extra > 0) summary += ` … +${extra} more`;
		lines.push(summary);
	}

	return lines.slice(0, 4).map((line) => clipLine(line, width));
}

/** The MCP panel: header plus a summary line and server lines. */
export function renderMcpPanel(
	mcp: McpSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [theme.bold(" MCP ")];
	// The built-in API has no live connection state; `connected` is inferred.
	const servers = mcp ?? [];
	const configured = servers.filter((server) => server.configured).length;
	const connected = servers.filter((server) => server.connected).length;
	lines.push(`configured: ${configured}, connected: ${connected}`);

	if (servers.length === 0) {
		lines.push("(no servers)");
		return lines.map((line) => clipLine(line, width));
	}

	const shown = servers.slice(0, MCP_SERVERS_SHOWN);
	for (const server of shown) {
		const dot = server.connected ? "●" : "○";
		lines.push(`${dot} ${server.name}`);
	}
	if (servers.length > shown.length) {
		lines.push(theme.dim(`… +${servers.length - shown.length} more`));
	}
	return lines.map((line) => clipLine(line, width));
}

/** The TODOS panel: header plus a progress line and todo lines. */
export function renderTodosPanel(
	todos: TodoSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [theme.bold(" TODOS ")];
	const items = todos ?? [];

	if (items.length === 0) {
		lines.push("(no todos)");
		return lines.map((line) => clipLine(line, width));
	}

	const done = items.filter((item) => item.done).length;
	lines.push(`${done}/${items.length}`);

	const shown = items.slice(0, TODOS_SHOWN);
	for (const item of shown) {
		lines.push(`${item.done ? "✓" : "○"} ${oneLine(item.text ?? "")}`);
	}
	if (items.length > shown.length) {
		lines.push(theme.dim(`… +${items.length - shown.length} more`));
	}
	return lines.map((line) => clipLine(line, width));
}

/** The node detail overlay: preview, usage, exit code, and error. */
export function renderNodeDetail(
	node: TreeNode,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [];
	lines.push(theme.bold(` AGENT ${node.agent || "unknown"} `));
	lines.push(`run: ${node.runId}`);
	lines.push(`status: ${node.status}${node.orphan ? " (orphan)" : ""}`);
	if (node.task) lines.push(`task: ${oneLine(node.task)}`);
	if (node.usage) {
		lines.push(
			`usage: in ${node.usage.input} out ${node.usage.output} cost $${node.usage.cost.toFixed(4)} turns ${node.usage.turns}`,
		);
	} else {
		lines.push("usage: n/a");
	}
	lines.push(`exit: ${node.exitCode ?? "n/a"}`);
	lines.push(`error: ${node.error ?? "-"}`);

	const preview = (node.outputPreview ?? "").replace(/\r\n/g, "\n");
	if (preview.trim().length === 0) {
		lines.push("(no output)");
	} else {
		const previewLines = preview.split("\n");
		const shown = previewLines.slice(0, DETAIL_PREVIEW_LINES);
		for (const line of shown) lines.push(line);
		if (previewLines.length > shown.length) {
			lines.push(theme.dim(`… +${previewLines.length - shown.length} more`));
		}
	}

	return lines.map((line) => clipLine(line, width));
}

/**
 * A signature that changes when any painted content changes.
 *
 * Serializes every field a panel or the node-detail view paints, with
 * `JSON.stringify`. `null` and `""` stay distinct, and no field is sliced.
 * Tasks are already capped at append time, so the full value is safe. Node
 * fields no view paints (`bytesIn`, `bytesOut`, `children`) stay out, so
 * they cannot trigger a needless repaint.
 */
export function treeSignature(snapshot: SidebarSnapshot): string {
	const tree = flatten(snapshot.tree ?? []).map((node) => ({
		runId: node.runId,
		status: node.status,
		orphan: node.orphan,
		agent: node.agent,
		depth: node.depth,
		task: node.task,
		outputPreview: node.outputPreview,
		usage: node.usage,
		exitCode: node.exitCode ?? null,
		error: node.error ?? null,
	}));

	const session = snapshot.session
		? {
				model: snapshot.session.model,
				thinkingLevel: snapshot.session.thinkingLevel,
				contextTokens: snapshot.session.contextTokens,
				contextWindow: snapshot.session.contextWindow,
				contextPercent: snapshot.session.contextPercent,
				cost: snapshot.session.cost,
				tps: snapshot.session.tps,
			}
		: null;

	const workspace = snapshot.workspace
		? {
				cwd: snapshot.workspace.cwd,
				branch: snapshot.workspace.branch,
				changed: snapshot.workspace.changed,
				changedCount: snapshot.workspace.changedCount,
			}
		: null;

	const mcp = (snapshot.mcp ?? []).map((server) => ({
		name: server.name,
		configured: server.configured,
		connected: server.connected,
	}));

	const todos = (snapshot.todos ?? []).map((todo) => ({
		id: todo.id,
		text: todo.text ?? "",
		done: todo.done,
	}));

	return JSON.stringify({
		cwd: snapshot.cwd,
		tree,
		session,
		workspace,
		mcp,
		todos,
		tps: snapshot.tps,
	});
}

/** Move the selection down one id and wrap. An unknown current selects the first. */
export function selectNext(ids: string[], current: string | null): string | null {
	if (ids.length === 0) return current;
	const index = current === null ? -1 : ids.indexOf(current);
	if (index < 0) return ids[0];
	return ids[(index + 1) % ids.length];
}

/** Move the selection up one id and wrap. An unknown current selects the last. */
export function selectPrev(ids: string[], current: string | null): string | null {
	if (ids.length === 0) return current;
	const index = current === null ? -1 : ids.indexOf(current);
	if (index < 0) return ids[ids.length - 1];
	return ids[(index - 1 + ids.length) % ids.length];
}

/**
 * Stack the panels in priority order. When the height is too small, lower
 * panels are dropped first; the tree keeps the top slot.
 */
function composePanels(ctx: PanelContext, panels: string[][]): string[] {
	const limit = Math.max(0, Math.floor(ctx.height));
	if (limit <= 0) return [];

	let total = 0;
	for (const panel of panels) total += panel.length;

	let count = panels.length;
	while (count > 1 && total > limit) {
		count -= 1;
		total -= panels[count].length;
	}

	let lines = panels.slice(0, count).flat();
	if (total > limit) lines = lines.slice(0, limit);
	return lines.map((line) => clipLine(line, ctx.width));
}

/**
 * Compose the full right column.
 *
 * Deviation from the plan: a `height` (line-budget) parameter is added. The
 * plan signature has no height, but a per-panel budget needs one. `frame`
 * drives the running spinner.
 */
export function renderSidebarPanel(
	snapshot: SidebarSnapshot,
	width: number,
	height: number,
	theme: SidebarTheme,
	frame: number,
): string[] {
	const limit = Math.max(0, Math.floor(height));
	if (limit <= 0) return [];
	const ctx: PanelContext = { width, height: limit, frame };

	const panels: string[][] = [
		renderAgentTreePanel(snapshot.tree ?? [], width, limit, theme, frame),
		renderSessionPanel(snapshot.session, width, theme),
		renderWorkspacePanel(snapshot.workspace, width, theme),
		renderMcpPanel(snapshot.mcp, width, theme),
		renderTodosPanel(snapshot.todos, width, theme),
	];

	return composePanels(ctx, panels);
}
