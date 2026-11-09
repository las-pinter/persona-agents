/**
 * Sidebar glue — binds the compositor, the data module, the commands, and the
 * lifecycle.
 *
 * `registerTreeUi(pi)` registers `/sidebar`, `/agents-tree`, `/agent-inspect`,
 * and `/ask-log`. `bindTreeSidebar(ctx)` captures the `tui` and the `theme`,
 * creates the data module, and installs the compositor in TUI mode (or a
 * bounded `string[]` summary in RPC mode). `disposeTreeSidebar()` tears it all
 * down and is called from `session_shutdown`.
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
 * The git branch is read with `pi.exec("git", ["branch", "--show-current"])`,
 * not from a `setFooter` factory. Replacing the footer risks breaking the
 * built-in footer, so the glue runs git itself on the git cadence and pushes
 * the branch into `setBranch`.
 *
 * Every timer body, render call, and command handler is wrapped so the TUI
 * never crashes in any mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import { AskLogOverlayComponent, NodeDetailComponent, TreeOverlayComponent } from "./overlays.ts";
import {
	GIT_POLL_MS,
	TREE_POLL_MS,
	createSidebarData,
	type SidebarData,
} from "./sidebar-data.ts";
import {
	SIDEBAR_DEFAULT_WIDTH,
	disposeSidebarCompositor,
	getSidebarCompositor,
	installSidebarCompositor,
	planSidebarWidthChange,
	resolveSidebarEnabled,
	resolveSidebarWidth,
	toggleSidebarState,
	writeSidebarConfig,
} from "./sidebar.ts";
import {
	hasRunningNode,
	renderSidebarPanel,
	type SidebarSnapshot,
	type SidebarTheme,
} from "./sidebar-render.ts";
import { flattenTree, type TreeNode } from "./tree-model.ts";
import { treeSignature } from "./tree-signature.ts";

/** Spinner tick cadence while a node runs. */
export const SPINNER_MS = 90;
/** Git branch command timeout. */
const GIT_TIMEOUT_MS = 2000;
/** Bounded RPC summary height: RPC mode gets a short string, never a full column. */
const RPC_MAX_LINES = 10;
/** RPC summary render width. */
const RPC_WIDTH = 60;

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
/** The right-column width, kept in step with the compositor and the renderer. */
let resolvedWidth = SIDEBAR_DEFAULT_WIDTH;

/** Spinner animation frame. */
let frame = 0;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
/** Last painted content signature; a paint happens only on change. */
let lastSignature: string | null = null;
/** Last spinner-rendered lines; a spinner render happens only on change. */
let lastSpinnerLines = "";
/** Git branch cadence bookkeeping. */
let lastBranchFetch = 0;
let branchInFlight = false;

/** The theme duck type for the renderers, or the identity fallback. */
function themeDuck(): SidebarTheme {
	return capturedTheme ?? IDENTITY_THEME;
}

/** The terminal height at paint time, with a `process.stdout` fallback. */
function terminalHeight(): number {
	try {
		const rows = capturedTui?.terminal?.rows ?? process.stdout.rows;
		if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) return Math.floor(rows);
	} catch {
		/* fall through to the default */
	}
	return 24;
}

/** Render the full right column for the current terminal size. */
function buildLines(snapshot: SidebarSnapshot): string[] {
	try {
		return renderSidebarPanel(snapshot, resolvedWidth, terminalHeight(), themeDuck(), frame);
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
		installSidebarCompositor(capturedTui, getLines, resolvedWidth);
	} catch {
		/* an install failure must never break the session */
	}
}

