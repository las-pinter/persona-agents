/**
 * Sidebar compositor — impure terminal surgery for the right column.
 *
 * The compositor owns the right column. It narrows `terminal.columns`, wraps
 * `tui.doRender`, and paints the panel lines from a `getLines` callback. It
 * does NOT import `sidebar-render.ts`, so the renderers stay pure and the
 * compositor stays decoupled.
 *
 * The "narrow columns + wrap doRender + paint a right column" technique is
 * implemented here. No upstream source was copied.
 *
 * The toggle config lives in `sidebar-config.ts`; this module re-exports the
 * symbols its callers import. It NEVER touches `settings.json`.
 *
 * `sidebar.test.ts` runs under plain Node with a fake terminal; no real TTY.
 */

import { SIDEBAR_DEFAULT_WIDTH, clampWidth } from "./sidebar-config.ts";
import { padLine } from "./sidebar-line.ts";
import { columnGeometry, mainColumns, windowFits, windowLines } from "./sidebar-window.ts";

export {
	SIDEBAR_CONFIG_ENV,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	defaultSidebarConfigPath,
	defaultSidebarEnabled,
	parseSidebarWidth,
	planSidebarWidthChange,
	readSidebarConfig,
	resolveSidebarEnabled,
	resolveSidebarWidth,
	toggleSidebarState,
	writeSidebarConfig,
} from "./sidebar-config.ts";

// --- terminal control sequences ---------------------------------------------

const SYNC_OPEN = "\x1b[?2026h";
const SYNC_CLOSE = "\x1b[?2026l";
const SYNC_MARKER_RE = /\x1b\[\?2026[hl]/g;
const ERASE_LINE = "\x1b[2K";
const CLEAR_SCREEN = "\x1b[2J";
const CLEAR_SCROLLBACK = "\x1b[3J";
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON = "\x1b[?7h";
const SEPARATOR = "│";

/** Terminal rows assumed when the terminal reports none. */
export const SIDEBAR_DEFAULT_ROWS = 24;

// --- structural types -------------------------------------------------------

/** Minimal terminal surface the compositor touches. */
export interface SidebarTerminal {
	columns: number;
	rows: number;
	write(data: string): void;
}

/**
 * Minimal TUI surface. `doRender` is `protected` on the real `TuiBase`, so it
 * is optional here; the glue casts at the call site.
 */
export interface SidebarTui {
	terminal?: SidebarTerminal;
	doRender?: (...args: unknown[]) => void;
}

/** A positive integer, or the fallback. */
function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

/** The scroll state the glue hands to the paint layer. */
export interface SidebarScrollOptions {
	/** The shared column scroll offset. Read at paint time, never cached. */
	getOffset?: () => number;
	/** The dim style of the hide marks. */
	dim?: (text: string) => string;
}

/** Find a property descriptor on the object or its prototype chain. */
function findPropertyDescriptor(target: object, key: string): PropertyDescriptor | undefined {
	let current: object | null = target;
	while (current !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current) as object | null;
	}
	return undefined;
}

// --- compositor -------------------------------------------------------------

/**
 * Paints a right column beside pi's main area.
 *
 * The constructor takes `getLines`, a callback that returns the panel lines.
 * The compositor never imports a renderer.
 */
export class SidebarCompositor {
	private readonly tui: SidebarTui;
	private readonly getLines: () => string[];
	private readonly getOffset: () => number;
	private readonly dim: (text: string) => string;
	/** The clamped right-column width. */
	readonly width: number;

	private disposed = false;
	private installed = false;

	private readonly rowCache: string[] = [];
	/** Set when pi writes a full-screen clear; forces the next paint to repaint all rows. */
	private forceFullPaint = false;
	private lastRawCols = 0;
	private lastRawRows = 0;
	private lastWidth = 0;
	private painting = false;

	private ownColumnsDescriptor: PropertyDescriptor | undefined;
	private rawColumnsGetter: (() => unknown) | undefined;
	private capturedRawColumns = SIDEBAR_DEFAULT_WIDTH;

	private originalWrite: ((data: string) => void) | undefined;

	private ownDoRenderDescriptor: PropertyDescriptor | undefined;
	private originalDoRender: ((...args: unknown[]) => void) | undefined;

	constructor(
		tui: SidebarTui,
		getLines: () => string[],
		width = SIDEBAR_DEFAULT_WIDTH,
		scroll: SidebarScrollOptions = {},
	) {
		this.tui = tui;
		this.getLines = getLines;
		this.width = clampWidth(width);
		this.getOffset = scroll.getOffset ?? (() => 0);
		this.dim = scroll.dim ?? ((text: string) => text);
	}

