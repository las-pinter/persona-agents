/**
 * Sidebar theme, glyphs, and formatters — pure.
 *
 * The theme duck type, the dim style chain, the one glyph table, and the shared
 * number formatters. Every function is pure: no fs, no timers, no pi runtime
 * import. One glyph table serves the agent tree, the study stage, the MCP dot,
 * and the `/agents-tree` overlay tree, so a glyph is written in one place. The
 * panel renderers live in `sidebar-panels.ts`, and the paint-facing row code in
 * `sidebar-render.ts`.
 *
 * `sidebar-render.test.ts` runs under plain Node (type stripping).
 */

import type { TreeNodeStatus } from "./tree-model.ts";

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

/** One glyph and the theme token that colors it. */
interface GlyphMark {
	glyph: string;
	token: string;
}

/**
 * The mark for each tree node status. The record is keyed by the status type,
 * so a new status fails the typecheck until it has a glyph. The running glyph
 * here is the first spinner frame; `stateGlyph` steps the frame instead.
 */
const TREE_MARKS: Record<TreeNodeStatus, GlyphMark> = {
	idle: { glyph: "○", token: "dim" },
	running: { glyph: SPINNER_FRAMES[0], token: "accent" },
	done: { glyph: "✓", token: "success" },
	failed: { glyph: "✗", token: "error" },
	stale: { glyph: "⚠", token: "warning" },
};

/**
 * The one glyph table. The tree rows spread in first, keyed by the status type;
 * the orphan mark, the study stages, and the MCP dots follow, keyed by name.
 * The keys share one namespace: a study stage word that matches a tree or MCP
 * state borrows that glyph. One glyph is written once.
 */
const STATE_MARKS: Record<string, GlyphMark> = {
	...TREE_MARKS,
	orphan: { glyph: "?", token: "warning" },
	active: { glyph: "●", token: "accent" },
	blocked: { glyph: "⚠", token: "warning" },
	abandoned: { glyph: "✗", token: "dim" },
	connected: { glyph: "●", token: "success" },
	disconnected: { glyph: "○", token: "error" },
	unknown: { glyph: "◐", token: "warning" },
};

/** The mark for a state the table does not name: a dim `?`. */
const UNKNOWN_MARK: GlyphMark = { glyph: "?", token: "dim" };

/** The spinner glyph at `frame`. A non-finite frame gives the first frame. */
function spinnerGlyph(frame: number): string {
	if (!Number.isFinite(frame)) return SPINNER_FRAMES[0];
	const len = SPINNER_FRAMES.length;
	const index = ((Math.floor(frame) % len) + len) % len;
	return SPINNER_FRAMES[index];
}

/**
 * The colored glyph for one state name. A running state spins at `frame`. An
 * unrecognized state gives a dim `?`, so a stale snapshot never throws.
 */
export function stateGlyph(theme: SidebarTheme, state: string, frame: number = 0): string {
	if (state === "running") return color(theme, "accent", spinnerGlyph(frame));
	const mark = Object.hasOwn(STATE_MARKS, state) ? STATE_MARKS[state] : UNKNOWN_MARK;
	return color(theme, mark.token, mark.glyph);
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
