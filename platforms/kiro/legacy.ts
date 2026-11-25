/**
 * Migration of a Kiro install made under the old project name, persona-agents
 * (5.x). The 6.x installer adopts it: the old payload folder becomes the new
 * one, so the theme and the state carry over; skill folders with the old
 * marker count as ours; the old agent files are renamed to `.bak-<stamp>`.
 *
 * This module is the one place the old name stays. Remove it, and its call
 * sites in install.ts, in the first release after 6.0.0.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_NAME = "persona-agents";
export const LEGACY_MARKER = ".persona-agents.json";
export const LEGACY_AGENTS = ["pa-companion", "pa-reviewer", "pa-writer"] as const;

/** What an old install left in a Kiro home. */
export interface LegacyInstall {
	/** The old payload folder, when it exists. */
	payload: string | null;
	/** True when the old payload can become the new one: the new one is absent. */
	adoptPayload: boolean;
	/** The old agent files that exist. */
	agents: string[];
}

/** The old install in a Kiro home; an empty result when there is none. */
export function findLegacy(kiroHome: string, newPayload: string): LegacyInstall {
	const old = join(kiroHome, LEGACY_NAME);
	const payload = existsSync(old) ? old : null;
	const agents = LEGACY_AGENTS.map((name) => join(kiroHome, "agents", `${name}.json`)).filter((file) => existsSync(file));
	return { payload, adoptPayload: payload !== null && !existsSync(newPayload), agents };
}

/** True when a skill folder carries the old marker. */
export function hasLegacyMarker(dir: string): boolean {
	return existsSync(join(dir, LEGACY_MARKER));
}

/** The theme in the old payload config, or the fallback. */
export function legacyTheme(kiroHome: string, fallback: string): string {
	try {
		const parsed = JSON.parse(readFileSync(join(kiroHome, LEGACY_NAME, "config.json"), "utf8")) as { theme?: unknown };
		return typeof parsed?.theme === "string" && parsed.theme !== "" ? parsed.theme : fallback;
	} catch {
		return fallback;
	}
}

/** The warning for an old payload the installer cannot adopt, or for a default agent it removes. */
export function legacyWarnings(found: LegacyInstall, defaultAgent: string): string[] {
	const warnings: string[] = [];
	if (found.payload && !found.adoptPayload) {
		warnings.push(`the old payload ${found.payload} stays beside the new one; delete it when you no longer need its state`);
	}
	// Only an agent file this install retires; a missing one is defaultAgentWarning's case.
	if ((LEGACY_AGENTS as readonly string[]).includes(defaultAgent) && found.agents.some((file) => file.endsWith(`/${defaultAgent}.json`))) {
		warnings.push(`chat.defaultAgent is set to "${defaultAgent}", which this install removes; set it to "${defaultAgent.replace(/^pa-/, "ca-")}"`);
	}
	return warnings;
}

/** The plan lines for a dry run. */
export function legacyActions(found: LegacyInstall, newPayload: string): string[] {
	const actions: string[] = [];
	if (found.adoptPayload && found.payload) actions.push(`migrate: move ${found.payload} to ${newPayload}`);
	for (const file of found.agents) actions.push(`migrate: back up and remove old agent ${file}`);
	return actions;
}

/**
 * Move the old payload into place and retire the old agent files as
 * `<file>.bak-<stamp>`, so an owner's edit survives; returns the lines done.
 */
export function migrateLegacy(found: LegacyInstall, newPayload: string, stamp: string): string[] {
	const done: string[] = [];
	if (found.adoptPayload && found.payload) {
		renameSync(found.payload, newPayload);
		done.push(`migrated: moved ${found.payload} to ${newPayload}`);
	}
	for (const file of found.agents) {
		renameSync(file, `${file}.bak-${stamp}`);
		done.push(`migrated: backed up and removed old agent ${file} (${file}.bak-${stamp})`);
	}
	return done;
}