	/** Narrow the terminal and wrap pi's render. Safe to call twice. */
	install(): void {
		if (this.disposed || this.installed) return;
		const tui = this.tui;
		const terminal = tui.terminal;

		this.originalDoRender = tui.doRender;
		this.ownDoRenderDescriptor = Object.getOwnPropertyDescriptor(tui, "doRender");

		if (terminal) {
			this.ownColumnsDescriptor = Object.getOwnPropertyDescriptor(terminal, "columns");
			this.rawColumnsGetter = findPropertyDescriptor(terminal, "columns")?.get as
				| (() => unknown)
				| undefined;
			this.capturedRawColumns = positiveInt(terminal.columns, SIDEBAR_DEFAULT_WIDTH);
			this.originalWrite =
				typeof terminal.write === "function" ? terminal.write : undefined;

			try {
				Object.defineProperty(terminal, "columns", {
					configurable: true,
					enumerable: this.ownColumnsDescriptor?.enumerable ?? true,
					get: () => mainColumns(this.rawColumns(), this.width),
				});
			} catch {
				// A non-configurable terminal is left alone.
			}
		}

		const wrapped = (...args: unknown[]): void => this.renderWrapped(args);
		try {
			tui.doRender = wrapped;
		} catch {
			// A frozen tui object is left alone.
		}
		this.installed = true;
	}

	/** Restore the terminal and pi's render. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		const terminal = this.tui.terminal;
		if (terminal) {
			this.restoreErase(terminal);
			try {
				if (this.ownColumnsDescriptor) {
					Object.defineProperty(terminal, "columns", this.ownColumnsDescriptor);
				} else {
					delete (terminal as { columns?: number }).columns;
				}
			} catch {
				// Best effort: a locked property cannot be restored.
			}
		}

		try {
			if (this.ownDoRenderDescriptor) {
				Object.defineProperty(this.tui, "doRender", this.ownDoRenderDescriptor);
			} else {
				delete (this.tui as { doRender?: unknown }).doRender;
			}
		} catch {
			// Best effort: a locked property cannot be restored.
		}

		this.rowCache.length = 0;
		this.installed = false;
	}

	/** Repaint the right column. Never throws. */
	paint(): void {
		try {
			this.paintInternal();
		} catch {
			// A paint must never break pi.
		}
	}

	/** The rows this paint layer owns, which is the height of one column window. */
	visibleRows(): number {
		return this.rawRows();
	}

	// --- internals ----------------------------------------------------------

	/** The true terminal width, before the narrowing getter. */
	private rawColumns(): number {
		const getter = this.rawColumnsGetter;
		if (getter) {
			try {
				return positiveInt(getter.call(this.tui.terminal), this.capturedRawColumns);
			} catch {
				// Fall back to the value captured at install time.
			}
		}
		return this.capturedRawColumns;
	}

	/** The terminal height, with a `process.stdout` fallback. */
	private rawRows(): number {
		const rows = this.tui.terminal?.rows ?? process.stdout.rows;
		return positiveInt(rows, SIDEBAR_DEFAULT_ROWS);
	}

	/** Write raw text to the terminal, if one exists. */
	private writeRaw(data: string): void {
		const terminal = this.tui.terminal;
		if (!terminal || typeof terminal.write !== "function") return;
		terminal.write(data);
	}

	/**
	 * Replace pi's full-line erase with a bounded erase, so pi cannot wipe the
	 * sidebar columns. Restored in `renderWrapped`'s `finally`.
	 */
	private replaceErase(terminal: SidebarTerminal): void {
		const original = this.originalWrite;
		if (!original) return;
		const mainWidth = mainColumns(this.rawColumns(), this.width);
		try {
			terminal.write = (data: string): void => {
				const safe = typeof data === "string" ? data : String(data ?? "");
				// A full-screen clear wipes the sidebar. Force the next paint to
				// repaint every row, because the row diff cannot see the wipe.
				if (safe.includes(CLEAR_SCREEN) || safe.includes(CLEAR_SCROLLBACK)) {
					this.forceFullPaint = true;
				}
				// The outer frame owns synchronized output. Drop pi's nested
				// markers so its inner close cannot end the frame early.
				const out = (safe.includes(ERASE_LINE)
					? safe.split(ERASE_LINE).join(`\x1b[${mainWidth}X`)
					: safe
				).replace(SYNC_MARKER_RE, "");
				original.call(terminal, out);
			};
		} catch {
			// A frozen terminal is left alone.
		}
	}

	/** Restore the original `terminal.write`. */
	private restoreErase(terminal: SidebarTerminal): void {
		const original = this.originalWrite;
		if (!original) return;
		try {
			terminal.write = original;
		} catch {
			// A frozen terminal is left alone.
		}
	}

