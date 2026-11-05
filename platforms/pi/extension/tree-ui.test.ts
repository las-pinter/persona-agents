/**
 * Wiring harness for the sidebar glue in `tree-ui.ts`.
 *
 * Runs under plain Node (type stripping) and imports the REAL `tree-ui.ts`.
 * This proves the module loads in strip-only mode and that the `/sidebar width`
 * handler wires the pure planner to the config write, the compositor reinstall,
 * and the render request. `sidebar.test.ts` covers the pure planner alone.
 * The same file also covers the `/agents-tree` overlay runtime path: the mount
 * options, the marked row, the close keys, the selection move, and the widget
 * clear on dispose.
 *
 * Fakes only: no real TTY, no real timers left running, and no write to the
 * real `~/.pi/agent/persona-agents-sidebar.json` (each test uses a temp path).
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/tree-ui.test.ts
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	SIDEBAR_CONFIG_ENV,
	SIDEBAR_DEFAULT_WIDTH,
	getSidebarCompositor,
} from "./sidebar.ts";
import { bindTreeSidebar, disposeTreeSidebar, registerTreeUi } from "./tree-ui.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent } from "./tree-log.ts";
import {
	makeTerminal,
	makeTui,
	paintCalls,
	resetPaints,
	type FakeTerminal,
	type FakeTui,
} from "./sidebar-terminal-fixtures.ts";

/**
 * The outer pi session exports PI_AGENT_TREE_LOG. Its live tree log would fill
 * the panel and hide the width rule under test. Save the value so each test can
 * run against an empty tree and then restore the outer environment.
 */
const ORIGINAL_TREE_LOG = process.env[ENV_TREE_LOG];

/** Raw terminal columns before the compositor narrows them. */
const RAW_COLUMNS = 200;
/** Terminal rows; drives the panel height budget. */
const RAW_ROWS = 30;
/** Section-rule glyph the pure renderer repeats to the panel width. */
const SECTION_RULE_CHAR = "─";
/** Selection marker glyph the tree overlay puts on the selected row. */
const SELECTION_MARKER = "▶";

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
interface OverlayMount {
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
interface Harness {
	configPath: string;
	terminal: FakeTerminal;
	tui: FakeTui;
	notifications: Notification[];
	handler: SidebarHandler;
	/** The `/agent-inspect` handler. */
	inspect: SidebarHandler;
	/** The `/agents-tree` handler. */
	tree: SidebarHandler;
	/** Set by the fake `ctx.ui.custom`. */
	overlay: MountedOverlay;
	/** Every `ctx.ui.setWidget` call, in order. */
	widgets: WidgetCall[];
	ctx: ExtensionContext;
}

/** The zero-based row indexes that carry the tree selection marker. */
function markedRows(lines: string[]): number[] {
	return lines.flatMap((line, index) => (line.includes(SELECTION_MARKER) ? [index] : []));
}

/** The temp dir of the running test, removed in `afterEach`. */
let currentDir: string | null = null;

afterEach(() => {
	disposeTreeSidebar();
	if (currentDir !== null) rmSync(currentDir, { recursive: true, force: true });
	currentDir = null;
	delete process.env[SIDEBAR_CONFIG_ENV];
	if (ORIGINAL_TREE_LOG === undefined) delete process.env[ENV_TREE_LOG];
	else process.env[ENV_TREE_LOG] = ORIGINAL_TREE_LOG;
});

/**
 * Bind the real glue to fakes. Writes the config file first so the resolved
 * width is deterministic, then registers the commands and binds the TUI path.
 */
function setup(config: { enabled?: boolean; width?: number; log?: boolean }): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pa-tree-ui-"));
	currentDir = dir;
	const configPath = join(dir, "persona-agents-sidebar.json");
	writeFileSync(configPath, JSON.stringify(config));
	process.env[SIDEBAR_CONFIG_ENV] = configPath;
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
	return { configPath, terminal, tui, notifications, handler, inspect, tree, overlay, widgets, ctx };
}

