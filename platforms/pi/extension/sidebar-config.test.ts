/**
 * Offline regression harness for the `/sidebar` config surface: the toggle
 * state and the width command. Cases that touch the config store use a temp
 * config path.
 *
 * Runs under plain Node (type stripping). No write to the real
 * `~/.pi/agent/persona-agents-sidebar.json`.
 *
 *   npm test -- platforms/pi/extension/sidebar-config.test.ts
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
	defaultSidebarConfigPath,
	defaultSidebarEnabled,
	parseSidebarWidth,
	planSidebarWidthChange,
	readSidebarConfig,
	resolveSidebarWidth,
	toggleSidebarState,
	writeSidebarConfig,
} from "./sidebar.ts";

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

test("planSidebarWidthChange does not reinstall for the current width", () => {
	assert.deepEqual(planSidebarWidthChange(["80"], 80), {
		ok: true,
		width: 80,
		shouldReinstall: false,
	});
});
