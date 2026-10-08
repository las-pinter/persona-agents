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

/** Changed names shown inline in WORKSPACE before the `… +N more` mark. */
export const WORKSPACE_CHANGED_SHOWN = 4;
/** Per-file diff lines shown in WORKSPACE before the `… +N more` mark. */
export const WORKSPACE_FILES_SHOWN = 4;
/** Server lines shown in MCP before the `… +N more` mark. */
export const MCP_SERVERS_SHOWN = 4;
/** Todo lines shown in TODOS before the `… +N more` mark. */
export const TODOS_SHOWN = 4;
/** Output-preview lines kept in the node detail overlay. */
export const DETAIL_PREVIEW_LINES = 20;
/** Fixed cell count of the SESSION context fill bar. */
export const CONTEXT_BAR_CELLS = 10;
/** Width of the SESSION stats label column. */
export const SESSION_LABEL_WIDTH = 12;
/**
 * Minimum AGENTS panel lines, header included. A short tree pads with blank
 * lines so the panels below stay put. Clamped to the height budget.
 */
export const AGENTS_PAD_MIN = 4; // blank lines buy a stable footprint, so lower panels do not jump

/** Status spinner. One glyph per animation frame. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal theme duck type. Keeps the renderers free of the pi runtime, so the
 * tests need no theme object. Every method is optional: a plain object is
 * enough, and a missing method degrades to plain text.
 */
export interface SidebarTheme {
	bold?(text: string): string;
	dim?(text: string): string;
	fg?(color: string, text: string): string;
	/** Optional token inventory. A missing key means the token is unavailable. */
	colors?: Record<string, unknown>;
}

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
	/** True only when `status` is `connected`. Kept for the summary count. */
	connected: boolean;
	/** Tri-state connection status. */
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

/** Apply a theme color when the duck type has `fg`. Falls back to plain text. */
function color(theme: SidebarTheme, name: string, text: string): string {
	if (typeof theme.fg !== "function") return text;
	let colors: Record<string, unknown> | undefined;
	try {
		colors = theme.colors;
	} catch {
		colors = undefined;
	}
	// A theme with a token map keeps an unknown token as plain text.
	if (colors && !(name in colors)) return text;
	try {
		return theme.fg(name, text);
	} catch {
		return text;
	}
}

/** Bold text when the duck type has `bold`; otherwise the plain text. */
function styleBold(theme: SidebarTheme, text: string): string {
	if (typeof theme.bold !== "function") return text;
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

/** Dim text. Falls back to the `dim` color token, then to plain text. */
function styleDim(theme: SidebarTheme, text: string): string {
	if (typeof theme.dim === "function") {
		try {
			return theme.dim(text);
		} catch {
			return text;
		}
	}
	return color(theme, "dim", text);
}

/** A panel header: accent-colored and bold when the theme supports it. */
function header(theme: SidebarTheme, title: string): string {
	return styleBold(theme, color(theme, "accent", title));
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
	if (status === "idle") return "○";
	if (status === "done") return "✓";
	if (status === "failed") return "✗";
	if (status === "stale") return "⚠";
	return "?";
}

/** The glyph for one node, colored. An orphan mark wins over the status. */
export function statusGlyph(theme: SidebarTheme, node: TreeNode, frame: number): string {
	if (node.orphan) return color(theme, "warning", "?");
	switch (node.status) {
		case "running":
			return color(theme, "accent", statusIcon("running", frame));
		case "done":
			return color(theme, "success", "✓");
		case "failed":
			return color(theme, "error", "✗");
		case "stale":
			return color(theme, "warning", "⚠");
		default:
			return color(theme, "dim", "○");
	}
}

/** Compact a count: `1234` gives `1.2k`, `1500000` gives `1.5M`. */
export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return "-";
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value));
}

