/**
 * The Pi adapter's prompt context: the shared content tree plus the Pi platform
 * note.
 *
 * The shared builder lives in `platforms/shared/context/`; this file adds only
 * what differs on Pi: skill loading, the question tool, and the wide-search
 * subagent. The reviewer's read-only note is also here.
 */

import {
	personaText as sharedPersonaText,
	promptSections as sharedPromptSections,
	type PromptTarget,
	type Registry,
} from "../../shared/context/context.ts";
import type { Profile } from "./profile.ts";

export {
	ContentError,
	DEFAULT_THEME,
	loadRegistry,
	personaSection,
	professionText,
	resolveTheme,
	themeNames,
} from "../../shared/context/context.ts";
export type { PersonaEntry, PromptTarget, Registry } from "../../shared/context/context.ts";

/** The persona text of a theme for a profile, or null when the theme maps none. */
export function personaText(contentDir: string, registry: Registry, theme: string, profile: PromptTarget): string | null {
	return sharedPersonaText(contentDir, registry, theme, profile);
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
		"- To review a change, call the `review` tool; do not review it in place.",
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
	return sharedPromptSections(contentDir, registry, theme, profile, platformNote(profile));
}
