/**
 * The full-screen overlay components and the pure ask-log frame builder.
 *
 * `tree-ui.ts` mounts and disposes these; this module holds no module state and
 * reads no clock, file, or environment. Each component takes its data through a
 * getter, so a mount never captures a stale copy.
 *
 * Three components live here: the `/agents-tree` node list, the
 * `/agent-inspect` node detail, and the `/ask-log` history. The ask-log frame
 * math is pure and exported, so a test can feed it rows and numbers directly.
 */

import { Key, matchesKey, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	clipLine,
	renderNodeDetail,
	selectNext,
	selectPrev,
	statusIcon,
	type AskLogRow,
	type SidebarSnapshot,
	type SidebarTheme,
} from "./sidebar-render.ts";
import { findNode, flattenTree, type TreeNode } from "./tree-model.ts";

/** The `/ask-log` view height clamp, in view rows. */
export const MAX_ASK_VIEW_ROWS = 100;
/** The chrome allowance subtracted from the terminal height. */
export const ASK_FRAME_ROWS = 5;
/** The indentation every ask row carries. */
const ASK_ROW_INDENT = "  ";
/** The minimum wrap width, so a narrow terminal still wraps instead of clipping. */
const ASK_WRAP_MIN = 10;
/** The rule width cap, so a wide terminal keeps a readable rule. */
const ASK_RULE_MAX = 96;
/** The key scroll step for PgUp and PgDn. */
const ASK_PAGE_STEP = 15;

// --- /agents-tree overlay ---------------------------------------------------

/** The `/agents-tree` overlay: a node list plus `renderNodeDetail` for the selection. */
export class TreeOverlayComponent implements Component {
	wantsKeyRelease = false;
	private readonly tui: TUI;
	private readonly theme: SidebarTheme;
	private readonly getSnapshot: () => SidebarSnapshot;
	private readonly getFrame: () => number;
	private readonly done: () => void;
	private selectedId: string | null;

	constructor(
		tui: TUI,
		theme: SidebarTheme,
		getSnapshot: () => SidebarSnapshot,
		done: () => void,
		getFrame: () => number,
		initialId: string | null = null,
	) {
		this.tui = tui;
		this.theme = theme;
		this.getSnapshot = getSnapshot;
		this.done = done;
		this.getFrame = getFrame;
		this.selectedId = initialId;
	}

	handleInput(input: string): void {
		try {
			const ids = flattenTree(this.getSnapshot().tree).map((node) => node.runId);
			if (matchesKey(input, Key.escape) || input === "q" || input === "Q") {
				this.done();
				return;
			}
			if (matchesKey(input, Key.up)) {
				this.selectedId = selectPrev(ids, this.selectedId);
			} else if (matchesKey(input, Key.down)) {
				this.selectedId = selectNext(ids, this.selectedId);
			} else {
				return;
			}
			this.tui.requestRender();
		} catch {
			/* a key must never throw */
		}
	}

	// Render reads the live snapshot on every call, so there is no cached state to clear.
	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		try {
			const snapshot = this.getSnapshot();
			const nodes = flattenTree(snapshot.tree);
			if (this.selectedId === null && nodes.length > 0) this.selectedId = nodes[0].runId;

			lines.push(` AGENT TREE — ${nodes.length} node(s)`);
			lines.push("─".repeat(Math.max(0, Math.min(width - 1, 72))));
			if (nodes.length === 0) {
				lines.push("(no active agents)");
			} else {
				for (const node of nodes) {
					const mark = node.runId === this.selectedId ? "▶" : " ";
					const indent = "  ".repeat(Math.max(0, node.depth));
					const icon = statusIcon(node.status, this.getFrame());
					lines.push(` ${mark} ${indent}${icon} ${node.agent}  ${node.task}`);
				}
				lines.push("─".repeat(Math.max(0, Math.min(width - 1, 72))));
				const selected =
					(this.selectedId ? findNode(snapshot.tree, this.selectedId) : undefined) ?? nodes[0];
				if (selected) lines.push(...renderNodeDetail(selected, width, this.theme));
			}
			lines.push("↑/↓ select · q/Esc close");
		} catch {
			/* a render must never throw */
		}
		return lines.map((line) => clipLine(line, width));
	}
}

// --- /agent-inspect overlay -------------------------------------------------

/** The `/agent-inspect` overlay: one node's detail. */
export class NodeDetailComponent implements Component {
	wantsKeyRelease = false;
	private readonly theme: SidebarTheme;
	private readonly node: TreeNode;
	private readonly done: () => void;

	constructor(theme: SidebarTheme, node: TreeNode, done: () => void) {
		this.theme = theme;
		this.node = node;
		this.done = done;
	}

	handleInput(input: string): void {
		try {
			if (matchesKey(input, Key.escape) || input === "q" || input === "Q") this.done();
		} catch {
			/* a key must never throw */
		}
	}

	// The node and theme never change, so there is no cached render state to clear.
	invalidate(): void {}

	render(width: number): string[] {
		let lines: string[] = [];
		try {
			lines = renderNodeDetail(this.node, width, this.theme);
		} catch {
			lines = [];
		}
		lines.push("q/Esc close");
		return lines.map((line) => clipLine(line, width));
	}
}

