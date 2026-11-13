/**
 * Sidebar panel renderers — pure.
 *
 * The seven right-column panels: AGENTS (tree), STUDY STATUS, SESSION,
 * WORKSPACE, MCP, TODOS, LOG, plus the node detail overlay. Every function is
 * pure: no fs, no timers, no pi runtime import. The panel caps live here with
 * their only readers, next to the panel stack. The clip comes from
 * `sidebar-line.ts`, the theme, the glyphs, and the formatters from
 * `sidebar-theme.ts`, the row code from `sidebar-render.ts`, and the snapshot
 * shapes from `sidebar-types.ts`.
 *
 * `sidebar-render.test.ts` runs under plain Node (type stripping).
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { lookupMcpCount, totalMcpCount } from "./mcp-usage.ts";
import { clipLine } from "./sidebar-line.ts";
import {
	contextBar,
	contextBarColor,
	formatRow,
	header,
	oneLine,
	overflowMark,
	renderTreeLines,
	shortenHome,
} from "./sidebar-render.ts";
import {
	color,
	formatCount,
	formatElapsed,
	stateGlyph,
	styleDim,
	type SidebarTheme,
} from "./sidebar-theme.ts";
import type {
	AskLogRow,
	McpServerStatus,
	McpSnapshot,
	SessionSnapshot,
	SidebarSnapshot,
	StatusSnapshot,
	StudyRowSnapshot,
	TodoItem,
	TodoSnapshot,
	WorkspaceFileSnapshot,
	WorkspaceSnapshot,
} from "./sidebar-types.ts";
import { flattenTreeKeeping, type TreeNode } from "./tree-model.ts";

/** Per-file diff lines shown in WORKSPACE before the `… +N more` mark. */
export const WORKSPACE_FILES_SHOWN = 4;
/** Server lines shown in MCP before the `… +N more` mark. */
export const MCP_SERVERS_SHOWN = 4;
/** Output-preview lines kept in the node detail overlay. */
export const DETAIL_PREVIEW_LINES = 20;
/** Width of the SESSION stats label column. Fits sidebar width 45. */
export const SESSION_LABEL_WIDTH = 11;
/** Study rows shown in STUDY STATUS before the `… +N more` marker. */
export const STUDY_STATUS_SHOWN = 4;
/**
 * Minimum AGENTS panel lines, header included. A short tree pads with blank
 * lines so the panels below stay put.
 */
export const AGENTS_PAD_MIN = 4; // blank lines buy a stable footprint, so lower panels do not jump
/**
 * Tree node rows painted in AGENTS before the dim `… +N more` mark. One screen
 * of agent lines: a common terminal has room for about this many tree rows in
 * the top slot. The cap stops a runaway tree from painting thousands of lines.
 */
export const TREE_ROWS_SHOWN = 20;
/**
 * Todo rows painted in TODOS before the dim `… +N more` mark. Six rows plus the
 * header and the progress line is the eight-line TODOS block a tall column
 * paints today.
 */
export const TODOS_ROWS_SHOWN = 6;
/**
 * Fixed LOG panel lines, header included: one header and 4 text lines. The
 * newest rows wrap at the panel width and the panel stops at four text lines.
 */
export const LOG_PANEL_LINES = 5;

/**
 * The AGENTS panel: header plus one indented line per node. The rows stop at
 * `TREE_ROWS_SHOWN` and the rest show as a dim `… +N more` mark. A short tree
 * pads to `AGENTS_PAD_MIN` so the panels below do not jump. Zero nodes gives a
 * single placeholder line.
 */
