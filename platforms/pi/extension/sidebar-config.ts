/**
 * Sidebar toggle config: the width limits, the atomic toggle file, and the
 * pure toggle and width plans.
 *
 * The file is `~/.pi/agent/persona-agents-sidebar.json`. This module NEVER
 * touches `settings.json`. It paints nothing and imports no renderer.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// --- width limits -----------------------------------------------------------

/** Default right-column width. Mirrors the proven upstream range. */
export const SIDEBAR_DEFAULT_WIDTH = 45;
/** Minimum right-column width. */
export const SIDEBAR_MIN_WIDTH = 10;
/** Maximum right-column width. */
export const SIDEBAR_MAX_WIDTH = 120;

// --- config -----------------------------------------------------------------

/** Extension-owned toggle file. This is never `settings.json`. */
export const SIDEBAR_CONFIG_FILENAME = "persona-agents-sidebar.json";
/** Env override for the toggle file path. The tests use it. */
export const SIDEBAR_CONFIG_ENV = "PI_PERSONA_AGENTS_SIDEBAR_CONFIG";

/** Clamp a requested width into the supported range. */
export function clampWidth(width: number): number {
	const value = Number.isFinite(width) ? Math.floor(width) : SIDEBAR_DEFAULT_WIDTH;
	if (value < SIDEBAR_MIN_WIDTH) return SIDEBAR_MIN_WIDTH;
	if (value > SIDEBAR_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;
	return value;
}

// --- toggle config -----------------------------------------------------------

/** Persisted toggle shape. */
export interface SidebarConfig {
	enabled: boolean;
	/** Optional clamped right-column width. Absent means the default. */
	width?: number;
}

/** Result of one atomic config write. */
export interface SidebarConfigWrite {
	ok: boolean;
	enabled: boolean;
	/** The written width, when a width was requested. */
	width?: number;
	path: string;
	error?: string;
}

/** In-memory truth, kept even when a write fails. */
let inMemoryEnabled: boolean | null = null;

/**
 * The default toggle policy: ON in the TUI, OFF in every other mode.
 * A bare `/sidebar` therefore does nothing in JSON/print/RPC.
 */
export function defaultSidebarEnabled(mode: string | null | undefined): boolean {
	return mode === "tui";
}

/** The toggle file path. The env override keeps the tests off the real file. */
export function defaultSidebarConfigPath(): string {
	const override = process.env[SIDEBAR_CONFIG_ENV];
	if (override) return override;
	return join(homedir(), ".pi", "agent", SIDEBAR_CONFIG_FILENAME);
}

/**
 * Read the persisted toggle. A missing or malformed file yields
 * `fallbackEnabled`; this function never throws. Set `rememberEnabled` to false
 * for a width-only read that must not change the in-memory enable state.
 */
export function readSidebarConfig(
	configPath: string = defaultSidebarConfigPath(),
	fallbackEnabled = true,
	rememberEnabled = true,
): SidebarConfig {
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as { enabled?: unknown; width?: unknown };
			const config: SidebarConfig = { enabled: fallbackEnabled };
			if (typeof record.enabled === "boolean") {
				// A width-only read must not change the in-memory enable state.
				if (rememberEnabled) inMemoryEnabled = record.enabled;
				config.enabled = record.enabled;
			}
			// Clamp on read: a hand-edited out-of-range width must not break the
			// layout, and a stored width must survive a missing or invalid `enabled`.
			if (typeof record.width === "number") config.width = clampWidth(record.width);
			return config;
		}
	} catch {
		// A missing or malformed file falls back to the default.
	}
	return { enabled: fallbackEnabled };
}

/**
 * The effective toggle: in-memory truth wins, then the file, then the mode
 * default. Never throws.
 */
export function resolveSidebarEnabled(
	mode: string | null | undefined,
	configPath: string = defaultSidebarConfigPath(),
): boolean {
	if (inMemoryEnabled !== null) return inMemoryEnabled;
	return readSidebarConfig(configPath, defaultSidebarEnabled(mode)).enabled;
}