// --- /ask-log overlay -------------------------------------------------------

/** One rule line, clipped to the width cap. */
function askRule(width: number): string {
	return "─".repeat(Math.max(0, Math.min(width - 1, ASK_RULE_MAX)));
}

/**
 * The wrapped body of the ask log: one row per event, newest first, each
 * wrapped to the width and indented two spaces. Pure. An empty ring is one
 * placeholder line, indented like a row so it lines up under the title.
 */
function askLogBodyLines(rows: AskLogRow[], width: number): string[] {
	if (rows.length === 0) return [`${ASK_ROW_INDENT}(no child asks)`];
	const wrapWidth = Math.max(ASK_WRAP_MIN, width - ASK_ROW_INDENT.length);
	const lines: string[] = [];
	for (const row of rows) {
		const text = typeof row.text === "string" ? row.text : "";
		for (const line of wrapTextWithAnsi(text, wrapWidth)) lines.push(`${ASK_ROW_INDENT}${line}`);
	}
	return lines;
}

/**
 * The `/ask-log` frame for one width, scroll offset, and view height: the
 * header, a rule, the wrapped rows, a rule, and the nav line. Every line is
 * clipped to the width. Pure: the caller supplies the rows and the numbers, and
 * this function reads no clock, file, or environment.
 */
export function askLogViewRows(
	rows: AskLogRow[] | null | undefined,
	width: number,
	offset = 0,
	viewHeight = MAX_ASK_VIEW_ROWS,
): string[] {
	const list = rows ?? [];
	const body = askLogBodyLines(list, width);
	const height = Math.max(1, Math.floor(viewHeight) || 1);
	// The tail must stay in view, so the offset stops at the last full page.
	const start = Math.min(Math.max(0, Math.floor(offset) || 0), Math.max(0, body.length - height));
	const lines = [
		`${ASK_ROW_INDENT}ASK LOG — ${list.length} events · newest first`,
		askRule(width),
		...body.slice(start, start + height),
		askRule(width),
		// The counter leads, so a narrow terminal cuts a key hint and not the position.
		`(line ${start + 1}/${body.length}) · ↑/↓/PgUp/PgDn scroll · g/G top/end · q/Esc close`,
	];
	return lines.map((line) => clipLine(line, width));
}

/** The view height for the terminal: the chrome rows are kept off the total. */
function askViewHeight(tui: TUI): number {
	let rows = 24;
	try {
		const value = tui.terminal?.rows ?? 24;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) rows = Math.floor(value);
	} catch {
		/* fall through to the default height */
	}
	return Math.max(5, Math.min(rows, MAX_ASK_VIEW_ROWS) - ASK_FRAME_ROWS);
}

/** The `/ask-log` overlay: the ask history, wrapped, scrolled by wrapped line. */
export class AskLogOverlayComponent implements Component {
	wantsKeyRelease = false;
	private readonly tui: TUI;
	private readonly getSnapshot: () => SidebarSnapshot;
	private readonly done: () => void;
	private offset = 0;
	/** The last render width, so a key press before the first paint still counts. */
	private width = 80;

	constructor(tui: TUI, getSnapshot: () => SidebarSnapshot, done: () => void) {
		this.tui = tui;
		this.getSnapshot = getSnapshot;
		this.done = done;
	}

	// The ring is read on every render, so there is no cached render state to clear.
	invalidate(): void {}

	/** The ring rows, never null. */
	private snapshotRows(): AskLogRow[] {
		return this.getSnapshot().askLog ?? [];
	}

	/** The wrapped body line count at the last render width. */
	private bodyCount(): number {
		return askLogBodyLines(this.snapshotRows(), this.width).length;
	}

	handleInput(input: string): void {
		try {
			if (matchesKey(input, Key.escape) || input === "q" || input === "Q") {
				this.done();
				return;
			}
			const maxOffset = Math.max(0, this.bodyCount() - askViewHeight(this.tui));
			if (matchesKey(input, Key.up)) this.offset = Math.max(0, this.offset - 1);
			else if (matchesKey(input, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
			else if (matchesKey(input, Key.pageUp)) this.offset = Math.max(0, this.offset - ASK_PAGE_STEP);
			else if (matchesKey(input, Key.pageDown)) this.offset = Math.min(maxOffset, this.offset + ASK_PAGE_STEP);
			else if (input === "g") this.offset = 0;
			else if (input === "G") this.offset = maxOffset;
			else return;
			this.tui.requestRender();
		} catch {
			/* a key must never throw */
		}
	}

	render(width: number): string[] {
		try {
			const w = Math.max(1, Math.floor(width) || 1);
			this.width = w;
			const rows = this.snapshotRows();
			const total = askLogBodyLines(rows, w).length;
			const viewHeight = askViewHeight(this.tui);
			// A resize or a shrinking ring must not leave the offset past the end.
			this.offset = Math.min(Math.max(0, this.offset), Math.max(0, total - viewHeight));
			return askLogViewRows(rows, w, this.offset, viewHeight);
		} catch {
			return [];
		}
	}
}