/** Compact a duration in ms: `65000` gives `1m05s`. A null gives `-`. */
export function formatElapsed(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
	const totalSeconds = Math.floor(ms / 1000);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** The elapsed run time from `startedAt` to `endedAt`, or to `now`. */
function nodeElapsedMs(node: TreeNode, now: number): number | null {
	const start = Date.parse(node.startedAt);
	if (!Number.isFinite(start)) return null;
	const end = node.endedAt !== null ? Date.parse(node.endedAt) : now;
	if (!Number.isFinite(end)) return null;
	return end - start;
}

/** The node token total: input plus output. Null when usage is missing. */
function nodeTokenTotal(node: TreeNode): number | null {
	const usage = node.usage;
	if (!usage) return null;
	const input = Number.isFinite(usage.input) ? usage.input : 0;
	const output = Number.isFinite(usage.output) ? usage.output : 0;
	return input + output;
}

/** The compact metric block for one node line. Missing values give `-`. */
function nodeMetrics(node: TreeNode, now: number): string {
	const elapsed = formatElapsed(nodeElapsedMs(node, now));
	const tokens = nodeTokenTotal(node);
	const tokenText = tokens === null ? "-" : formatCount(tokens);
	const turnsText = node.usage ? `${node.usage.turns}t` : "-";
	const toolsText = `${Math.max(0, Math.floor(node.toolCount ?? 0))}⚒`;
	return `${elapsed} ${tokenText} ${turnsText} ${toolsText}`;
}

/** A fixed-cell context bar. `█` is filled, `░` is empty. */
export function contextBar(percent: number, cells: number = CONTEXT_BAR_CELLS): string {
	const count = Math.max(0, Math.floor(cells));
	const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
	const filled = Math.round((clamped / 100) * count);
	return "█".repeat(filled) + "░".repeat(Math.max(0, count - filled));
}

/** The threshold color token for a context percent. */
export function contextBarColor(percent: number): string {
	if (percent > 80) return "error";
	if (percent >= 50) return "warning";
	return "success";
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

/** True when at least one node in the forest is running. */
export function hasRunningNode(tree: TreeNode[]): boolean {
	return flatten(tree ?? []).some((node) => node.status === "running");
}

/** The branch glyph prefix for one node. A top-level node has no connector. */
function connector(isRoot: boolean, isLast: boolean, ancestorPrefix: string): string {
	if (isRoot) return "";
	return `${ancestorPrefix}${isLast ? "└─ " : "├─ "}`;
}

/** The prefix for a node's children, aligned under its connector. */
function childPrefix(isRoot: boolean, isLast: boolean, ancestorPrefix: string): string {
	if (isRoot) return "";
	return `${ancestorPrefix}${isLast ? "   " : "│  "}`;
}

/** Recursive branch render. Appends one unclipped line per node. */
function renderBranch(
	nodes: TreeNode[],
	theme: SidebarTheme,
	frame: number,
	now: number,
	ancestorPrefix: string,
	topLevel: boolean,
	out: string[],
): void {
	nodes.forEach((node, index) => {
		const isLast = index === nodes.length - 1;
		const isRoot = topLevel;
		const icon = statusGlyph(theme, node, frame);
		const agent = node.agent || "unknown";
		const metrics = nodeMetrics(node, now);
		const task = oneLine(node.task ?? "");
		const preview = task.length > 0 ? `  ${color(theme, "muted", task)}` : "";
		out.push(
			`${connector(isRoot, isLast, ancestorPrefix)}${icon} ${agent} ${metrics}${preview}`,
		);
		renderBranch(
			node.children,
			theme,
			frame,
			now,
			childPrefix(isRoot, isLast, ancestorPrefix),
			false,
			out,
		);
	});
}

/**
 * The tree node lines only, no header and no clip. One line per node. Branch
 * glyphs (`├─`, `└─`, `│`) show the structure; the root has no connector. Each
 * line is `<connector><glyph> <agent> <metrics>[  <task>]`.
 *
 * Returns UNCLIPPED lines; the caller must clip them to the panel width.
 */
export function renderTreeLines(
	tree: TreeNode[],
	theme: SidebarTheme,
	frame: number,
	now: number = Date.now(),
): string[] {
	const out: string[] = [];
	renderBranch(tree ?? [], theme, frame, now, "", true, out);
	return out;
}

/**
 * The AGENTS panel: header plus one indented line per node, clipped to the
 * panel height. A short tree pads to `AGENTS_PAD_MIN` so the panels below do
 * not jump. Zero nodes gives a single placeholder line.
 */
export function renderAgentTreePanel(
	tree: TreeNode[],
	width: number,
	height: number,
	theme: SidebarTheme,
	frame: number,
	now: number = Date.now(),
): string[] {
	const lines: string[] = [header(theme, " AGENTS ")];
	const budget = Math.max(0, Math.floor(height) - 1);
	const nodes = flatten(tree ?? []);

	if (nodes.length === 0) {
		if (budget >= 1) lines.push("(no active agents)");
	} else if (budget >= 1) {
		const nodeLines = renderTreeLines(tree, theme, frame, now);
		if (nodeLines.length <= budget) {
			lines.push(...nodeLines);
		} else {
			const shown = Math.max(0, budget - 1);
			lines.push(...nodeLines.slice(0, shown));
			lines.push(styleDim(theme, `… +${nodeLines.length - shown} more`));
		}
	}

	// padToMin: reserve a stable footprint, clamped to the height budget.
	const min = Math.min(AGENTS_PAD_MIN, Math.max(0, Math.floor(height)));
	while (lines.length < min) lines.push("");

	return lines.map((line) => clipLine(line, width));
}

/** One SESSION stats row, the label padded to a fixed column. */
function sessionRow(label: string, value: string): string {
	return `${label.padEnd(SESSION_LABEL_WIDTH)}${value}`;
}

/** The SESSION panel: model, a context fill bar, and a two-column stats table. */
export function renderSessionPanel(
	session: SessionSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	now: number = Date.now(),
): string[] {
	const lines: string[] = [header(theme, " SESSION ")];
	const data = session ?? null;

	lines.push(`model: ${data?.model ?? "n/a"}`);
	lines.push(`thinking: ${data?.thinkingLevel ?? "n/a"}`);

	const tokens = data?.contextTokens ?? null;
	const window = data?.contextWindow ?? null;
	if (tokens === null || window === null) {
		lines.push("ctx n/a");
	} else {
		const percent = data?.contextPercent ?? (window > 0 ? (tokens / window) * 100 : 0);
		const bar = color(theme, contextBarColor(percent), contextBar(percent));
		lines.push(`ctx ${bar} ${tokens}/${window} (${Math.round(percent)}%)`);
	}

	lines.push(sessionRow("metric", "value"));
	lines.push("─".repeat(SESSION_LABEL_WIDTH));
	const tokenText = `${formatCount(data?.tokensIn ?? 0)}/${formatCount(data?.tokensOut ?? 0)}`;
	lines.push(sessionRow("tokens", tokenText));
	const cost = data?.cost ?? null;
	lines.push(sessionRow("cost", cost === null ? "-" : `$${cost.toFixed(4)}`));
	lines.push(sessionRow("turns", data?.turns == null ? "-" : String(data.turns)));
	const tps = data?.tps ?? null;
	lines.push(sessionRow("tok/s", tps === null ? "-" : tps.toFixed(1)));
	const start = data?.sessionStartMs ?? null;
	lines.push(sessionRow("elapsed", start === null ? "-" : formatElapsed(now - start)));

	return lines.map((line) => clipLine(line, width));
}

/** Replace a known home prefix with `~`. */
export function shortenHome(cwd: string, home?: string): string {
	if (!cwd) return cwd;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	const match = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/.*)?$/.exec(cwd);
	if (match) return `~${match[2] ?? ""}`;
	return cwd;
}

/** One WORKSPACE file line: status mark, clipped path, right-aligned diff. */
function workspaceFileLine(
	file: WorkspaceFileSnapshot,
	width: number,
	theme: SidebarTheme,
): string {
	const mark = file.untracked ? "?" : "M";
	const left = ` ${mark} `;
	const stat = file.untracked
		? color(theme, "muted", "?")
		: `${color(theme, "toolDiffAdded", `+${file.added}`)} ${color(theme, "toolDiffRemoved", `-${file.removed}`)}`;
	const statWidth = visibleWidth(stat);
	const leftWidth = visibleWidth(left);
	const pathWidth = Math.max(1, width - leftWidth - statWidth - 1);
	const path = truncateToWidth(file.path, pathWidth, "…", false);
	const gap = Math.max(1, width - leftWidth - visibleWidth(path) - statWidth);
	return `${left}${path}${" ".repeat(gap)}${stat}`;
}

/** The WORKSPACE panel: branch, per-file diff stats, and the shortened cwd. */
export function renderWorkspacePanel(
	workspace: WorkspaceSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	home?: string,
): string[] {
	const lines: string[] = [header(theme, " WORKSPACE ")];
	if (!workspace) {
		lines.push("(not a repo)");
		return lines.map((line) => clipLine(line, width));
	}

	const files = workspace.files ?? [];
	const changed = workspace.changed ?? [];
	const total = Math.max(workspace.changedCount ?? 0, changed.length, files.length);
	const branchText = workspace.branch ? `⎇ ${workspace.branch}` : "(not a repo)";
	lines.push(total === 0 ? `${branchText} (clean)` : `${branchText} ${total} changed`);

	if (files.length > 0) {
		for (const file of files.slice(0, WORKSPACE_FILES_SHOWN)) {
			lines.push(workspaceFileLine(file, width, theme));
		}
		const extra = total - Math.min(files.length, WORKSPACE_FILES_SHOWN);
		if (extra > 0) lines.push(styleDim(theme, `… +${extra} more`));
	} else if (changed.length > 0) {
		const shown = changed.slice(0, WORKSPACE_CHANGED_SHOWN);
		const extra = total - shown.length;
		const summary = shown.join(", ") + (extra > 0 ? ` … +${extra} more` : "");
		lines.push(summary);
	}

	lines.push(styleDim(theme, shortenHome(workspace.cwd, home) || "~"));
	return lines.map((line) => clipLine(line, width));
}

/**
 * The dot glyph and theme token for one MCP status. A missing or unrecognized
 * status falls back to `unknown`, so a stale snapshot never throws.
 */
function mcpStatusDot(
	status: McpServerStatus | undefined,
	connected: boolean | undefined,
): { glyph: string; token: string } {
	const resolved: McpServerStatus =
		status === "connected" || status === "disconnected" || status === "unknown"
			? status
			: connected === true
				? "connected"
				: "disconnected";
	if (resolved === "connected") return { glyph: "●", token: "success" };
	if (resolved === "disconnected") return { glyph: "○", token: "error" };
	return { glyph: "◐", token: "warning" };
}

/** The MCP panel: header plus a summary line and server lines. */
export function renderMcpPanel(
	mcp: McpSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [header(theme, " MCP ")];
	// The built-in API has no live connection state; `connected` is inferred.
	const servers = mcp ?? [];
	const configured = servers.filter((server) => server.configured).length;
	// Derive the count from the dot's source of truth so the two cannot drift.
	const connected = servers.filter((server) => server.status === "connected").length;
	lines.push(`configured: ${configured}, connected: ${connected}`);

	if (servers.length === 0) {
		lines.push("(no servers)");
		return lines.map((line) => clipLine(line, width));
	}

	const shown = servers.slice(0, MCP_SERVERS_SHOWN);
	for (const server of shown) {
		const { glyph, token } = mcpStatusDot(server.status, server.connected);
		lines.push(`${color(theme, token, glyph)} ${server.name}`);
	}
	if (servers.length > shown.length) {
		lines.push(styleDim(theme, `… +${servers.length - shown.length} more`));
	}
	return lines.map((line) => clipLine(line, width));
}

/** The TODOS panel: header plus a progress line and todo lines. */
export function renderTodosPanel(
	todos: TodoSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines: string[] = [header(theme, " TODOS ")];
	const items = todos ?? [];

	if (items.length === 0) {
		lines.push("(no todos)");
		return lines.map((line) => clipLine(line, width));
	}

	const done = items.filter((item) => item.done).length;
	lines.push(`${done}/${items.length}`);

	const shown = items.slice(0, TODOS_SHOWN);
	for (const item of shown) {
		const glyph = color(theme, item.done ? "success" : "dim", item.done ? "✓" : "○");
		lines.push(`${glyph} ${oneLine(item.text ?? "")}`);
	}
	if (items.length > shown.length) {
		lines.push(styleDim(theme, `… +${items.length - shown.length} more`));
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
	lines.push(header(theme, ` AGENT ${node.agent || "unknown"} `));
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
			lines.push(styleDim(theme, `… +${previewLines.length - shown.length} more`));
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
		toolCount: node.toolCount,
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
				tokensIn: snapshot.session.tokensIn,
				tokensOut: snapshot.session.tokensOut,
				turns: snapshot.session.turns,
				sessionStartMs: snapshot.session.sessionStartMs,
			}
		: null;

	const workspace = snapshot.workspace
		? {
				cwd: snapshot.workspace.cwd,
				branch: snapshot.workspace.branch,
				changed: snapshot.workspace.changed,
				changedCount: snapshot.workspace.changedCount,
				files: snapshot.workspace.files,
			}
		: null;

	const mcp = (snapshot.mcp ?? []).map((server) => ({
		name: server.name,
		configured: server.configured,
		connected: server.connected,
		status: server.status,
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
 * panels are dropped first; the tree keeps the top slot. A blank separator
 * line goes between panels only when it costs no panel.
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

	// Separators are a nicety: add them only when they fit without dropping a panel.
	const separators = count - 1;
	const useSeparators = separators > 0 && total + separators <= limit;

	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		if (useSeparators && index > 0) lines.push("");
		lines.push(...panels[index]);
	}
	if (lines.length > limit) lines.length = limit;
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

	const now = Date.now();
	const panels: string[][] = [
		renderAgentTreePanel(snapshot.tree ?? [], width, limit, theme, frame, now),
		renderSessionPanel(snapshot.session, width, theme, now),
		renderWorkspacePanel(snapshot.workspace, width, theme),
		renderMcpPanel(snapshot.mcp, width, theme),
		renderTodosPanel(snapshot.todos, width, theme),
	];

	return composePanels(ctx, panels);
}
