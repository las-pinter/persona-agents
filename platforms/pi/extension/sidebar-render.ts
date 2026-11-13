/**
 * Sidebar render helpers — pure.
 *
 * The paint-facing row code: the tree line render, the row formatter, and the
 * small cell helpers the rows read. Every function is pure: no fs, no timers,
 * no pi runtime import. The theme, the glyphs, and the formatters live in
 * `sidebar-theme.ts`, the panel renderers and their caps in `sidebar-panels.ts`,
 * the snapshot shapes in `sidebar-types.ts`, and the line clip in
 * `sidebar-line.ts`.
 *
 * `sidebar-render.test.ts` runs under plain Node (type stripping).
 */

import { clipLine } from "./sidebar-line.ts";
import { color, formatCount, formatElapsed, stateGlyph, type SidebarTheme } from "./sidebar-theme.ts";
import { roundMark } from "./subagent-marks.ts";
import { flattenTreeKeeping, type TreeNode } from "./tree-model.ts";

/** Fixed cell count of the SESSION context fill bar. */
export const CONTEXT_BAR_CELLS = 10;
/** Separator between the parts of one panel row. */
const ROW_SEPARATOR = " · ";
/** The one word for a missing value in a panel row. */
const ROW_FALLBACK = "-";

/** Bold text when the duck type has `bold`; otherwise the plain text. */
function styleBold(theme: SidebarTheme, text: string): string {
	if (typeof theme.bold !== "function") return text;
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

/** The `… +N more` mark for N hidden rows. Zero hides nothing, so no mark. */
export function overflowMark(hidden: number): string | null {
	return hidden > 0 ? `… +${hidden} more` : null;
}

/** A panel header: accent-colored and bold when the theme supports it. */
export function header(theme: SidebarTheme, title: string): string {
	return styleBold(theme, color(theme, "accent", title));
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
		const icon = stateGlyph(theme, node.orphan ? "orphan" : node.status, frame);
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