// --- /sidebar width wiring ---------------------------------------------------
test("a valid /sidebar width persists, reinstalls the compositor, and renders", async () => {
	const harness = setup({ enabled: true });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH);
	resetPaints(harness.tui);

	await harness.handler("width 80", harness.ctx);

	const after = getSidebarCompositor();
	assert.ok(after, "a compositor should still be installed");
	assert.notEqual(after, before, "the compositor was not reinstalled");
	assert.equal(after.width, 80, "the reinstalled compositor did not use the new width");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 80 - 1,
		"the terminal was not narrowed to the new width",
	);
	assert.equal(harness.tui.requestRenderCalls, 1, "the handler did not request a render");
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 80,
	});
	assert.ok(
		harness.notifications.some(
			(note) => note.level === "info" && /Sidebar width 80/.test(note.message),
		),
		"the handler did not report the new width",
	);
});

test("a bad /sidebar width notifies and leaves the width and compositor unchanged", async () => {
	const harness = setup({ enabled: true });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	const columnsBefore = harness.terminal.columns;
	resetPaints(harness.tui);

	await harness.handler("width abc", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a bad value");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH, "the width changed on a bad value");
	assert.equal(
		harness.terminal.columns,
		columnsBefore,
		"the terminal was renarrowed on a bad value",
	);
	assert.equal(paintCalls(harness.tui), 0, "a render was requested on a bad value");
	assert.deepEqual(
		JSON.parse(readFileSync(harness.configPath, "utf8")),
		{ enabled: true },
		"the width was persisted on a bad value",
	);
	assert.ok(
		harness.notifications.some(
			(note) => note.level === "warning" && /Invalid width/.test(note.message),
		),
		"the handler did not warn about the bad value",
	);
});

test("a no-op /sidebar width does not reinstall or render", async () => {
	const harness = setup({ enabled: true, width: 80 });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, 80);
	resetPaints(harness.tui);

	await harness.handler("width 80", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a no-op");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 80 - 1,
		"the terminal width changed on a no-op",
	);
	assert.equal(paintCalls(harness.tui), 0, "a render was requested on a no-op");
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 80,
	});
});

test("buildLines and installCompositor use the resolved width, not the default", () => {
	const harness = setup({ enabled: true, width: 80 });
	const compositor = getSidebarCompositor();
	assert.ok(compositor, "a compositor should be installed in TUI mode");
	assert.equal(compositor.width, 80, "installCompositor did not use the resolved width");
	assert.equal(harness.terminal.columns, RAW_COLUMNS - 80 - 1);

	harness.terminal.writes.length = 0;
	compositor.paint();
	const output = harness.terminal.writes.join("");
	assert.ok(
		output.includes(SECTION_RULE_CHAR.repeat(80)),
		"buildLines did not render the panel at the resolved width",
	);
});

test("a toggle adopts a width changed on disk so the live compositor matches disk", async () => {
	const harness = setup({ enabled: true, width: 80 });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, 80);
	assert.equal(harness.terminal.columns, RAW_COLUMNS - 80 - 1);

	// Another window edits the config on disk while this session runs.
	writeFileSync(harness.configPath, JSON.stringify({ enabled: true, width: 30 }));

	// The toggle branch must read the fresh on-disk width, not the bind-time cache.
	await harness.handler("off", harness.ctx);
	await harness.handler("on", harness.ctx);

	const after = getSidebarCompositor();
	assert.ok(after, "a compositor should be installed again after /sidebar on");
	assert.equal(after.width, 30, "the live compositor kept the bind-time cached width");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 30 - 1,
		"the terminal was not narrowed to the on-disk width",
	);
	// Disk truth and live truth must agree.
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 30,
	});
});

// --- /agent-inspect overlay contract ----------------------------------------

test("the agent detail overlay carries invalidate and re-renders after it", async () => {
	const harness = setup({ enabled: true, log: true });
	await harness.inspect("last", harness.ctx);

	const mounted = harness.overlay.component;
	assert.ok(mounted, "the /agent-inspect command mounts a component");
	mounted.invalidate();
	const lines = mounted.render(80);
	assert.match(lines[0], /AGENT implementer/, lines[0]);
});

// --- /agents-tree overlay runtime path --------------------------------------

