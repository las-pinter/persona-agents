/**
 * Shared fakes and the wiring harness for the `tree-ui.ts` test.
 *
 * The harness writes a temp sidebar config, forces an empty tree log, binds the
 * real glue to fake pi and tui surfaces, and hands back the captured commands.
 * Each test calls `cleanupHarness` from its `afterEach` hook.
 *
 * Fakes only: no real TTY, no real timers left running, and no write to the
 * real `~/.pi/agent/persona-agents-sidebar.json` (each test uses a temp path).
 */

import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ENV_TREE_LOG } from "./depth.ts";
import { SIDEBAR_CONFIG_ENV } from "./sidebar.ts";
import {
	makeTerminal,
	makeTui,
	type FakeTerminal,
	type FakeTui,
} from "./sidebar-terminal-fixtures.ts";
import { appendEvent, type RunEvent } from "./tree-log.ts";
import { bindTreeSidebar, registerTreeUi } from "./tree-ui.ts";

/**
 * The outer pi session exports PI_AGENT_TREE_LOG. Its live tree log would fill
 * the panel and hide the width rule under test. `setup` saves the value for its
 * own cycle, so a test runs against an empty tree and `cleanupHarness` restores
 * the value that cycle saw. A second importer in the same process gets its own
 * save, because the flag clears when a cycle restores.
 */
let ORIGINAL_TREE_LOG: string | undefined;
/** True while the current cycle holds a saved tree log value. */
let treeLogSaved = false;

/** Raw terminal columns before the compositor narrows them. */
export const RAW_COLUMNS = 200;
/** Terminal rows; drives the panel height budget. */
export const RAW_ROWS = 30;

/** One recorded `ctx.ui.notify` call. */
interface Notification {
	message: string;
	level: string | undefined;
}

/** The real command handler shape the fake pi captures. */
type SidebarHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

/** The overlay options a tree panel passes to `ctx.ui.custom`. */
interface CustomOptions {
	overlay?: boolean;
	overlayOptions?: {
		width?: string;
		maxHeight?: string;
		anchor?: string;
		margin?: { top?: number };
	};
}

/** One recorded `ctx.ui.custom` call: the options, the done callback, the mount. */
export interface OverlayMount {
	options: CustomOptions | undefined;
	/** Each value the factory's `done` callback received, in order. */
	doneValues: unknown[];
	component: Component | undefined;
}

/** The fakes the last `ctx.ui.custom` call mounted. */
interface MountedOverlay {
	/** The component the last call mounted. */
	component: Component | undefined;
	/** Every `custom` call, in mount order. */
	calls: OverlayMount[];
}

/** One recorded `ctx.ui.setWidget` call. */
interface WidgetCall {
	key: string;
	content: unknown;
}

/** A bound glue instance and the fakes it was bound to. */
export interface Harness {
	configPath: string;
	terminal: FakeTerminal;
	tui: FakeTui;
	notifications: Notification[];
	handler: SidebarHandler;
	/** The `/agent-inspect` handler. */
	inspect: SidebarHandler;
	/** The `/agents-tree` handler. */
	tree: SidebarHandler;
	/** The `/ask-log` handler. */
	askLog: SidebarHandler;
	/** Set by the fake `ctx.ui.custom`. */
	overlay: MountedOverlay;
	/** Every `ctx.ui.setWidget` call, in order. */
	widgets: WidgetCall[];
	ctx: ExtensionContext;
}

/** The temp dir of the running test, removed in `cleanupHarness`. */
let currentDir: string | null = null;

/**
 * One arrival ask event, written into the shared log. The ring keeps an
 * arrival, so the snapshot carries this row.
 */
function askEvent(index: number, flags = "waiting=0 shown=none place=slot"): RunEvent {
	const clock = `10:00:${String(index + 1).padStart(2, "0")}`;
	return {
		v: 1,
		type: "ask",
		runId: "run-test-1",
		parentRunId: null,
		depth: 0,
		agent: "implementer",
		persona: null,
		status: "idle",
		at: `2026-11-07T${clock}.000Z`,
		ask: {
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			askId: `root#${clock}`,
			phase: "arrival",
			flags,
		},
	};
}

/**
 * Bind the real glue to fakes. Writes the config file first so the resolved
 * width is deterministic, then registers the commands and binds the TUI path.
 */