	/**
	 * The wrapped `tui.doRender`: one synchronized-output frame around pi's
	 * render, an erase-bounded main area, and a paint after pi succeeds. A paint
	 * error is swallowed; pi's own render error is rethrown.
	 */
	private renderWrapped(args: unknown[]): void {
		const terminal = this.tui.terminal;
		let piThrew = false;
		let piError: unknown;

		try {
			this.writeRaw(SYNC_OPEN);
			if (terminal) this.replaceErase(terminal);
			try {
				const original = this.originalDoRender;
				if (original) original.apply(this.tui, args);
			} catch (error) {
				piThrew = true;
				piError = error;
			}
			if (!piThrew) {
				try {
					this.paintInternal();
				} catch {
					// A paint must never break pi's render.
				}
			}
		} finally {
			if (terminal) this.restoreErase(terminal);
			try {
				this.writeRaw(SYNC_CLOSE);
			} catch {
				// The terminal may already be gone.
			}
		}

		if (piThrew) throw piError;
	}

	/** Read the panel lines, coerced to strings. */
	private readLineList(): string[] {
		const value = this.getLines();
		if (!Array.isArray(value)) return [];
		return value.map((line) => (typeof line === "string" ? line : String(line ?? "")));
	}

	/**
	 * Paint only the rows whose formatted line changed. A no-row-change paint
	 * writes nothing. May throw; `paint()` and `renderWrapped` swallow that.
	 */
	private paintInternal(): void {
		if (this.disposed || this.painting) return;
		const terminal = this.tui.terminal;
		if (!terminal) return;

		this.painting = true;
		try {
			const rawCols = this.rawColumns();
			const rawRows = this.rawRows();
			// Below the window floor one mark and one line cannot both fit, so no
			// column paints and none is lost in silence.
			const geometry = columnGeometry(rawCols, this.width);
			if (!geometry || !windowFits(rawRows)) return;

			const { sepCol, sidebarCol } = geometry;

			if (this.forceFullPaint) {
				this.rowCache.length = 0;
				this.lastRawCols = 0;
				this.lastRawRows = 0;
				this.lastWidth = 0;
				this.forceFullPaint = false;
			}

			const lines = windowLines(
				this.readLineList(),
				this.getOffset(),
				rawRows,
				this.dim,
			);
			// Pad to every terminal row, so the separator spans the full height and
			// a row with no panel line is blanked instead of left stale.
			const formatted: string[] = [];
			for (let i = 0; i < rawRows; i++) {
				formatted.push(padLine(i < lines.length ? lines[i] : "", this.width));
			}

			if (
				this.lastRawCols !== rawCols ||
				this.lastRawRows !== rawRows ||
				this.lastWidth !== this.width
			) {
				this.rowCache.length = 0;
				this.lastRawCols = rawCols;
				this.lastRawRows = rawRows;
				this.lastWidth = this.width;
			}

			const total = Math.min(rawRows, Math.max(formatted.length, this.rowCache.length));
			const parts: string[] = [];
			let changed = false;
			for (let i = 0; i < total; i++) {
				const next = i < formatted.length ? formatted[i] : "";
				if (this.rowCache[i] === next) continue;
				this.rowCache[i] = next;
				changed = true;
				const row = i + 1;
				parts.push(`\x1b[${row};${sepCol}H`, SEPARATOR, `\x1b[${row};${sidebarCol}H`, next);
			}
			if (this.rowCache.length > total) this.rowCache.length = total;

			if (!changed || parts.length === 0) return;
			this.writeRaw(`${SAVE_CURSOR}${WRAP_OFF}${parts.join("")}${WRAP_ON}${RESTORE_CURSOR}`);
		} finally {
			this.painting = false;
		}
	}
}

// --- teardown ---------------------------------------------------------------

/** The active compositor installed by the glue, if any. */
let activeCompositor: SidebarCompositor | null = null;

/** The installed compositor, or null. */
export function getSidebarCompositor(): SidebarCompositor | null {
	return activeCompositor;
}

/**
 * Create and install the module's compositor. Replaces any current one.
 * Never throws.
 */
export function installSidebarCompositor(
	tui: SidebarTui,
	getLines: () => string[],
	width = SIDEBAR_DEFAULT_WIDTH,
	scroll: SidebarScrollOptions = {},
): SidebarCompositor {
	disposeSidebarCompositor();
	const compositor = new SidebarCompositor(tui, getLines, width, scroll);
	try {
		compositor.install();
	} catch {
		// An install failure must never break the session.
	}
	activeCompositor = compositor;
	return compositor;
}

/** Dispose the module's compositor. Idempotent, never throws. */
export function disposeSidebarCompositor(): void {
	const compositor = activeCompositor;
	activeCompositor = null;
	if (!compositor) return;
	try {
		compositor.dispose();
	} catch {
		// Dispose is best effort.
	}
}

