/**
 * How a tool call and a tool result are drawn in the Pi transcript.
 *
 * Display only: the shaping lives in `../scripts/pretty.ts` and
 * `../scripts/highlight.ts`; this module turns their spans into theme colours.
 * The wiring in `extensions/index.ts` only decides when to call it.
 */

import { highlightLines } from "../scripts/highlight.ts";
import { bashLines, groupGrep, treeLines } from "../scripts/pretty.ts";

/** The theme surface these renderers use. */
export interface RenderTheme {
	fg(color: string, text: string): string;
}

/** Paint text with a theme colour, or leave it plain when the name is unknown. */
export function paint(theme: RenderTheme, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

/** The colour of a highlighted span, by what it is. */
const SPAN_COLOR: Record<string, string> = {
	keyword: "accent",
	string: "success",
	number: "warning",
	comment: "dim",
	fn: "accent",
	type: "accent",
};

/** The colour of a bash line, by outcome. */
const LINE_COLOR: Record<string, string> = { fail: "error", pass: "success", warn: "warning" };

/** The most lines a pretty result shows before it names the rest. */
const PRETTY_LINES = 200;

/** A capped body with a last line that says how much is left. */
export function capped(lines: string[]): string[] {
	if (lines.length <= PRETTY_LINES) return lines;
	return [...lines.slice(0, PRETTY_LINES - 1), `… ${lines.length - PRETTY_LINES + 1} more lines (ctrl+o for all)`];
}

/** A file with line numbers and highlighted spans. */
export function prettyFile(path: string, text: string, theme: RenderTheme): string[] {
	const rows = highlightLines(path, text).map((spans, index) => {
		const body = spans.map((span) => paint(theme, SPAN_COLOR[span.kind] ?? "", span.text)).join("");
		return `${String(index + 1).padStart(4)} ${body}`;
	});
	const lines = text.split("\n").length;
	const head = `${path}  ${lines} line${lines === 1 ? "" : "s"}`;
	return capped([paint(theme, "dim", head), ...rows]);
}

/** A path list as a tree. */
export function prettyTree(text: string, theme: RenderTheme): string[] {
	const paths = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	return capped(treeLines(paths).map((line) => paint(theme, "dim", line)));
}

/** Grep output grouped under its files. */
export function prettyGrep(text: string, theme: RenderTheme): string[] {
	const lines: string[] = [];
	for (const group of groupGrep(text)) {
		lines.push(paint(theme, "accent", group.file));
		for (const match of group.matches) lines.push(`  ${match}`);
	}
	return capped(lines);
}

/** Bash output, coloured by outcome. */
export function prettyBash(text: string, theme: RenderTheme): string[] {
	return capped(bashLines(text).map((line) => paint(theme, LINE_COLOR[line.kind] ?? "", line.text)));
}

/** The pretty body of a result, or undefined when the surface stays plain. */
export function prettyResult(
	toolName: string,
	text: string,
	args: Record<string, unknown> | undefined,
	theme: RenderTheme,
): string[] | undefined {
	if (toolName === "bash") return prettyBash(text, theme);
	if (toolName === "read") return prettyFile(typeof args?.path === "string" ? args.path : "read", text, theme);
	if (toolName === "ls" || toolName === "find") return prettyTree(text, theme);
	if (toolName === "grep") return prettyGrep(text, theme);
	return undefined;
}
