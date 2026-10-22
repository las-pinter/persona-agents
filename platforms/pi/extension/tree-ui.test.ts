/**
 * Wiring harness for the sidebar glue in `tree-ui.ts`.
 *
 * Runs under plain Node (type stripping) and imports the REAL `tree-ui.ts`.
 * This proves the module loads in strip-only mode and that the `/sidebar width`
 * handler wires the pure planner to the config write, the compositor reinstall,
 * and the render request. `sidebar.test.ts` covers the pure planner alone.
 *
 * Fakes only: no real TTY, no real timers left running, and no write to the
 * real `~/.pi/agent/persona-agents-sidebar.json` (each test uses a temp path).
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/tree-ui.test.ts
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SIDEBAR_CONFIG_ENV,
	SIDEBAR_DEFAULT_WIDTH,
	getSidebarCompositor,
} from "./sidebar.ts";
import { bindTreeSidebar, disposeTreeSidebar, registerTreeUi } from "./tree-ui.ts";
import { ENV_TREE_LOG } from "./depth.ts";

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

/** One recorded `ctx.ui.notify` call. */
interface Notification {
	message: string;
	level: string | undefined;
}

interface FakeTerminal {
	columns: number;
	rows: number;
	writes: string[];
	write(data: string): void;
}

interface FakeTui {
	terminal: FakeTerminal;
	/** Counts both `doRender` and `requestRender`, the glue's two paint paths. */
	renderCalls: number;
	doRender(): void;
	requestRender(): void;
}

/** The real command handler shape the fake pi captures. */
type SidebarHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

/** A bound glue instance and the fakes it was bound to. */
interface Harness {
	configPath: string;
	terminal: FakeTerminal;
	tui: FakeTui;
	notifications: Notification[];
	handler: SidebarHandler;
	ctx: ExtensionContext;
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
function setup(config: { enabled?: boolean; width?: number }): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pa-tree-ui-"));
	currentDir = dir;
	const configPath = join(dir, "persona-agents-sidebar.json");
	writeFileSync(configPath, JSON.stringify(config));
	process.env[SIDEBAR_CONFIG_ENV] = configPath;
	// Force an empty tree so the test never reads the live tree log.
	delete process.env[ENV_TREE_LOG];

	const writes: string[] = [];
	const terminal: FakeTerminal = {
		columns: RAW_COLUMNS,
		rows: RAW_ROWS,
		writes,
		write(data: string): void {
			writes.push(data);
		},
	};
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			tui.renderCalls += 1;
		},
		requestRender(): void {
			tui.renderCalls += 1;
		},
	};

	const notifications: Notification[] = [];
	const commands = new Map<string, SidebarHandler>();
	const identityTheme = {
		bold: (text: string): string => text,
		dim: (text: string): string => text,
	};

	const ui = {
		// The factory hands over the tui; capture it by invoking it.
		setWidget(_key: string, content: unknown, _options?: unknown): void {
			if (typeof content === "function") {
				(content as (tuiArg: unknown, themeArg: unknown) => unknown)(tui, identityTheme);
			}
		},
		notify(message: string, level?: string): void {
			notifications.push({ message, level });
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
	return { configPath, terminal, tui, notifications, handler, ctx };
}

// --- /sidebar width wiring ---------------------------------------------------

test("a valid /sidebar width persists, reinstalls the compositor, and renders", async () => {
	const harness = setup({ enabled: true });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH);
	harness.tui.renderCalls = 0;

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
	assert.ok(harness.tui.renderCalls > 0, "the handler did not request a render");
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
	harness.tui.renderCalls = 0;

	await harness.handler("width abc", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a bad value");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH, "the width changed on a bad value");
	assert.equal(
		harness.terminal.columns,
		columnsBefore,
		"the terminal was renarrowed on a bad value",
	);
	assert.equal(harness.tui.renderCalls, 0, "a render was requested on a bad value");
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
	harness.tui.renderCalls = 0;

	await harness.handler("width 80", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a no-op");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 80 - 1,
		"the terminal width changed on a no-op",
	);
	assert.equal(harness.tui.renderCalls, 0, "a render was requested on a no-op");
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
