/**
 * Sidebar glue — binds the compositor, the data module, the command module,
 * and the lifecycle.
 *
 * `registerTreeUi(pi)` registers the scroll keys, calls
 * `registerTreeCommands(pi, host)`, and installs the `session_start` binding.
 * The four command bodies live in `tree-commands.ts`, and each reaches this
 * module through the host handle. `bindTreeSidebar(ctx)` captures the `tui`
 * and the `theme`, creates the data module, and installs the compositor in TUI
 * mode (or a bounded `string[]` summary in RPC mode). `disposeTreeSidebar()`
 * tears it all down and is called from `session_shutdown`.
 *
 * The overlay components and the pure ask-log frame builder live in
 * `overlays.ts`. This module mounts them and holds the frame the tree overlay
 * paints.
 *
 * TUI binding uses a `belowEditor` anchor widget whose component renders `[]`.
 * The widget paints nothing. It only exists to hand us the `tui` object through
 * the widget factory, so the compositor can wrap `tui.doRender`. The built-in
 * footer is never replaced.
 *
 * The data module owns every git read, including the branch. It publishes the
 * branch in the workspace snapshot, and the glue repaints when the signature
 * changes.
 *
 * Every timer body, render call, and command handler is wrapped so the TUI
 * never crashes in any mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { AskLogOverlayComponent, NodeDetailComponent, TreeOverlayComponent } from "./overlays.ts";
import {
	TREE_POLL_MS,
	createSidebarData,
	type SidebarData,
} from "./sidebar-data.ts";
import {
	SIDEBAR_DEFAULT_ROWS,
	SIDEBAR_DEFAULT_WIDTH,
	disposeSidebarCompositor,
	getSidebarCompositor,
	installSidebarCompositor,
	resolveSidebarEnabled,
	resolveSidebarWidth,
} from "./sidebar.ts";
import { clampScrollOffset, windowLines } from "./sidebar-window.ts";
import { renderSidebarPanel } from "./sidebar-panels.ts";
import { hasRunningNode } from "./sidebar-render.ts";
import type { SidebarTheme } from "./sidebar-theme.ts";
import type { SidebarSnapshot } from "./sidebar-types.ts";
import { registerTreeCommands } from "./tree-commands.ts";
import type { TreeNode } from "./tree-model.ts";
import { treeSignature } from "./tree-signature.ts";

/** Spinner tick cadence while a node runs. */
export const SPINNER_MS = 90;
/** Bounded RPC summary height: RPC mode gets a string list, never a full column. */
export const RPC_MAX_LINES = 10;
/** RPC summary render width. */
export const RPC_WIDTH = 60;

/** Widget key. Holds the TUI anchor component or the RPC `string[]` summary. */
const WIDGET_KEY = "persona-agents-tree";

/** Identity theme for RPC and any missing-theme fallback. */
const IDENTITY_THEME: SidebarTheme = { bold: (text) => text, dim: (text) => text };

// --- module state -----------------------------------------------------------

let piRef: ExtensionAPI | null = null;
let data: SidebarData | null = null;
let boundCtx: ExtensionContext | null = null;
let capturedTui: TUI | null = null;
let capturedTheme: SidebarTheme | null = null;
/** The bound mode: "tui", "rpc", or "" when not bound. */
let mode = "";
let bound = false;
let disposed = false;
/**
 * True once every registration ran. A dead pi API throws on a registration,
 * and a column that no command can reach must not paint.
 */
let registered = false;
/** The right-column width, kept in step with the compositor and the renderer. */
let resolvedWidth = SIDEBAR_DEFAULT_WIDTH;
/**
 * The shared column scroll offset. One number for the whole column, used by the
 * paint layer and by the RPC summary.
 */
let scrollOffset = 0;
/** A refusal report held until a context can show it, then cleared. */
let scrollReport: string | null = null;

/** Spinner animation frame. */
let frame = 0;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
/** Last painted content signature; a paint happens only on change. */
let lastSignature: string | null = null;
/** Last spinner-rendered lines; a spinner render happens only on change. */
let lastSpinnerLines = "";

/** The theme duck type for the renderers, or the identity fallback. */
function themeDuck(): SidebarTheme {
	return capturedTheme ?? IDENTITY_THEME;
}

/** Dim text for the column marks. Falls back to plain text, never throws. */
function dimText(text: string): string {
	const theme = capturedTheme;
	if (!theme || typeof theme.dim !== "function") return text;
	try {
		return theme.dim(text);
	} catch {
		return text;
	}
}

