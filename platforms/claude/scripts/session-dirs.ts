/**
 * The session's additional working directories, for the doctrine gate's `cd`
 * part.
 *
 * A PreToolUse hook input carries `cwd` but not the additional directories
 * (Claude Code's hooks docs list no such field and no environment variable),
 * so the hook reads them from the settings files that grant them:
 *
 *   1. managed settings: the base file and every `managed-settings.d` drop-in
 *   2. user settings (`CLAUDE_CONFIG_DIR`, else `~/.claude`)
 *   3. project `.claude/settings.json` and `.claude/settings.local.json`
 *
 * These are the directories Claude Code itself grants file access to. `~`
 * expands to the home folder; a relative entry resolves against the project
 * root; a malformed file grants nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { managedPath, userConfigDir } from "./plugin-options.mjs";
import { expandHome } from "../../shared/paths.ts";

/** The paths and env a test supplies in place of the real ones. */
export interface DirSources {
	home?: string;
	configDir?: string;
	managedFile?: string;
	projectDir?: string;
}

/** The `permissions.additionalDirectories` of one settings file. */
function additionalIn(file: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { permissions?: { additionalDirectories?: unknown } };
		const list = parsed?.permissions?.additionalDirectories;
		return Array.isArray(list) ? list.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}

/** The managed settings files: the base file and every drop-in, in name order. */
function managedFiles(base: string | undefined): string[] {
	if (!base) return [];
	const dir = join(dirname(base), "managed-settings.d");
	let names: string[] = [];
	try {
		names = readdirSync(dir)
			.filter((name) => name.endsWith(".json") && !name.startsWith("."))
			.sort();
	} catch {
		// The drop-in directory is often missing.
	}
	return [base, ...names.map((name) => join(dir, name))];
}

/**
 * The additional working directories of the session, absolute and without
 * duplicates.
 */
export function sessionDirs(cwd: string, sources: DirSources = {}): string[] {
	const home = sources.home ?? homedir();
	const project = sources.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? cwd;
	const configDir = sources.configDir ?? userConfigDir();
	const managed = sources.managedFile ?? managedPath();
	const files = [
		...managedFiles(managed),
		...(configDir === "" ? [] : [join(configDir, "settings.json")]),
		join(project, ".claude", "settings.json"),
		join(project, ".claude", "settings.local.json"),
	];
	const found = new Set<string>();
	for (const file of files) {
		for (const value of additionalIn(file)) {
			let path = expandHome(value, home);
			if (!isAbsolute(path)) path = join(project, path);
			found.add(resolve(path));
		}
	}
	return [...found];
}