export function setup(config: { enabled?: boolean; width?: number; log?: boolean; asks?: number }): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pa-tree-ui-"));
	currentDir = dir;
	const configPath = join(dir, "persona-agents-sidebar.json");
	writeFileSync(configPath, JSON.stringify(config));
	process.env[SIDEBAR_CONFIG_ENV] = configPath;
	// Save the tree log once per cycle; a second `setup` keeps the same baseline.
	if (!treeLogSaved) {
		treeLogSaved = true;
		ORIGINAL_TREE_LOG = process.env[ENV_TREE_LOG];
	}
	// Force an empty tree so the test never reads the live tree log.
	delete process.env[ENV_TREE_LOG];
	if (config.log) {
		const logPath = join(dir, "tree.log");
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: "run-test-1",
			parentRunId: null,
			depth: 0,
			agent: "implementer",
			persona: null,
			status: "running",
			at: new Date().toISOString(),
			task: "build it",
		});
		for (let index = 0; index < (config.asks ?? 0); index += 1) appendEvent(logPath, askEvent(index));
		process.env[ENV_TREE_LOG] = logPath;
	}

	const terminal = makeTerminal(RAW_COLUMNS, RAW_ROWS);
	const tui = makeTui(terminal);

	const notifications: Notification[] = [];
	const commands = new Map<string, SidebarHandler>();
	const overlay: MountedOverlay = { component: undefined, calls: [] };
	const widgets: WidgetCall[] = [];
	const identityTheme = {
		bold: (text: string): string => text,
		dim: (text: string): string => text,
	};

	const ui = {
		// The factory hands over the tui; capture it by invoking it.
		setWidget(key: string, content: unknown, _options?: unknown): void {
			widgets.push({ key, content });
			if (typeof content === "function") {
				(content as (tuiArg: unknown, themeArg: unknown) => unknown)(tui, identityTheme);
			}
		},
		notify(message: string, level?: string): void {
			notifications.push({ message, level });
		},
		// The handler mounts through `custom`; capture the component it returns.
		custom(
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown,
			options?: CustomOptions,
		): Promise<void> {
			const mount: OverlayMount = { options, doneValues: [], component: undefined };
			overlay.calls.push(mount);
			const done = (value: unknown): void => {
				mount.doneValues.push(value);
			};
			mount.component = factory(tui, identityTheme, {}, done) as Component;
			overlay.component = mount.component;
			return Promise.resolve();
		},
	};

	// SAFETY: the fake satisfies only the members the sidebar glue reads; the
	// real type carries far more, so the cast states that narrow contract.
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		hasUI: true,
		ui,
		model: { id: "test-model" },
		thinkingLevel: null,
		getContextUsage: () => ({ tokens: null, contextWindow: 128000, percent: null }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	// SAFETY: the fake registers commands and events only; the real type carries
	// the whole extension surface, so the cast states that narrow contract.
	const pi = {
		registerCommand(name: string, options: { handler: SidebarHandler }): void {
			commands.set(name, options.handler);
		},
		on(_event: string, _handler: unknown): () => void {
			return () => {};
		},
		exec: async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: "" }),
		events: { on: (_channel: string, _handler: unknown): (() => void) => () => {} },
	} as unknown as ExtensionAPI;

	registerTreeUi(pi);
	bindTreeSidebar(ctx);

	const handler = commands.get("sidebar");
	assert.ok(handler, "the /sidebar command was not registered");
	const inspect = commands.get("agent-inspect");
	assert.ok(inspect, "the /agent-inspect command was not registered");
	const tree = commands.get("agents-tree");
	assert.ok(tree, "the /agents-tree command was not registered");
	const askLog = commands.get("ask-log");
	assert.ok(askLog, "the /ask-log command was not registered");
	return { configPath, terminal, tui, notifications, handler, inspect, tree, askLog, overlay, widgets, ctx };
}

/** Remove the temp dir, clear the config override, and restore the outer log. */
export function cleanupHarness(): void {
	if (currentDir !== null) rmSync(currentDir, { recursive: true, force: true });
	currentDir = null;
	delete process.env[SIDEBAR_CONFIG_ENV];
	if (ORIGINAL_TREE_LOG === undefined) delete process.env[ENV_TREE_LOG];
	else process.env[ENV_TREE_LOG] = ORIGINAL_TREE_LOG;
	treeLogSaved = false;
}