/** The rows one column window holds: the paint layer's rows, or the RPC cap. */
function visibleColumnRows(): number {
	const compositor = getSidebarCompositor();
	if (compositor) return compositor.visibleRows();
	if (mode === "rpc") return RPC_MAX_LINES;
	return SIDEBAR_DEFAULT_ROWS;
}

/**
 * Move the column window by `delta` rows and repaint. The tree signature does
 * not move with the offset, so the paint is asked for here, not by the poll.
 */
function scrollColumn(delta: number): void {
	try {
		const total = getLines().length;
		scrollOffset = clampScrollOffset(scrollOffset + delta, total, visibleColumnRows());
		if (mode === "rpc") {
			const snapshot = data?.snapshot();
			if (snapshot) updateRpcWidget(snapshot);
		} else {
			requestRender();
		}
	} catch {
		/* a scroll must never break pi */
	}
}

/** Render the full right column at the current terminal width. */
function buildLines(snapshot: SidebarSnapshot): string[] {
	try {
		return renderSidebarPanel(snapshot, resolvedWidth, themeDuck(), frame);
	} catch {
		return [];
	}
}

/** The compositor's line source. Stable, so install can capture it once. */
function getLines(): string[] {
	try {
		if (!data) return [];
		return buildLines(data.snapshot());
	} catch {
		return [];
	}
}

/** Ask pi for a render. Never throws. */
function requestRender(): void {
	try {
		capturedTui?.requestRender();
	} catch {
		/* a repaint request must never break pi */
	}
}

/** Install the compositor, if the tui and data are available. Never throws. */
function installCompositor(): void {
	try {
		if (!capturedTui || !data) return;
		installSidebarCompositor(capturedTui, getLines, resolvedWidth, {
			getOffset: () => scrollOffset,
			dim: dimText,
		});
	} catch {
		/* an install failure must never break the session */
	}
}

/** Set the bounded RPC summary widget. Degrades to nothing on error. */
function updateRpcWidget(snapshot: SidebarSnapshot): void {
	try {
		const ui = boundCtx?.ui;
		if (!ui?.setWidget) return;
		const lines = renderSidebarPanel(snapshot, RPC_WIDTH, IDENTITY_THEME, frame);
		const summary = lines.length > 0 ? lines : ["(no agents)"];
		const window = windowLines(summary, scrollOffset, RPC_MAX_LINES, dimText);
		ui.setWidget(WIDGET_KEY, window, { placement: "belowEditor" });
	} catch {
		/* degrade to nothing */
	}
}

/** Start the spinner tick if it is not running. */
function ensureSpinner(): void {
	if (spinnerTimer) return;
	try {
		spinnerTimer = setInterval(spinnerTick, SPINNER_MS);
	} catch {
		spinnerTimer = null;
	}
}

/** Stop the spinner tick. */
function stopSpinner(): void {
	if (!spinnerTimer) return;
	try {
		clearInterval(spinnerTimer);
	} catch {
		/* already cleared */
	}
	spinnerTimer = null;
}

/**
 * The spinner tick: advance the frame and request a render only when a
 * rendered line changed. Stops itself when no node runs.
 */
function spinnerTick(): void {
	try {
		if (!data || mode !== "tui") {
			stopSpinner();
			return;
		}
		const snapshot = data.snapshot();
		if (!hasRunningNode(snapshot.tree ?? [])) {
			stopSpinner();
			return;
		}
		frame += 1;
		const joined = buildLines(snapshot).join("\n");
		if (joined !== lastSpinnerLines) {
			lastSpinnerLines = joined;
			requestRender();
		}
	} catch {
		stopSpinner();
	}
}

/**
 * The 500 ms pull: repaint only when the content signature changes and keep
 * the spinner state in step. The signature carries the branch, so a checkout
 * repaints here.
 */
// Two 500 ms polls are intentional: the data module reads the log; this glue compares the signature.
function pull(): void {
	try {
		if (!data) return;
		const snapshot = data.snapshot();
		const signature = treeSignature(snapshot);
		if (signature !== lastSignature) {
			lastSignature = signature;
			if (mode === "rpc") updateRpcWidget(snapshot);
			else requestRender();
		}
		if (mode === "tui") {
			if (hasRunningNode(snapshot.tree ?? [])) ensureSpinner();
			else stopSpinner();
		}
	} catch {
		/* a timer body must never throw */
	}
}

/** Start the single pull timer. */
function startTimers(): void {
	stopTimers();
	try {
		pullTimer = setInterval(pull, TREE_POLL_MS);
	} catch {
		pullTimer = null;
	}
}

