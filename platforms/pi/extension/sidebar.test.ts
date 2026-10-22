/**
 * Offline regression harness for the sidebar compositor and the `/sidebar`
 * toggle config.
 *
 * Runs under plain Node (type stripping) with a FAKE terminal and a FAKE tui.
 * No real TTY, no real `process.stdout` writes, and no write to the real
 * `~/.pi/agent/persona-agents-sidebar.json` (each config test uses a temp path).
 *
 *   npm test -- platforms/pi/extension/sidebar.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SIDEBAR_CONFIG_ENV,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SidebarCompositor,
	defaultSidebarConfigPath,
	defaultSidebarEnabled,
	disposeSidebarCompositor,
	getSidebarCompositor,
	installSidebarCompositor,
	parseSidebarWidth,
	planSidebarWidthChange,
	readSidebarConfig,
	resolveSidebarWidth,
	toggleSidebarState,
	writeSidebarConfig,
	type SidebarTerminal,
} from "./sidebar.ts";
import {
	renderSidebarPanel,
	type SidebarSnapshot,
	type SidebarTheme,
} from "./sidebar-render.ts";

// --- fakes ------------------------------------------------------------------

interface FakeTerminal extends SidebarTerminal {
	writes: string[];
}

interface FakeTui {
	terminal: FakeTerminal;
	renderCalls: number;
	doRender(...args: unknown[]): void;
}

function makeTerminal(columns = 100, rows = 30): FakeTerminal {
	const writes: string[] = [];
	return {
		columns,
		rows,
		writes,
		write(data: string): void {
			writes.push(data);
		},
	};
}

function makeTui(terminal: FakeTerminal): FakeTui {
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			tui.renderCalls += 1;
		},
	};
	return tui;
}

/** A terminal whose raw column count can change, like a real resize. */
interface ResizableTerminal extends FakeTerminal {
	resize(columns: number): void;
}

function makeResizableTerminal(columns: number, rows = 30): ResizableTerminal {
	let raw = columns;
	const writes: string[] = [];
	return {
		rows,
		writes,
		get columns(): number {
			return raw;
		},
		set columns(value: number) {
			raw = value;
		},
		write(data: string): void {
			writes.push(data);
		},
		resize(next: number): void {
			raw = next;
		},
	};
}

// --- compositor install / dispose -------------------------------------------

test("install narrows terminal.columns to raw - width - 1", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const original = terminal.columns;
	const compositor = new SidebarCompositor(tui, () => [], 20);

	compositor.install();
	assert.equal(terminal.columns, 100 - 20 - 1);
	assert.equal(original, 100);

	compositor.dispose();
	assert.equal(terminal.columns, original);
});

test("a width wider than the terminal hides the sidebar until a resize reveals it", () => {
	const terminal = makeResizableTerminal(80, 24);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => ["panel"], SIDEBAR_MAX_WIDTH);

	compositor.install();
	// 80 columns cannot hold a 120-wide column beside a usable main area.
	assert.equal(compositor.width, SIDEBAR_MAX_WIDTH);
	assert.equal(terminal.columns, 1, "the main area collapsed to zero or less");
	terminal.writes.length = 0;
	compositor.paint();
	assert.equal(terminal.writes.length, 0, "the sidebar was drawn on a too-narrow terminal");

	// Widen past width + 1: the sidebar appears at the configured width.
	terminal.resize(250);
	assert.equal(terminal.columns, 250 - SIDEBAR_MAX_WIDTH - 1);
	terminal.writes.length = 0;
	compositor.paint();
	assert.ok(
		terminal.writes.join("").includes(`\x1b[1;${250 - SIDEBAR_MAX_WIDTH}H│`),
		"the separator was not drawn after the resize",
	);

	// Shrink back: the sidebar hides again and the main area stays at least 1 column.
	terminal.resize(100);
	assert.equal(terminal.columns, 1, "the main area collapsed to zero or less");
	terminal.writes.length = 0;
	compositor.paint();
	assert.equal(terminal.writes.length, 0, "the sidebar was drawn after shrinking again");

	compositor.dispose();
	assert.equal(terminal.columns, 100);
});

test("dispose restores the original doRender", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const originalRender = tui.doRender;
	const compositor = new SidebarCompositor(tui, () => [], 20);

	compositor.install();
	assert.notEqual(tui.doRender, originalRender);

	compositor.dispose();
	assert.equal(tui.doRender, originalRender);
});

