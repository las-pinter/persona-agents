/**
 * The four tree commands: `/sidebar`, `/agents-tree`, `/agent-inspect`, and
 * `/ask-log`.
 *
 * `registerTreeCommands(pi, host)` registers all four. The sidebar glue in
 * `tree-ui.ts` owns the lifecycle, the paint, and the three overlay mounts,
 * and each handler reaches them through the host handle. This module holds
 * no state, so the glue owns every value a handler reads.
 *
 * Each handler wraps its body in one `try`/`catch`. A command failure must
 * never break the session, so a throw becomes one `notify` line.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	disposeSidebarCompositor,
	getSidebarCompositor,
	planSidebarWidthChange,
	resolveSidebarEnabled,
	resolveSidebarWidth,
	toggleSidebarState,
	writeSidebarConfig,
} from "./sidebar.ts";
import type { SidebarSnapshot } from "./sidebar-types.ts";
import { flattenTree, type TreeNode } from "./tree-model.ts";

/** The glue a command drives: the bind, the paint, and the three overlays. */
export interface TreeCommandHost {
	/** The live snapshot, or null before the bind. */
	readonly snapshot: () => SidebarSnapshot | null;
	/** The column width the paint layer reads. */
	readonly getWidth: () => number;
	/** Store a new column width for the paint layer. */
	readonly setWidth: (width: number) => void;
	readonly ensureBound: (ctx: ExtensionContext) => void;
	readonly scrollColumn: (delta: number) => void;
	readonly installCompositor: () => void;
	readonly requestRender: () => void;
	readonly openTreeOverlay: (ctx: ExtensionContext) => Promise<void>;
	readonly openNodeOverlay: (ctx: ExtensionContext, node: TreeNode) => Promise<void>;
	readonly openAskLogOverlay: (ctx: ExtensionContext) => Promise<void>;
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

/**
 * The scroll count of a `/sidebar up|down` argument: one when absent, or null
 * when the argument is not a positive whole number.
 */
function parseScrollCount(raw: string | undefined): number | null {
	if (raw === undefined) return 1;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) return null;
	return value;
}

/** Register the four tree commands. One `try`/`catch` guards each handler. */
export function registerTreeCommands(pi: ExtensionAPI, host: TreeCommandHost): void {
	const {
		ensureBound,
		getWidth,
		installCompositor,
		openAskLogOverlay,
		openNodeOverlay,
		openTreeOverlay,
		requestRender,
		scrollColumn,
		setWidth,
	} = host;

	pi.registerCommand("sidebar", {
		description:
			"Show or hide the persona-agents sidebar, set its width, or scroll it (usage: /sidebar [on|off|width <n>|up [n]|down [n]])",
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
						const plan = planSidebarWidthChange(parts.slice(1), getWidth());
						if (!plan.ok) {
							ctx.ui?.notify?.(plan.message, "warning");
							return;
						}
						setWidth(plan.width);
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
					if (parts[0] === "up" || parts[0] === "down") {
						const count = parseScrollCount(parts[1]);
						if (count === null) {
							ctx.ui?.notify?.(
								`Bad scroll count "${parts[1] ?? ""}". Use /sidebar ${parts[0]} [n] with n a positive whole number.`,
								"warning",
							);
							return;
						}
						// No key is involved, so a skipped binding cannot lock the column.
						ensureBound(ctx);
						scrollColumn(parts[0] === "down" ? count : -count);
						return;
					}
					ctx.ui?.notify?.(
						`Unknown option "${arg}". Use /sidebar [on|off], /sidebar width <n>, or /sidebar up|down [n].`,
						"warning",
					);
					return;
				}

				const installed = getSidebarCompositor() !== null;
				const plan = toggleSidebarState(enabled, ctx.mode, installed);
				// Re-read the width from disk so the live compositor matches disk. A
				// width changed by another window must not leave the cached value stale.
				setWidth(resolveSidebarWidth());
				const write = writeSidebarConfig(plan.enabled, undefined, getWidth());

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
				const snapshot = host.snapshot();
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
}