/** Clear the pull timer and the spinner tick. */
function stopTimers(): void {
	if (pullTimer) {
		try {
			clearInterval(pullTimer);
		} catch {
			/* already cleared */
		}
		pullTimer = null;
	}
	stopSpinner();
}

// --- overlay mounts ---------------------------------------------------------

/** Open the live tree overlay. The caller has checked `ctx.mode === "tui"`. */
async function openTreeOverlay(ctx: ExtensionContext): Promise<void> {
	const boundData = data;
	if (!boundData) {
		ctx.ui?.notify?.("Agent tree is not ready yet.", "info");
		return;
	}
	await ctx.ui.custom(
		(_tui, _theme, _keybindings, done) =>
			new TreeOverlayComponent(
				_tui,
				_theme,
				() => boundData.snapshot(),
				() => done(undefined),
				() => frame,
			),
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: { top: 0 } },
		},
	);
}

/** Open one node's detail overlay. The caller has checked `ctx.mode === "tui"`. */
async function openNodeOverlay(ctx: ExtensionContext, node: TreeNode): Promise<void> {
	await ctx.ui.custom(
		(_tui, _theme, _keybindings, done) => new NodeDetailComponent(_theme, node, () => done(undefined)),
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: { top: 0 } },
		},
	);
}

/** Open the ask log overlay. The caller has checked `ctx.mode === "tui"`. */
async function openAskLogOverlay(ctx: ExtensionContext): Promise<void> {
	const boundData = getSidebarData();
	if (!boundData) {
		ctx.ui?.notify?.("Ask log is not ready yet.", "info");
		return;
	}
	await ctx.ui.custom(
		(_tui, _theme, _keybindings, done) =>
			new AskLogOverlayComponent(
				_tui,
				() => boundData.snapshot(),
				() => done(undefined),
			),
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: { top: 0 } },
		},
	);
}

// --- binding and lifecycle --------------------------------------------------

/** Bind the data module and the compositor once. Never throws. */
export function bindTreeSidebar(ctx: ExtensionContext): void {
	if (bound || !registered) return;
	try {
		if (!piRef || !ctx?.ui) return;
		flushScrollReport(ctx);

		// RPC: no compositor and no `tui`. A bounded `string[]` summary only.
		if (ctx.mode === "rpc") {
			if (!data) data = createSidebarData(piRef);
			boundCtx = ctx;
			mode = ctx.mode;
			disposed = false;
			data.subscribe(ctx);
			updateRpcWidget(data.snapshot());
			startTimers();
			bound = true;
			return;
		}

		// JSON/print and every other mode: nothing renders.
		if (ctx.mode !== "tui") return;

		// Capture `tui` + `theme` through the anchor widget factory. The widget
		// renders [] on purpose: it exists only to hand over the tui object.
		const anchor: Component & { dispose?(): void } = {
			render: () => [],
			invalidate: () => {},
			dispose: () => {
				// pi clears widgets on shutdown/reload; restore the terminal first.
				disposeSidebarCompositor();
			},
		};
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				capturedTui = tui;
				capturedTheme = theme;
				return anchor;
			},
			{ placement: "belowEditor" },
		);

		if (!capturedTui) {
			// No tui object means the compositor cannot wrap `doRender`.
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		if (!data) data = createSidebarData(piRef);
		boundCtx = ctx;
		mode = ctx.mode;
		disposed = false;
		resolvedWidth = resolveSidebarWidth();
		data.subscribe(ctx);

		if (resolveSidebarEnabled(ctx.mode)) installCompositor();
		startTimers();
		bound = true;
	} catch {
		/* binding must never break a session */
	}
}

/** The live data module, or null before the bind. The overlays read the snapshot here. */
export function getSidebarData(): SidebarData | null {
	return data;
}

/** Bind if needed, for a command that needs live data. Never throws. */
function ensureBound(ctx: ExtensionContext): void {
	try {
		if (!bound) bindTreeSidebar(ctx);
	} catch {
		/* best effort */
	}
}

/**
 * Tear everything down: both timers, the data module, the compositor, and the
 * widget. Idempotent. Never throws.
 */