/** Set the bounded RPC summary widget. Degrades to nothing on error. */
function updateRpcWidget(snapshot: SidebarSnapshot): void {
	try {
		const ui = boundCtx?.ui;
		if (!ui?.setWidget) return;
		const lines = renderSidebarPanel(snapshot, RPC_WIDTH, RPC_MAX_LINES, IDENTITY_THEME, frame);
		const summary = lines.length > 0 ? lines : ["(no agents)"];
		ui.setWidget(WIDGET_KEY, summary.slice(0, RPC_MAX_LINES), { placement: "belowEditor" });
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
 * Read the git branch without replacing the built-in footer. Throttled to the
 * git cadence and pushed into the data module.
 */
async function refreshBranch(): Promise<void> {
	const now = Date.now();
	if (branchInFlight || now - lastBranchFetch < GIT_POLL_MS) return;
	const cwd = boundCtx?.cwd;
	if (!piRef || !cwd || !data) return;
	lastBranchFetch = now;
	branchInFlight = true;
	try {
		const result = await piRef.exec("git", ["branch", "--show-current"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		const branch = result && result.code === 0 ? String(result.stdout ?? "").trim() : "";
		data.setBranch(branch.length > 0 ? branch : null);
	} catch {
		try {
			data?.setBranch(null);
		} catch {
			/* never throw from a timer */
		}
	} finally {
		branchInFlight = false;
	}
}

/**
 * The 500 ms pull: repaint only when the content signature changes, keep the
 * spinner state in step, and refresh the git branch.
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
		void refreshBranch();
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

/** The newest node by start time. */
function newestNode(nodes: TreeNode[]): TreeNode {
	let newest = nodes[0];
	for (const node of nodes) {
		if (Date.parse(node.startedAt) >= Date.parse(newest.startedAt)) newest = node;
	}
	return newest;
}

/** The plain-text overlay error message. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	if (bound) return;
	try {
		if (!piRef || !ctx?.ui) return;

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
	lastSignature = null;
	lastSpinnerLines = "";
	frame = 0;
}

// --- registration -----------------------------------------------------------

/** Register the tree commands and the `session_start` binding. */
export function registerTreeUi(pi: ExtensionAPI): void {
	piRef = pi;

	pi.registerCommand("sidebar", {
		description: "Show or hide the persona-agents sidebar, or set its width (usage: /sidebar [on|off|width <n>])",
		handler: async (args: string, ctx) => {
			try {
				const arg = args.trim().toLowerCase();
				const current = resolveSidebarEnabled(ctx.mode);
				let enabled: boolean;
				if (arg === "on") enabled = true;
				else if (arg === "off") enabled = false;
				else if (arg === "") enabled = !current;
				else {
					const parts = arg.split(/\s+/);
					if (parts[0] === "width") {
						const plan = planSidebarWidthChange(parts.slice(1), resolvedWidth);
						if (!plan.ok) {
							ctx.ui?.notify?.(plan.message, "warning");
							return;
						}
						resolvedWidth = plan.width;
						const write = writeSidebarConfig(current, undefined, plan.width);
						// The compositor captures its width at install time, so a live
						// change needs a dispose + reinstall (install does both). Repaint
						// right away so the new width shows without waiting for the tick.
						if (plan.shouldReinstall && ctx.mode === "tui" && getSidebarCompositor() !== null) {
							installCompositor();
							requestRender();
						}
						const persisted = write.ok ? "" : ` (not persisted: ${write.error ?? "write failed"})`;
						ctx.ui?.notify?.(`Sidebar width ${plan.width}${persisted}.`, write.ok ? "info" : "warning");
						return;
					}
					ctx.ui?.notify?.(
						`Unknown option "${arg}". Use /sidebar [on|off] or /sidebar width <n>.`,
						"warning",
					);
					return;
				}

				const installed = getSidebarCompositor() !== null;
				const plan = toggleSidebarState(enabled, ctx.mode, installed);
				// Re-read the width from disk so the live compositor matches disk. A
				// width changed by another window must not leave the cached value stale.
				resolvedWidth = resolveSidebarWidth();
				const write = writeSidebarConfig(plan.enabled, undefined, resolvedWidth);

				if (plan.shouldInstall && ctx.mode === "tui") {
					ensureBound(ctx);
					installCompositor();
				} else if (plan.shouldDispose) {
					disposeSidebarCompositor();
				}

				const persisted = write.ok ? "" : ` (not persisted: ${write.error ?? "write failed"})`;
				ctx.ui?.notify?.(
					`Sidebar ${plan.enabled ? "on" : "off"}${persisted}.`,
					write.ok ? "info" : "warning",
				);
			} catch (error) {
				try {
					ctx.ui?.notify?.(`Sidebar toggle failed: ${errorText(error)}`, "error");
				} catch {
					/* never throw from a command */
				}
			}
		},
	});

	pi.registerCommand("agents-tree", {
		description: "Open the live agent tree and inspect one node",
		handler: async (_args: string, ctx) => {
			try {
				if (ctx.mode !== "tui") {
					ctx.ui?.notify?.("The agent tree overlay requires interactive mode.", "error");
					return;
				}
				ensureBound(ctx);
				await openTreeOverlay(ctx);
			} catch (error) {
				try {
					ctx.ui?.notify?.(`Cannot open the agent tree: ${errorText(error)}`, "error");
				} catch {
					/* never throw from a command */
				}
			}
		},
	});

	pi.registerCommand("agent-inspect", {
		description: "Open one agent node's detail (usage: /agent-inspect [runId|last])",
		handler: async (args: string, ctx) => {
			try {
				if (ctx.mode !== "tui") {
					ctx.ui?.notify?.("Agent inspect requires interactive mode.", "error");
					return;
				}
				ensureBound(ctx);
				const arg = args.trim();
				const snapshot = data?.snapshot();
				const nodes = snapshot ? flattenTree(snapshot.tree) : [];
				if (nodes.length === 0) {
					ctx.ui?.notify?.("No agents in the tree yet.", "info");
					return;
				}
				const node = !arg || arg === "last" ? newestNode(nodes) : nodes.find((n) => n.runId === arg);
				if (!node) {
					ctx.ui?.notify?.(`Unknown run id "${arg}".`, "warning");
					return;
				}
				await openNodeOverlay(ctx, node);
			} catch (error) {
				try {
					ctx.ui?.notify?.(`Cannot open the agent detail: ${errorText(error)}`, "error");
				} catch {
					/* never throw from a command */
				}
			}
		},
	});

	pi.registerCommand("ask-log", {
		description: "Open the log ring, newest first",
		handler: async (_args: string, ctx) => {
			try {
				if (ctx.mode !== "tui") {
					ctx.ui?.notify?.("The ask log overlay requires interactive mode.", "error");
					return;
				}
				ensureBound(ctx);
				await openAskLogOverlay(ctx);
			} catch (error) {
				try {
					ctx.ui?.notify?.(`Cannot open the ask log: ${errorText(error)}`, "error");
				} catch {
					/* never throw from a command */
				}
			}
		},
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
}
