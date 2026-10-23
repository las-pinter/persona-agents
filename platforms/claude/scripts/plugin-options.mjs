// plugin-options — read a persona-agents userConfig option live, at hook run time.
//
// Claude Code sets CLAUDE_PLUGIN_OPTION_<NAME> once at start, so a change in
// /config would need a restart. The hooks read the live settings files first:
//
//   1. managed settings: the last managed-settings.d drop-in that sets the
//      option, else managed-settings.json
//   2. user settings.json (CLAUDE_CONFIG_DIR, else ~/.claude)
//   3. CLAUDE_PLUGIN_OPTION_<NAME>, unless the caller turns it off
//      (subagent-model.mjs does, because a project env block can set it)
//
// Not read: server-managed settings, the macOS plist policy, and the Windows
// registry policy. An option set only there comes from the start-time env var.
//
// A project .claude/settings.json can set env vars for the session, so the
// paths do not come from a free env var:
//   - The managed path is the fixed system path. Only a hook command argument
//     `--managed-settings=<path>` replaces it (the tests use it). A settings
//     env block cannot set a hook argument.
//   - CLAUDE_CONFIG_DIR and HOME are ignored when they resolve inside
//     CLAUDE_PROJECT_DIR or the current working directory. A project dir that
//     is the real home dir (the passwd entry) or a parent of it does not count.
//     When the passwd lookup fails, the home exemption is off. HOME then applies
//     only when it is outside the project; else no user settings are read.
//   - A project env block cannot replace CLAUDE_PROJECT_DIR for hooks: a probe
//     (Claude Code 2.1.309) with CLAUDE_PROJECT_DIR set in a project
//     .claude/settings.json env block gave the hook the real project dir.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// Another marketplace name gives another key, so the lookup misses it and falls back to the env var
// (or to the caller's default when the env fallback is off, as for subagent_model).
const PLUGIN_ID = "persona-agents@persona-agents";
const MANAGED_SETTINGS = {
	linux: "/etc/claude-code/managed-settings.json",
	darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
	win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
};
const MANAGED_ARG = "--managed-settings=";

/** The option from one settings file, or "" when the file or key is missing or bad. */
export function settingsOption(file, name) {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"))?.pluginConfigs?.[PLUGIN_ID]?.options?.[name];
		return typeof value === "string" ? value : "";
	} catch {
		return "";
	}
}

/**
 * The managed option: the last managed-settings.d drop-in that sets it, else managed-settings.json.
 * An empty or non-string value counts as not set, so an earlier source still applies (Claude Code's deep merge would keep the empty value).
 */
export function managedOption(managedFile, name) {
	const dir = join(dirname(managedFile), "managed-settings.d");
	let names = [];
	try {
		names = readdirSync(dir).filter((file) => file.endsWith(".json") && !file.startsWith("."));
	} catch {
		// The drop-in directory is often missing.
	}
	// Plain code-unit order; no locale collation.
	names.sort();
	for (let i = names.length - 1; i >= 0; i--) {
		const value = settingsOption(join(dir, names[i]), name);
		if (value) return value;
	}
	return settingsOption(managedFile, name);
}

/**
 * The real path when it exists, else the resolved path.
 * The native call gives the on-disk case (macOS, Windows) and expands Windows 8.3 short names.
 */
function realOrResolved(path) {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

/** The home dir from the passwd entry, which env vars cannot change; "" when the lookup fails (a uid with no entry). */
export function realHome() {
	try {
		return userInfo().homedir || "";
	} catch {
		return "";
	}
}

/** True when dir is base or inside it. */
function isInside(dir, base) {
	const rel = relative(realOrResolved(base), realOrResolved(dir));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when dir is inside the project directory or the current working directory.
 * A base that is the real home dir or a parent of it is skipped: there, every user config dir
 * would count as inside, and a repo rooted at home already shares ~/.claude with user scope.
 * With no home (an empty home), no base is skipped.
 */
export function inProject(dir, env = process.env, cwd = process.cwd(), home = realHome()) {
	const bases = [cwd, env.CLAUDE_PROJECT_DIR].filter(
		(base) => typeof base === "string" && base !== "" && !(home && isInside(home, base)),
	);
	return bases.some((base) => isInside(dir, base));
}

/**
 * The user config dir: CLAUDE_CONFIG_DIR, else .claude in the home dir; a dir inside the project is ignored.
 * A HOME inside the project gives way to the passwd home; with no passwd home, the result is ""
 * (no user config dir), so the user settings are skipped.
 */
export function userConfigDir(env = process.env, cwd = process.cwd(), home = realHome()) {
	const configDir = env.CLAUDE_CONFIG_DIR;
	if (configDir && !inProject(configDir, env, cwd, home)) return configDir;
	let userHome = homedir();
	if (inProject(userHome, env, cwd, home)) {
		if (!home) return "";
		userHome = home;
	}
	return join(userHome, ".claude");
}

/** The managed settings path: the hook argument --managed-settings=<path>, else the system path. */
function managedPath() {
	const arg = process.argv.find((value) => value.startsWith(MANAGED_ARG));
	return arg ? arg.slice(MANAGED_ARG.length) : MANAGED_SETTINGS[process.platform];
}

/**
 * The option value: managed settings, then user settings, then the env var; "" when none sets it.
 * With envFallback false, the env var is not read.
 */
export function pluginOption(name, { envFallback = true } = {}) {
	const managed = managedPath();
	const userDir = userConfigDir();
	// Project settings are skipped: Claude Code reads pluginConfigs from user and managed settings only.
	return (
		(managed && managedOption(managed, name)) ||
		(userDir && settingsOption(join(userDir, "settings.json"), name)) ||
		(envFallback && process.env[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`]) ||
		""
	);
}
