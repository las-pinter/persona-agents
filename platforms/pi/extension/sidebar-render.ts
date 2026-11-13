/**
 * Sidebar render helpers — pure.
 *
 * The theme duck type, the formatters, the glyphs, the tree line render, and
 * the panel stack. Every function is pure: no fs, no timers, no pi runtime
 * import. The seven panel renderers live in `sidebar-panels.ts`, the snapshot
 * shapes in `sidebar-types.ts`, and the line clip in `sidebar-line.ts`.
 *
 * `sidebar-render.test.ts` runs under plain Node (type stripping).
 */

import { clipLine } from "./sidebar-line.ts";
import { roundMark } from "./subagent-marks.ts";
import { flattenTreeKeeping, type TreeNode, type TreeNodeStatus } from "./tree-model.ts";

/** Per-file diff lines shown in WORKSPACE before the `… +N more` mark. */
export const WORKSPACE_FILES_SHOWN = 4;
/** Server lines shown in MCP before the `… +N more` mark. */
export const MCP_SERVERS_SHOWN = 4;
/** Output-preview lines kept in the node detail overlay. */
export const DETAIL_PREVIEW_LINES = 20;
/** Fixed cell count of the SESSION context fill bar. */
export const CONTEXT_BAR_CELLS = 10;
/** Width of the SESSION stats label column. Fits sidebar width 45. */
export const SESSION_LABEL_WIDTH = 11;
/** Study rows shown in STUDY STATUS before the `… +N more` marker. */
export const STUDY_STATUS_SHOWN = 4;
/** Separator between the parts of one panel row. */
const ROW_SEPARATOR = " · ";
/** The one word for a missing value in a panel row. */
const ROW_FALLBACK = "-";
/** Glyph of the dim, full-width rule drawn between two panels. */
export const SECTION_RULE_CHAR = "─";
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

/** Apply a theme color when the duck type has `fg`. Falls back to plain text. */
export function color(theme: SidebarTheme, name: string, text: string): string {
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
export function styleDim(theme: SidebarTheme, text: string): string {
	if (typeof theme.dim === "function") {
		try {
			return theme.dim(text);
		} catch {
			return text;
		}
	}
	return color(theme, "dim", text);
}

/** The `… +N more` mark for N hidden rows. Zero hides nothing, so no mark. */
export function overflowMark(hidden: number): string | null {
	return hidden > 0 ? `… +${hidden} more` : null;
}

/** A panel header: accent-colored and bold when the theme supports it. */
export function header(theme: SidebarTheme, title: string): string {
	return styleBold(theme, color(theme, "accent", title));
}

/** A dim, full-width rule drawn between two panels. Never wider than `width`. */
function sectionRule(theme: SidebarTheme, width: number): string {
	const cells = Math.max(0, Math.floor(width));
	return styleDim(theme, SECTION_RULE_CHAR.repeat(cells));
}

/** Collapse all whitespace so a multi-line field stays on one line. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Collapse one row value to one line; a blank value is the fallback word. */
function partText(value: string | null | undefined): string {
	const text = value === null || value === undefined ? "" : oneLine(value);
	return text.length > 0 ? text : ROW_FALLBACK;
}

/**
 * One row of a label and its parts, joined by one separator. A missing part
 * prints the fallback word, and the row is clipped to `width`. Only the STUDY
 * STATUS panel calls it; the other panels keep their own row shapes, and
 * converting them is follow-up work.
 */
export function formatRow(
	label: string | null | undefined,
	parts: Array<string | null | undefined>,
	width: number,
): string {
	const cells = [label, ...parts].map((value) => partText(value));
	return clipLine(cells.join(ROW_SEPARATOR), width);
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
	return `${elapsed} ${tokenText} ${turnsText} ${toolsText}${roundMark(node)}`;
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

/** True when at least one node in the forest is running. */
export function hasRunningNode(tree: TreeNode[]): boolean {
	return flattenTreeKeeping(tree ?? []).some((node) => node.status === "running");
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

/** Replace a known home prefix with `~`. */
export function shortenHome(cwd: string, home?: string): string {
	if (!cwd) return cwd;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	const match = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/.*)?$/.exec(cwd);
	if (match) return `~${match[2] ?? ""}`;
	return cwd;
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
