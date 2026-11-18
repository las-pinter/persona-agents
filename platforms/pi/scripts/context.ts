/**
 * The prompt text a Pi companion run gets, built from the shared content tree.
 *
 *   content/professions/<profession>.md   the work rules, verbatim
 *   content/agents.json                   theme -> persona file
 *   content/personas/<theme>/<file>.md    the voice
 *
 * The work rules are shared with the Claude adapter. Where the two harnesses
 * differ (which tool asks the owner, which subagent does a wide search), the
 * difference goes in the platform note below, not in the shared file: content
 * stays platform-neutral, adapters hold the delta.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THEME, type Profile } from "./profile.ts";

export interface PersonaEntry {
	personaFile: string;
	description?: string;
	welcomeMessage?: string;
}

/** theme -> profession -> entry. */
export type Registry = Record<string, Record<string, PersonaEntry>>;

export class ContentError extends Error {}

/** The theme registry from content/agents.json. */
export function loadRegistry(contentDir: string): Registry {
	const file = join(contentDir, "agents.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new ContentError(`persona-agents: cannot read ${file}: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ContentError(`persona-agents: ${file} must hold an object`);
	}
	return parsed as Registry;
}

/** The theme names, sorted. */
export function themeNames(registry: Registry): string[] {
	return Object.keys(registry).sort();
}

/** The theme to run, validated against the registry. */
export function resolveTheme(registry: Registry, wanted: string | undefined | null): string {
	if (!wanted) return DEFAULT_THEME;
	if (wanted in registry) return wanted;
	throw new ContentError(`persona-agents: unknown persona theme "${wanted}"; known themes: ${themeNames(registry).join(", ")}`);
}

/** The profession rules, verbatim. */
export function professionText(contentDir: string, profession: string): string {
	const file = join(contentDir, "professions", `${profession}.md`);
	try {
		return readFileSync(file, "utf8").trim();
	} catch (error) {
		throw new ContentError(`persona-agents: cannot read ${file}: ${(error as Error).message}`);
	}
}

/** The persona text of a theme for a profile, or null when the theme maps none. */
export function personaText(contentDir: string, registry: Registry, theme: string, profile: Profile): string | null {
	if (!profile.profession) return null;
	const entry = registry[theme]?.[profile.profession];
	if (!entry?.personaFile) return null;
	const file = join(contentDir, "personas", theme, entry.personaFile);
	try {
		return readFileSync(file, "utf8").trim();
	} catch (error) {
		throw new ContentError(`persona-agents: cannot read ${file}: ${(error as Error).message}`);
	}
}

/**
 * What differs between the harnesses, in one short block. The shared
 * profession says "ask the owner with the question tool" and "use the Explore
 * agent"; this note names the Pi shapes of both.
 */
export function platformNote(profile: Profile): string {
	const lines = [
		"## Running in Pi",
		"",
		"- A skill loads by reading its `SKILL.md` at the path Pi lists, or with `/skill:<name>`.",
		"- Ask the owner with the `ask_user_question` tool when it is available; otherwise ask in chat and wait.",
		"- A wide read-only search is the `scout` subagent when it exists; otherwise read the files yourself.",
	];
	if (!profile.writable) {
		lines.push("- You are read-only: you may read, search, and run the test suite once, and may not change files.");
	}
	return lines.join("\n");
}

/** Every prompt section the agent's run needs, keyed by section name. */
export function promptSections(
	contentDir: string,
	registry: Registry,
	theme: string,
	profile: Profile,
): Record<string, string> {
	const sections: Record<string, string> = { platform: platformNote(profile) };
	if (profile.profession) sections.profession = professionText(contentDir, profile.profession);
	if (profile.persona) {
		const persona = personaText(contentDir, registry, theme, profile);
		if (persona) {
			sections.persona = [
				`# Your persona (theme: ${theme})`,
				"",
				"Speak as the persona below in chat: use its name, voice, and quirks, also when you introduce yourself.",
				"Your profession rules take precedence over the persona on what you do.",
				"Code, commits, notes, studies, and journals stay persona-free.",
				"",
				persona,
			].join("\n");
		}
	}
	return sections;
}
