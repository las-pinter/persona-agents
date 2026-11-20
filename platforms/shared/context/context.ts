/**
 * The prompt text a companion run gets, built from the shared content tree.
 *
 *   content/professions/<profession>.md   the work rules, verbatim
 *   content/agents.json                   theme -> persona file
 *   content/personas/<theme>/<file>.md    the voice
 *
 * The work rules are shared by every adapter. Where the harnesses differ
 * (which tool asks the owner, which subagent does a wide search), the
 * difference goes in an adapter's platform note, not in the shared content:
 * content stays platform-neutral, adapters hold the delta.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The theme used when neither a flag nor a settings file names one. */
export const DEFAULT_THEME = "goblin";

export interface PersonaEntry {
	personaFile: string;
	description?: string;
	welcomeMessage?: string;
}

/** theme -> profession -> entry. */
export type Registry = Record<string, Record<string, PersonaEntry>>;

export class ContentError extends Error {}

/** The part of an agent profile the prompt builder needs. */
export interface PromptTarget {
	/** The content/professions file that holds the work rules, or null. */
	profession?: string | null;
	/** Whether the theme persona is added to the prompt. */
	persona?: boolean;
}

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
	if (Object.hasOwn(registry, wanted)) return wanted;
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

/** The persona text of a theme for a profession, or null when the theme maps none. */
export function personaText(contentDir: string, registry: Registry, theme: string, target: PromptTarget): string | null {
	if (!target.profession) return null;
	const entry = registry[theme]?.[target.profession];
	if (!entry?.personaFile) return null;
	const file = join(contentDir, "personas", theme, entry.personaFile);
	try {
		return readFileSync(file, "utf8").trim();
	} catch (error) {
		throw new ContentError(`persona-agents: cannot read ${file}: ${(error as Error).message}`);
	}
}

/** The persona section: the voice, with the profession kept in charge. */
export function personaSection(theme: string, persona: string): string {
	return [
		`# Your persona (theme: ${theme})`,
		"",
		"Speak as the persona below in chat: use its name, voice, and quirks, also when you introduce yourself.",
		"Your profession rules take precedence over the persona on what you do.",
		"Code, commits, notes, studies, and journals stay persona-free.",
		"",
		persona,
	].join("\n");
}

/** Every prompt section a run needs, keyed by section name. The platform note is the adapter's. */
export function promptSections(
	contentDir: string,
	registry: Registry,
	theme: string,
	target: PromptTarget,
	platform: string,
): Record<string, string> {
	const sections: Record<string, string> = { platform };
	if (target.profession) sections.profession = professionText(contentDir, target.profession);
	if (target.persona) {
		const persona = personaText(contentDir, registry, theme, target);
		if (persona) sections.persona = personaSection(theme, persona);
	}
	return sections;
}
