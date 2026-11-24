/**
 * The Kiro adapter's paths.
 *
 *   <kiro home>/persona-agents/   the installed payload (this adapter and the
 *                                 shared modules, plus a copy of content/)
 *   <kiro home>/persona-agents/config.json   the selected theme
 *   <kiro home>/agents/           the agent profiles the installer writes
 *   <kiro home>/skills/           the skills the installer copies
 *   <kiro home>/sessions/         the V3 session store
 *
 * Kiro's global directory is `KIRO_HOME`, else `~/.kiro`. Kiro ignores a
 * relative path, a filesystem root, the home folder, or one of its ancestors;
 * this module does the same, so a bad value falls back to `~/.kiro` instead of
 * writing somewhere unexpected.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THEME } from "../../shared/context/context.ts";
import { safeSession } from "../../shared/notes/session-log.ts";

/**
 * True when Kiro accepts this as its global directory: absolute, not a
 * filesystem root, and not the home folder or one of its ancestors.
 */
export function validKiroHome(value: string, home: string = homedir()): boolean {
	if (!isAbsolute(value)) return false;
	const candidate = resolve(value);
	const realHome = resolve(home);
	const isRoot = candidate === resolve("/") || /^[A-Za-z]:[\\/]?$/.test(candidate);
	const holdsHome = realHome === candidate || realHome.startsWith(candidate + sep);
	return !isRoot && !holdsHome;
}

/** The global Kiro directory: a valid KIRO_HOME, else `<home>/.kiro`. */
export function kiroHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const wanted = env.KIRO_HOME;
	if (typeof wanted === "string" && validKiroHome(wanted, home)) return resolve(wanted);
	return join(resolve(home), ".kiro");
}

/** The installed payload folder. */
export const payloadDir = (home: string): string => join(home, "persona-agents");

/** The theme config file. */
export const configFile = (home: string): string => join(payloadDir(home), "config.json");

/** The adapter's state folder: review records, compaction manifests, metrics. */
export const stateDir = (home: string): string => join(payloadDir(home), "state");

/** A file-name-safe session id; an empty id becomes `unknown`. */
export const safeId = (id: string): string => safeSession(id || "unknown");

/** The global skills folder. */
export const skillsDir = (home: string): string => join(home, "skills");

/** The V3 session store root. */
export const sessionsDir = (home: string): string => join(home, "sessions");

/**
 * The payload root from a script's own URL: `<payload>/platforms/kiro/scripts/`
 * is three folders below it, in the repository and in the installed copy alike.
 */
export function rootFromScript(scriptUrl: string): string {
	return resolve(dirname(fileURLToPath(scriptUrl)), "..", "..", "..");
}

/** The content folder under a payload root. */
export const contentOf = (root: string): string => join(root, "content");

/** The configured theme, or the fallback when the file is missing or bad. */
export function readTheme(home: string, fallback: string = DEFAULT_THEME): string {
	try {
		const parsed = JSON.parse(readFileSync(configFile(home), "utf8")) as { theme?: unknown };
		return typeof parsed?.theme === "string" && parsed.theme !== "" ? parsed.theme : fallback;
	} catch {
		return fallback;
	}
}