test("dispose is idempotent and a paint after dispose does nothing", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => [" AGENTS "], 20);

	compositor.install();
	compositor.dispose();
	compositor.dispose();

	assert.equal(terminal.columns, 100);
	terminal.writes.length = 0;
	compositor.paint();
	assert.equal(terminal.writes.length, 0);
});

// --- compositor paint -------------------------------------------------------

test("paint writes the separator and the right-column lines", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => [" AGENTS ", "x"], 20);

	compositor.install();
	terminal.writes.length = 0;
	compositor.paint();

	const output = terminal.writes.join("");
	assert.ok(output.includes("\x1b[1;80H"), output);
	assert.ok(output.includes("\x1b[1;81H"), output);
	assert.ok(output.includes("│"), output);
	assert.ok(output.includes(" AGENTS "), output);
	assert.ok(output.includes("\x1b7"), output);
	assert.ok(output.includes("\x1b8"), output);
	assert.ok(output.includes("\x1b[?7l"), output);
	assert.ok(output.includes("\x1b[?7h"), output);

	compositor.dispose();
});

test("paint writes only changed rows", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => ["panel"], 20);

	compositor.install();
	compositor.paint();
	const afterFirst = terminal.writes.length;
	assert.ok(afterFirst > 0);

	compositor.paint();
	assert.equal(terminal.writes.length, afterFirst);

	compositor.dispose();
});

test("paint fills every terminal row with the separator and blanks the rest", () => {
	const terminal = makeTerminal(100, 10);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => [" AGENTS ", "x"], 20);

	compositor.install();
	terminal.writes.length = 0;
	compositor.paint();

	const output = terminal.writes.join("");
	// Width 20 => separator at column 80, sidebar content at column 81.
	for (let row = 1; row <= 10; row++) {
		assert.ok(output.includes(`\x1b[${row};80H│`), `separator missing on row ${row}`);
	}
	assert.equal(output.split("│").length - 1, 10, output);
	// Rows with no panel line are blanked to the full column width.
	for (let row = 3; row <= 10; row++) {
		assert.ok(
			output.includes(`\x1b[${row};81H${" ".repeat(20)}`),
			`row ${row} was not blanked`,
		);
	}

	compositor.dispose();
});

test("paint swallows a thrown getLines error", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(
		tui,
		() => {
			throw new Error("paint-boom");
		},
		20,
	);

	compositor.install();
	assert.doesNotThrow(() => compositor.paint());
	compositor.dispose();
});

// --- wrapped doRender -------------------------------------------------------

test("the wrapped doRender calls pi, opens a sync frame, and paints", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);
	const compositor = new SidebarCompositor(tui, () => ["panel"], 20);

	compositor.install();
	terminal.writes.length = 0;
	tui.doRender();

	const output = terminal.writes.join("");
	assert.equal(tui.renderCalls, 1);
	assert.ok(output.includes("\x1b[?2026h"), output);
	assert.ok(output.includes("\x1b[?2026l"), output);
	assert.ok(output.includes("panel"), output);

	compositor.dispose();
});

test("the wrapped doRender rewrites pi's full-line erase", () => {
	const terminal = makeTerminal(100, 30);
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			terminal.write("\x1b[2Khi");
		},
	};
	const compositor = new SidebarCompositor(tui, () => [], 20);

	compositor.install();
	terminal.writes.length = 0;
	tui.doRender();

	const output = terminal.writes.join("");
	assert.ok(output.includes("\x1b[79X"), output);
	assert.ok(!output.includes("\x1b[2K"), output);

	compositor.dispose();
});

test("a full-screen clear forces every sidebar row to repaint", () => {
	const terminal = makeTerminal(100, 30);
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			terminal.write("\x1b[2Jhi");
		},
	};
	const compositor = new SidebarCompositor(tui, () => ["panel"], 20);

	compositor.install();
	// Fill the row cache without a clear, so a later paint would normally be a no-op.
	compositor.paint();
	const afterFirst = terminal.writes.length;

	// pi's clear wipes the sidebar; the row diff must not hide the repaint.
	tui.doRender();

	const output = terminal.writes.slice(afterFirst).join("");
	assert.ok(output.includes("\x1b[1;80H"), output);
	assert.ok(output.includes("panel"), output);

	compositor.dispose();
});