export function disposeTreeSidebar(): void {
	if (disposed) return;
	disposed = true;
	try {
		stopTimers();
	} catch {
		/* best effort */
	}
	try {
		data?.dispose();
	} catch {
		/* best effort */
	}
	data = null;
	try {
		disposeSidebarCompositor();
	} catch {
		/* best effort */
	}
	try {
		const ui = boundCtx?.ui;
		if (ui?.setWidget) ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		/* best effort */
	}
	capturedTui = null;
	capturedTheme = null;
	boundCtx = null;
	bound = false;
	mode = "";
	resolvedWidth = SIDEBAR_DEFAULT_WIDTH;
	scrollOffset = 0;
	scrollReport = null;
	lastSignature = null;
	lastSpinnerLines = "";
	frame = 0;
}

// --- registration -----------------------------------------------------------

/** The primary scroll keys: down one line, up one line. */
const PRIMARY_SCROLL_KEYS: Array<[KeyId, string, number]> = [
	[Key.altShift("j"), "Scroll the sidebar column down one line", 1],
	[Key.altShift("k"), "Scroll the sidebar column up one line", -1],
];

/**
 * The fallback scroll keys. pi settles a key clash after registration and can
 * skip a binding in silence, so this pair is always bound as a backup.
 */
const FALLBACK_SCROLL_KEYS: Array<[KeyId, string, number]> = [
	[Key.alt("j"), "Scroll the sidebar column down one line (fallback)", 1],
	[Key.alt("k"), "Scroll the sidebar column up one line (fallback)", -1],
];

/** The key pair names for the log line. */
const PRIMARY_PAIR_LABEL = "alt+shift+j/k";
const FALLBACK_PAIR_LABEL = "alt+j/k";

/**
 * One report line naming the scroll keys that bound. Empty names both pairs.
 *
 * @internal The refusal tests call this.
 */
export function scrollKeyReport(bound: KeyId[]): string {
	if (bound.length === 0) {
		return `sidebar: no scroll keys bound; ${PRIMARY_PAIR_LABEL} and ${FALLBACK_PAIR_LABEL} are unavailable`;
	}
	return `sidebar: scroll keys bound: ${bound.join(", ")}`;
}

/**
 * Register one scroll key pair and return the keys that bound. Try every key,
 * so one refusal does not prevent the other key from binding.
 */
function registerKeyPair(pi: ExtensionAPI, keys: Array<[KeyId, string, number]>): KeyId[] {
	const bound: KeyId[] = [];
	for (const [key, description, delta] of keys) {
		try {
			pi.registerShortcut(key, {
				description,
				handler: () => {
					scrollColumn(delta);
				},
			});
			bound.push(key);
		} catch {
			/* a refused key must not stop the rest of the pair */
		}
	}
	return bound;
}

/**
 * Register both scroll key pairs and hold one report of the keys that bound.
 * A half pair cannot come from pi in practice, but the collection is cheap.
 */
function registerScrollShortcuts(pi: ExtensionAPI): void {
	scrollOffset = 0;
	scrollReport = null;
	const bound = [
		...registerKeyPair(pi, PRIMARY_SCROLL_KEYS),
		...registerKeyPair(pi, FALLBACK_SCROLL_KEYS),
	];
	const all = PRIMARY_SCROLL_KEYS.length + FALLBACK_SCROLL_KEYS.length;
	if (bound.length < all) scrollReport = scrollKeyReport(bound);
}

/** Show the refusal report once the extension has a context, then clear it. */
function flushScrollReport(ctx: ExtensionContext): void {
	if (!scrollReport) return;
	const text = scrollReport;
	scrollReport = null;
	try {
		ctx.ui?.notify?.(text, "warning");
	} catch {
		/* a report must never break a bind */
	}
}

/**
 * Register the scroll keys, the tree commands, and the `session_start`
 * binding. The four command bodies live in `tree-commands.ts`.
 */
export function registerTreeUi(pi: ExtensionAPI): void {
	piRef = pi;
	registered = false;
	registerScrollShortcuts(pi);

	registerTreeCommands(pi, {
		snapshot: () => data?.snapshot() ?? null,
		getWidth: () => resolvedWidth,
		setWidth: (width) => {
			resolvedWidth = width;
		},
		ensureBound,
		scrollColumn,
		installCompositor,
		requestRender,
		openTreeOverlay,
		openNodeOverlay,
		openAskLogOverlay,
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			if (ctx.mode === "tui") {
				if (resolveSidebarEnabled(ctx.mode)) bindTreeSidebar(ctx);
			} else if (ctx.hasUI && ctx.mode === "rpc") {
				// RPC shows the read-only summary; config gates only the compositor.
				bindTreeSidebar(ctx);
			}
		} catch {
			/* a session start must never break */
		}
	});
	registered = true;
}