/** The effective right-column width: the persisted width, clamped, or the default. */
export function resolveSidebarWidth(
	configPath: string = defaultSidebarConfigPath(),
): number {
	return readSidebarConfig(configPath, true, false).width ?? SIDEBAR_DEFAULT_WIDTH;
}

/**
 * Persist the toggle with an atomic temp-file-then-rename write. On failure the
 * in-memory state is kept and the error is returned; this function never throws.
 */
export function writeSidebarConfig(
	enabled: boolean,
	configPath: string = defaultSidebarConfigPath(),
	width?: number,
): SidebarConfigWrite {
	const config: SidebarConfig = { enabled };
	// Merge instead of overwrite: an omitted width must never drop the stored one.
	const nextWidth =
		typeof width === "number" && Number.isFinite(width)
			? clampWidth(width)
			: readSidebarConfig(configPath, true, false).width;
	if (nextWidth !== undefined) config.width = nextWidth;
	inMemoryEnabled = enabled;
	const temp = `${configPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(temp, configPath);
		return { ok: true, enabled, width: config.width, path: configPath };
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file may not exist.
		}
		return {
			ok: false,
			enabled,
			width: config.width,
			path: configPath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** What the glue must do for a requested enable state. Pure. */
export interface SidebarTogglePlan {
	enabled: boolean;
	/** True when the column can be shown: enabled and in TUI mode. */
	canCompose: boolean;
	/** True when the glue must install the compositor now. */
	shouldInstall: boolean;
	/** True when the glue must dispose the compositor now. */
	shouldDispose: boolean;
}

/**
 * Plan one enable/disable. Pure: the glue applies the plan and persists the
 * state with `writeSidebarConfig`. ON in TUI, OFF elsewhere.
 */
export function toggleSidebarState(
	enabled: boolean,
	mode: string | null | undefined,
	installed: boolean,
): SidebarTogglePlan {
	const canCompose = enabled && defaultSidebarEnabled(mode);
	return {
		enabled,
		canCompose,
		shouldInstall: canCompose && !installed,
		shouldDispose: installed && !canCompose,
	};
}

/** Result of parsing a `/sidebar width <n>` argument. Pure. */
export type SidebarWidthParse =
	| { ok: true; width: number }
	| { ok: false; message: string };

/**
 * Parse and range-check a `/sidebar width <n>` argument. Pure: the glue writes
 * the width and reports the message. A bad value never reaches the layout.
 */
export function parseSidebarWidth(raw: string | undefined): SidebarWidthParse {
	const value = raw?.trim() ?? "";
	if (value.length === 0) {
		return { ok: false, message: "Usage: /sidebar width <n>." };
	}
	if (!/^\d+$/.test(value)) {
		return {
			ok: false,
			message: `Invalid width "${value}". Use an integer from ${SIDEBAR_MIN_WIDTH} to ${SIDEBAR_MAX_WIDTH}.`,
		};
	}
	const width = Number(value);
	if (width < SIDEBAR_MIN_WIDTH || width > SIDEBAR_MAX_WIDTH) {
		return {
			ok: false,
			message: `Width ${width} is out of range. Use ${SIDEBAR_MIN_WIDTH} to ${SIDEBAR_MAX_WIDTH}.`,
		};
	}
	return { ok: true, width };
}

/** What the glue must do for a requested width change. Pure. */
export type SidebarWidthPlan =
	| { ok: true; width: number; shouldReinstall: boolean }
	| { ok: false; message: string };

/**
 * Plan one `/sidebar width <n>` change from the tokens after `width`. Pure: the
 * glue persists the width, reinstalls the compositor on a real change, and
 * reports the message. `current` is the width the compositor already uses.
 */
export function planSidebarWidthChange(
	input: readonly string[],
	current: number,
): SidebarWidthPlan {
	if (input.length > 1) {
		return { ok: false, message: "Unexpected argument. Usage: /sidebar width <n>." };
	}
	const parsed = parseSidebarWidth(input[0]);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		width: parsed.width,
		shouldReinstall: parsed.width !== current,
	};
}