export function renderAgentTreePanel(
	tree: TreeNode[],
	width: number,
	theme: SidebarTheme,
	frame: number,
	now: number = Date.now(),
): string[] {
	const lines: string[] = [header(theme, " AGENTS ")];
	const nodes = flattenTreeKeeping(tree ?? []);

	if (nodes.length === 0) {
		lines.push("(no active agents)");
	} else {
		const nodeLines = renderTreeLines(tree, theme, frame, now);
		const shown = nodeLines.slice(0, TREE_ROWS_SHOWN);
		lines.push(...shown);
		const mark = overflowMark(nodeLines.length - shown.length);
		if (mark) lines.push(styleDim(theme, mark));
	}

	// padToMin: reserve a stable footprint, so lower panels do not jump.
	while (lines.length < AGENTS_PAD_MIN) lines.push("");

	return lines.map((line) => clipLine(line, width));
}

/** One study row: stage glyph, study name, brief count, and age. */
function studyRow(
	row: StudyRowSnapshot,
	width: number,
	theme: SidebarTheme,
	now: number,
): string {
	const glyph = stateGlyph(theme, (row.stage ?? "").toLowerCase());
	const age = row.updated === null ? null : formatElapsed(now - Date.parse(row.updated));
	return formatRow(`${glyph} ${oneLine(row.name)}`, [String(row.briefs), age], width);
}

/**
 * The STUDY STATUS panel: one dense row per study of the current project,
 * newest first. The stage shows as a coloured glyph; the row carries the study
 * name, the brief count, and the age. The list stops at `STUDY_STATUS_SHOWN`
 * and marks the rest. An empty list paints one dim line.
 */
export function renderStatusPanel(
	status: StatusSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	now: number = Date.now(),
): string[] {
	const lines: string[] = [header(theme, " STUDY STATUS ")];
	const rows = status?.studies ?? [];

	if (rows.length === 0) {
		lines.push(styleDim(theme, "no study tracked"));
	} else {
		const shown = rows.slice(0, STUDY_STATUS_SHOWN);
		for (const row of shown) lines.push(studyRow(row, width, theme, now));
		const mark = overflowMark(rows.length - shown.length);
		if (mark) lines.push(styleDim(theme, mark));
	}

	return lines.map((line) => clipLine(line, width));
}

/**
 * The LOG panel body: the plain header, then the newest rows, each wrapped to
 * the width. The panel carries generic log events, so a kept-against-cap count
 * tells the reader nothing. The panel stops after 4 text lines, so a row that
 * does not fit keeps the lines that still fit and the panel ends there. A
 * missing ring paints the empty panel.
 */
export function askLogLines(
	rows: AskLogRow[] | null | undefined,
	width: number,
	theme: SidebarTheme = {},
): string[] {
	const list = rows ?? [];
	const lines: string[] = [header(theme, " LOG ")];
	const budget = LOG_PANEL_LINES - 1;

	if (list.length === 0) {
		lines.push("(no log events)");
	} else {
		let used = 0;
		for (const row of list) {
			if (used >= budget) break;
			const text = oneLine(row.text);
			// A zero width clips every line to empty, so skip the wrapper there.
			const wrapped = width >= 1 ? wrapTextWithAnsi(text, width) : [text];
			for (const line of wrapped) {
				if (used >= budget) break;
				lines.push(line);
				used += 1;
			}
		}
	}

	return lines.map((line) => clipLine(line, width));
}

/**
 * The LOG panel: `askLogLines` padded to the fixed `LOG_PANEL_LINES` height, so
 * the foot of the column keeps a stable footprint when the ring is short.
 */
export function renderAskLogPanel(
	rows: AskLogRow[] | null | undefined,
	width: number,
	theme: SidebarTheme,
): string[] {
	const lines = askLogLines(rows, width, theme);
	while (lines.length < LOG_PANEL_LINES) lines.push(clipLine("", width));
	return lines.slice(0, LOG_PANEL_LINES);
}

/** One SESSION stats row, the label padded to a fixed column. */
function sessionRow(label: string, value: string): string {
	return `${label.padEnd(SESSION_LABEL_WIDTH)}${value}`;
}