describe("tree overlay runtime path", () => {
	test("a /agents-tree run mounts one full-screen centered overlay", async () => {
		const harness = setup({ enabled: true, log: true });

		await harness.tree("", harness.ctx);

		assert.equal(harness.overlay.calls.length, 1, "the command mounts exactly one overlay");
		const call = harness.overlay.calls[0];
		assert.equal(call.options?.overlay, true, "the tree panel mounts as an overlay");
		const options = call.options?.overlayOptions;
		assert.ok(options, "the overlay carries overlayOptions");
		assert.equal(options.width, "100%", "the overlay width is 100 percent");
		assert.equal(options.maxHeight, "100%", "the overlay maxHeight is 100 percent");
		assert.equal(options.anchor, "center", "the overlay anchors at the center");
		assert.equal(options.margin?.top, 0, "the overlay margin top is 0");
		assert.ok(call.component, "the factory returns a component");
	});

	test("the mounted component renders a selected row at width 80 and width 40", async () => {
		const harness = setup({ enabled: true, log: true });
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		assert.ok(component, "the overlay mounted a component");

		for (const width of [80, 40]) {
			const lines = component.render(width);
			assert.ok(lines.length > 0, `the overlay rendered no lines at width ${width}`);
			const marked = markedRows(lines);
			assert.equal(marked.length, 1, `one row carries the marker at width ${width}`);
			assert.match(lines[marked[0]], /implementer/, "the marker sits on the seeded node row");
		}
	});

	test("Esc, q, and Q each close the overlay once", async () => {
		const harness = setup({ enabled: true, log: true });
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		const mount = harness.overlay.calls[0];
		assert.ok(component && mount, "the overlay mounted");
		const handleInput = component.handleInput?.bind(component);
		assert.ok(handleInput, "the mounted component accepts input");

		for (const key of ["\x1b", "q", "Q"]) {
			const before = mount.doneValues.length;
			handleInput(key);
			assert.equal(
				mount.doneValues.length,
				before + 1,
				`key ${JSON.stringify(key)} closed the overlay exactly once`,
			);
		}
		assert.deepEqual(
			mount.doneValues,
			[undefined, undefined, undefined],
			"each close passes no value",
		);
	});

	test("Down then Up moves the selection and each call re-renders", async () => {
		const harness = setup({ enabled: true, log: true });
		const logPath = process.env[ENV_TREE_LOG];
		assert.ok(logPath, "the harness set a tree log");
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: "run-test-2",
			parentRunId: null,
			depth: 0,
			agent: "reviewer",
			persona: null,
			status: "running",
			at: new Date().toISOString(),
			task: "check it",
		});
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: "run-test-3",
			parentRunId: null,
			depth: 0,
			agent: "tester",
			persona: null,
			status: "running",
			at: new Date().toISOString(),
			task: "test it",
		});
		// Re-bind so the snapshot reads all three nodes before the overlay mounts.
		disposeTreeSidebar();
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		assert.ok(component, "the overlay mounted a component");
		const handleInput = component.handleInput?.bind(component);
		assert.ok(handleInput, "the mounted component accepts input");

		const initialLines = component.render(80);
		const before = markedRows(initialLines);
		assert.equal(before.length, 1, "one row carries the marker before a key");
		assert.match(initialLines[before[0]], /implementer/, "the first node is marked before a key");
		resetPaints(harness.tui);

		handleInput("\x1b[B");
		const downLines = component.render(80);
		const afterDown = markedRows(downLines);
		assert.equal(harness.tui.requestRenderCalls, 1, "Down requested one render");
		assert.equal(afterDown.length, 1, "one row carries the marker after Down");
		assert.equal(afterDown[0], before[0] + 1, "Down moved the marker exactly one row down");
		assert.match(downLines[afterDown[0]], /reviewer/, "the second node is marked after Down");

		handleInput("\x1b[A");
		const upLines = component.render(80);
		const afterUp = markedRows(upLines);
		assert.equal(harness.tui.requestRenderCalls, 2, "Up requested one render");
		assert.deepEqual(afterUp, before, "Up moved the marker back to the first row");
		assert.match(upLines[afterUp[0]], /implementer/, "the first node is marked after Up");
	});

	test("disposeTreeSidebar clears the tree widget with an undefined value", () => {
		const harness = setup({ enabled: true, log: true });
		const key = "persona-agents-tree";
		const bound = harness.widgets.filter((call) => call.key === key);
		assert.ok(bound.length > 0, "binding sets the tree widget");
		assert.notEqual(bound.at(-1)?.content, undefined, "binding sets a live widget first");

		disposeTreeSidebar();

		const last = harness.widgets.at(-1);
		assert.ok(last, "dispose writes a widget call");
		assert.equal(last.key, key, "dispose writes the tree widget key");
		assert.equal(last.content, undefined, "dispose clears the widget with an undefined value");
	});
});