test("the wrapped doRender strips pi's nested sync markers", () => {
	const terminal = makeTerminal(100, 30);
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			terminal.write("\x1b[?2026hpi-content\x1b[?2026l");
		},
	};
	const compositor = new SidebarCompositor(tui, () => [], 20);

	compositor.install();
	terminal.writes.length = 0;
	tui.doRender();

	const output = terminal.writes.join("");
	// The outer frame stays open: one open marker first, one close marker last.
	assert.ok(output.startsWith("\x1b[?2026h"), output);
	assert.ok(output.endsWith("\x1b[?2026l"), output);
	assert.equal(output.split("\x1b[?2026h").length - 1, 1, output);
	assert.equal(output.split("\x1b[?2026l").length - 1, 1, output);
	// pi's content survives; only its nested markers are gone.
	assert.ok(output.includes("pi-content"), output);

	compositor.dispose();
});

test("the wrapped doRender rethrows pi's error and swallows a paint error", () => {
	const terminal = makeTerminal(100, 30);
	const tui: FakeTui = {
		terminal,
		renderCalls: 0,
		doRender(): void {
			throw new Error("pi-boom");
		},
	};
	const compositor = new SidebarCompositor(
		tui,
		() => {
			throw new Error("paint-boom");
		},
		20,
	);

	compositor.install();
	assert.throws(() => tui.doRender(), /pi-boom/);
	// The synchronized-output block still closes in `finally`.
	assert.ok(terminal.writes.join("").includes("\x1b[?2026l"));

	compositor.dispose();
});

// --- singleton teardown -----------------------------------------------------

test("installSidebarCompositor and disposeSidebarCompositor manage the singleton", () => {
	const terminal = makeTerminal(100, 30);
	const tui = makeTui(terminal);

	const compositor = installSidebarCompositor(tui, () => ["x"], 20);
	assert.equal(getSidebarCompositor(), compositor);
	assert.equal(terminal.columns, 79);

	disposeSidebarCompositor();
	assert.equal(getSidebarCompositor(), null);
	assert.equal(terminal.columns, 100);

	// Idempotent.
	disposeSidebarCompositor();
});

test("a live width change keeps the renderer and compositor widths equal", () => {
	const terminal = makeTerminal(200, 30);
	const tui = makeTui(terminal);
	const snapshot: SidebarSnapshot = {
		cwd: "/tmp",
		tree: [],
		session: {
			model: "m",
			thinkingLevel: null,
			contextTokens: null,
			contextWindow: null,
			contextPercent: null,
			cost: 0,
			tps: 0,
			tokensIn: 0,
			tokensOut: 0,
			turns: 0,
			sessionStartMs: null,
		},
		workspace: { cwd: "/tmp", branch: null, changed: [], changedCount: 0, files: [] },
		mcp: [],
		todos: [],
		tps: 0,
	};
	const theme: SidebarTheme = { bold: (text) => text, dim: (text) => text };
	let width = 80;
	const getLines = () => renderSidebarPanel(snapshot, width, 30, theme, 0);

	installSidebarCompositor(tui, getLines, width);
	assert.equal(getSidebarCompositor()?.width, 80);
	assert.equal(terminal.columns, 200 - 80 - 1);
	terminal.writes.length = 0;
	tui.doRender();
	let output = terminal.writes.join("");
	assert.ok(output.includes("─".repeat(80)), "renderer did not use width 80");
	assert.ok(output.includes("\x1b[30;120H│"), "separator is not at raw - 80");

	// A live change moves the renderer and the compositor together.
	width = 30;
	installSidebarCompositor(tui, getLines, width);
	assert.equal(getSidebarCompositor()?.width, 30);
	assert.equal(terminal.columns, 200 - 30 - 1);
	terminal.writes.length = 0;
	tui.doRender();
	output = terminal.writes.join("");
	assert.ok(output.includes("─".repeat(30)), "renderer did not use width 30");
	assert.ok(output.includes("\x1b[30;170H│"), "separator is not at raw - 30");

	disposeSidebarCompositor();
});

// --- toggle config ----------------------------------------------------------

