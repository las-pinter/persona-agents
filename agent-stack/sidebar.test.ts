/**
 * Offline regression harness for the sidebar compositor and the `/sidebar`
 * toggle config.
 *
 * Runs under plain Node (type stripping) with a FAKE terminal and a FAKE tui.
 * No real TTY, no real `process.stdout` writes, and no write to the real
 * `~/.pi/agent/persona-agents-sidebar.json` (each config test uses a temp path).
 *
 *   npm run test:permissions -- agent-stack/sidebar.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SIDEBAR_CONFIG_ENV,
	SidebarCompositor,
	defaultSidebarConfigPath,
	defaultSidebarEnabled,
	disposeSidebarCompositor,
	getSidebarCompositor,
	installSidebarCompositor,
	readSidebarConfig,
	toggleSidebarState,
	writeSidebarConfig,
	type SidebarTerminal,
} from "./sidebar.ts";

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