/** The SESSION panel: an aligned label/value column for the session stats. */
export function renderSessionPanel(
	session: SessionSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	now: number = Date.now(),
): string[] {
	const lines: string[] = [header(theme, " SESSION ")];
	const data = session ?? null;

	lines.push(sessionRow("model", data?.model ?? "n/a"));
	lines.push(sessionRow("thinking", data?.thinkingLevel ?? "n/a"));

	const tokens = data?.contextTokens ?? null;
	const window = data?.contextWindow ?? null;
	if (tokens === null || window === null) {
		lines.push(sessionRow("ctx", "n/a"));
	} else {
		const percent = data?.contextPercent ?? (window > 0 ? (tokens / window) * 100 : 0);
		const bar = color(theme, contextBarColor(percent), contextBar(percent));
		const counts = `${formatCount(tokens)}/${formatCount(window)}`;
		lines.push(sessionRow("ctx", `${bar}  ${Math.round(percent)}% (${counts})`));
	}

	const tokenText = `${formatCount(data?.tokensIn ?? 0)} / ${formatCount(data?.tokensOut ?? 0)}`;
	lines.push(sessionRow("tokens", tokenText));
	const cost = data?.cost ?? null;
	const costText = cost === null ? "-" : `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
	lines.push(sessionRow("cost", costText));
	lines.push(sessionRow("turns", data?.turns == null ? "-" : String(data.turns)));
	const tps = data?.tps ?? null;
	lines.push(sessionRow("tok/s", tps === null ? "-" : tps.toFixed(1)));
	const start = data?.sessionStartMs ?? null;
	lines.push(sessionRow("elapsed", start === null ? "-" : formatElapsed(now - start)));

	return lines.map((line) => clipLine(line, width));
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
	const path = clipLine(file.path, pathWidth);
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
		const shown = files.slice(0, WORKSPACE_FILES_SHOWN);
		for (const file of shown) lines.push(workspaceFileLine(file, width, theme));
		const mark = overflowMark(files.length - shown.length);
		if (mark) lines.push(styleDim(theme, mark));
	} else if (changed.length > 0) {
		// The data layer caps this list, so the panel drops no row here.
		const mark = overflowMark(0);
		const summary = changed.join(", ");
		lines.push(mark ? `${summary} ${mark}` : summary);
	}

	lines.push(styleDim(theme, shortenHome(workspace.cwd, home) || "~"));
	return lines.map((line) => clipLine(line, width));
}

/**
 * The dot glyph for one MCP status. A missing or unrecognized status falls back
 * to `unknown`, so a stale snapshot never throws.
 */
function mcpStatusDot(theme: SidebarTheme, status: McpServerStatus | undefined): string {
	const resolved: McpServerStatus =
		status === "connected" || status === "disconnected" ? status : "unknown";
	return stateGlyph(theme, resolved);
}

/** The MCP panel: header plus a summary line, server rows, and a usage total. */
export function renderMcpPanel(
	mcp: McpSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	usage?: Record<string, number>,
): string[] {
	const lines: string[] = [header(theme, " MCP ")];
	// The built-in API has no live connection state; `status` is inferred.
	const servers = mcp ?? [];
	const configured = servers.filter((server) => server.configured).length;
	// The dot and the count read the same field, so the two cannot drift.
	const connected = servers.filter((server) => server.status === "connected").length;
	lines.push(`configured: ${configured}, connected: ${connected}`);

	if (servers.length === 0) {
		lines.push("(no servers)");
	} else {
		const shown = servers.slice(0, MCP_SERVERS_SHOWN);
		for (const server of shown) {
			const glyph = mcpStatusDot(theme, server.status);
			// An absent usage map means the caller does not track usage at all.
			const badge = usage !== undefined ? ` ${styleDim(theme, `x${lookupMcpCount(usage, server.name)}`)}` : "";
			lines.push(`${glyph} ${server.name}${badge}`);
		}
		if (servers.length > shown.length) {
			const mark = overflowMark(servers.length - shown.length);
			if (mark) lines.push(styleDim(theme, mark));
		}
	}
	if (usage !== undefined) {
		// The total spans every server, including the rows beyond the visible cap.
		lines.push(styleDim(theme, `total x${totalMcpCount(usage)}`));
	}
	return lines.map((line) => clipLine(line, width));
}

/**
 * The TODOS panel: header, progress, an optional turn marker, and item lines.
 * The item rows stop at `TODOS_ROWS_SHOWN` and the rest show as a dim
 * `… +N more` mark. Both cues sit above the rows, so a cap never drops them.
 */
export function renderTodosPanel(
	todos: TodoSnapshot | null | undefined,
	width: number,
	theme: SidebarTheme,
	showTurnMarker: boolean = false,
): string[] {
	const lines: string[] = [header(theme, " TODOS ")];
	const items = todos ?? [];

	if (items.length === 0) {
		lines.push("(no todos)");
		if (showTurnMarker) lines.push(styleDim(theme, "— new turn —"));
		return lines.map((line) => clipLine(line, width));
	}

	const done = items.filter((item) => item.done).length;
	lines.push(`${done}/${items.length}`);
	if (showTurnMarker) lines.push(styleDim(theme, "— new turn —"));
	if (done === items.length) lines.push(styleDim(theme, "✓ all done"));

	const itemLine = (item: TodoItem): string => {
		const glyph = color(theme, item.done ? "success" : "dim", item.done ? "✓" : "○");
		const text = oneLine(item.text ?? "");
		return `${glyph} ${item.done ? styleDim(theme, text) : text}`;
	};

	const shown = items.slice(0, TODOS_ROWS_SHOWN);
	for (const item of shown) lines.push(itemLine(item));
	const mark = overflowMark(items.length - shown.length);
	if (mark) lines.push(styleDim(theme, mark));
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
		const mark = overflowMark(previewLines.length - shown.length);
		if (mark) lines.push(styleDim(theme, mark));
	}

	return lines.map((line) => clipLine(line, width));
}

/** Glyph of the dim, full-width rule drawn between two panels. */
export const SECTION_RULE_CHAR = "─";

/** A dim, full-width rule drawn between two panels. Never wider than `width`. */
function sectionRule(theme: SidebarTheme, width: number): string {
	const cells = Math.max(0, Math.floor(width));
	return styleDim(theme, SECTION_RULE_CHAR.repeat(cells));
}

/**
 * Stack the panels in the declared order. A dim, full-width rule separates
 * adjacent panels. The stack drops nothing and clips nothing to a viewport:
 * the column is as tall as the panels it holds, and the paint layer takes one
 * window of it.
 */
export function composePanels(width: number, panels: string[][], theme: SidebarTheme): string[] {
	const lines: string[] = [];
	panels.forEach((panel, index) => {
		if (index > 0) lines.push(sectionRule(theme, width));
		lines.push(...panel);
	});
	return lines.map((line) => clipLine(line, width));
}

/**
 * Compose the full right column: the seven panels in the declared order, bounded
 * by their own content. `frame` drives the running spinner.
 */
export function renderSidebarPanel(
	snapshot: SidebarSnapshot,
	width: number,
	theme: SidebarTheme,
	frame: number,
): string[] {
	const now = Date.now();
	const panels = [
		renderAgentTreePanel(snapshot.tree ?? [], width, theme, frame, now),
		renderStatusPanel(snapshot.status, width, theme, now),
		renderSessionPanel(snapshot.session, width, theme, now),
		renderWorkspacePanel(snapshot.workspace, width, theme),
		renderMcpPanel(snapshot.mcp, width, theme, snapshot.mcpUsage),
		renderTodosPanel(snapshot.todos, width, theme, snapshot.todosTurnMarker === true),
		renderAskLogPanel(snapshot.askLog, width, theme),
	];
	return composePanels(width, panels, theme);
}