test("writeSidebarConfig round-trips atomically", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const configPath = join(dir, "persona-agents-sidebar.json");
	try {
		const writeTrue = writeSidebarConfig(true, configPath);
		assert.equal(writeTrue.ok, true);
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true });
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { enabled: true });

		const writeFalse = writeSidebarConfig(false, configPath);
		assert.equal(writeFalse.ok, true);
		assert.deepEqual(readSidebarConfig(configPath), { enabled: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readSidebarConfig falls back when the file is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	try {
		assert.deepEqual(readSidebarConfig(join(dir, "nope.json"), false), { enabled: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeSidebarConfig does not throw on a bad path", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const blocker = join(dir, "blocker");
	writeFileSync(blocker, "x");
	const configPath = join(blocker, "nested.json");
	try {
		let result: ReturnType<typeof writeSidebarConfig> | undefined;
		assert.doesNotThrow(() => {
			result = writeSidebarConfig(true, configPath);
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.equal(result!.enabled, true);
		assert.equal(typeof result!.error, "string");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the config path honors the env override", () => {
	const previous = process.env[SIDEBAR_CONFIG_ENV];
	process.env[SIDEBAR_CONFIG_ENV] = "/tmp/pa-sidebar-env.json";
	try {
		assert.equal(defaultSidebarConfigPath(), "/tmp/pa-sidebar-env.json");
	} finally {
		if (previous === undefined) delete process.env[SIDEBAR_CONFIG_ENV];
		else process.env[SIDEBAR_CONFIG_ENV] = previous;
	}
});

test("writeSidebarConfig round-trips the width", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const configPath = join(dir, "persona-agents-sidebar.json");
	try {
		const write = writeSidebarConfig(true, configPath, 80);
		assert.equal(write.ok, true);
		assert.equal(write.width, 80);
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 80 });
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { enabled: true, width: 80 });
		assert.equal(resolveSidebarWidth(configPath), 80);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readSidebarConfig clamps an out-of-range width on read", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const configPath = join(dir, "persona-agents-sidebar.json");
	try {
		writeFileSync(configPath, JSON.stringify({ enabled: true, width: 500 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 120 });
		writeFileSync(configPath, JSON.stringify({ enabled: true, width: 2 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 10 });
		writeFileSync(configPath, JSON.stringify({ enabled: true, width: 0 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 10 });
		writeFileSync(configPath, JSON.stringify({ enabled: true, width: -5 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 10 });
		writeFileSync(configPath, JSON.stringify({ enabled: true, width: 10.9 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 10 });
		for (const invalid of ["80", null, true, false]) {
			writeFileSync(configPath, JSON.stringify({ enabled: true, width: invalid }));
			assert.deepEqual(readSidebarConfig(configPath), { enabled: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stored width survives when enabled is missing or invalid", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const configPath = join(dir, "persona-agents-sidebar.json");
	try {
		writeFileSync(configPath, JSON.stringify({ width: 80 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 80 });
		assert.equal(resolveSidebarWidth(configPath), 80);

		// A later toggle must persist the stored width instead of overwriting it.
		const write = writeSidebarConfig(false, configPath, resolveSidebarWidth(configPath));
		assert.equal(write.ok, true);
		assert.deepEqual(readSidebarConfig(configPath), { enabled: false, width: 80 });

		writeFileSync(configPath, JSON.stringify({ enabled: "yes", width: 80 }));
		assert.deepEqual(readSidebarConfig(configPath), { enabled: true, width: 80 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeSidebarConfig merges an omitted width with the stored one", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	const configPath = join(dir, "persona-agents-sidebar.json");
	try {
		writeSidebarConfig(true, configPath, 80);
		const write = writeSidebarConfig(false, configPath);
		assert.equal(write.ok, true);
		assert.equal(write.width, 80);
		assert.deepEqual(readSidebarConfig(configPath), { enabled: false, width: 80 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveSidebarWidth falls back to the default when no width is set", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-sidebar-"));
	try {
		assert.equal(
			resolveSidebarWidth(join(dir, "nope.json")),
			SIDEBAR_DEFAULT_WIDTH,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("defaultSidebarEnabled is ON in TUI and OFF elsewhere", () => {
	assert.equal(defaultSidebarEnabled("tui"), true);
	assert.equal(defaultSidebarEnabled("rpc"), false);
	assert.equal(defaultSidebarEnabled("json"), false);
	assert.equal(defaultSidebarEnabled("print"), false);
	assert.equal(defaultSidebarEnabled(undefined), false);
});

test("toggleSidebarState plans install in TUI and dispose when off", () => {
	assert.deepEqual(toggleSidebarState(true, "tui", false), {
		enabled: true,
		canCompose: true,
		shouldInstall: true,
		shouldDispose: false,
	});
	assert.deepEqual(toggleSidebarState(false, "tui", true), {
		enabled: false,
		canCompose: false,
		shouldInstall: false,
		shouldDispose: true,
	});
	assert.deepEqual(toggleSidebarState(true, "rpc", true), {
		enabled: true,
		canCompose: false,
		shouldInstall: false,
		shouldDispose: true,
	});
	assert.deepEqual(toggleSidebarState(true, "tui", true), {
		enabled: true,
		canCompose: true,
		shouldInstall: false,
		shouldDispose: false,
	});
});

// --- width command planning -------------------------------------------------

test("parseSidebarWidth accepts the range bounds and a middle value", () => {
	assert.deepEqual(parseSidebarWidth(String(SIDEBAR_MIN_WIDTH)), {
		ok: true,
		width: SIDEBAR_MIN_WIDTH,
	});
	assert.deepEqual(parseSidebarWidth("80"), { ok: true, width: 80 });
	assert.deepEqual(parseSidebarWidth(String(SIDEBAR_MAX_WIDTH)), {
		ok: true,
		width: SIDEBAR_MAX_WIDTH,
	});
});

test("parseSidebarWidth trims surrounding whitespace", () => {
	assert.deepEqual(parseSidebarWidth("  80  "), { ok: true, width: 80 });
	assert.equal(parseSidebarWidth("   ").ok, false);
});

test("parseSidebarWidth rejects a non-numeric, a missing, and an empty value", () => {
	const nonNumeric = parseSidebarWidth("abc");
	assert.equal(nonNumeric.ok, false);
	if (!nonNumeric.ok) assert.match(nonNumeric.message, /Invalid width "abc"/);

	const missing = parseSidebarWidth(undefined);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.message, /Usage: \/sidebar width/);

	const empty = parseSidebarWidth("");
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.match(empty.message, /Usage: \/sidebar width/);
});

test("parseSidebarWidth rejects an out-of-range value", () => {
	const low = parseSidebarWidth(String(SIDEBAR_MIN_WIDTH - 1));
	assert.equal(low.ok, false);
	if (!low.ok) assert.match(low.message, /out of range/);

	const high = parseSidebarWidth(String(SIDEBAR_MAX_WIDTH + 1));
	assert.equal(high.ok, false);
	if (!high.ok) assert.match(high.message, /out of range/);
});

test("planSidebarWidthChange accepts a valid width and asks to reinstall", () => {
	assert.deepEqual(planSidebarWidthChange(["80"], SIDEBAR_DEFAULT_WIDTH), {
		ok: true,
		width: 80,
		shouldReinstall: true,
	});
});

test("planSidebarWidthChange rejects a missing argument", () => {
	const plan = planSidebarWidthChange([], SIDEBAR_DEFAULT_WIDTH);
	assert.equal(plan.ok, false);
	if (!plan.ok) assert.match(plan.message, /Usage: \/sidebar width/);
});

test("planSidebarWidthChange rejects an extra argument", () => {
	const plan = planSidebarWidthChange(["80", "90"], SIDEBAR_DEFAULT_WIDTH);
	assert.equal(plan.ok, false);
	if (!plan.ok) assert.match(plan.message, /Unexpected argument/);
});

test("planSidebarWidthChange rejects junk values", () => {
	for (const junk of ["1e3", "10.5", "--", ""]) {
		const plan = planSidebarWidthChange([junk], SIDEBAR_DEFAULT_WIDTH);
		assert.equal(plan.ok, false, `"${junk}" should be rejected`);
	}
});

test("planSidebarWidthChange rejects both range ends", () => {
	const low = planSidebarWidthChange([String(SIDEBAR_MIN_WIDTH - 1)], SIDEBAR_DEFAULT_WIDTH);
	assert.equal(low.ok, false);
	if (!low.ok) assert.match(low.message, /out of range/);

	const high = planSidebarWidthChange([String(SIDEBAR_MAX_WIDTH + 1)], SIDEBAR_DEFAULT_WIDTH);
	assert.equal(high.ok, false);
	if (!high.ok) assert.match(high.message, /out of range/);
});

test("planSidebarWidthChange does not reinstall for the current width", () => {
	assert.deepEqual(planSidebarWidthChange(["80"], 80), {
		ok: true,
		width: 80,
		shouldReinstall: false,
	});
});
