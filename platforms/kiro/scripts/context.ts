/**
 * The Kiro SessionStart context: the persona, the Kiro platform note, the
 * session id, and the startup read list.
 *
 *   context.ts session   the platform note and the theme persona
 *   context.ts startup   the read list: project rules and summary, the last
 *                        three session-log days, open task notes, unfinished
 *                        studies
 *
 * The profession itself is the agent profile's `prompt` (the shared
 * content/professions/companion.md), so it is not repeated here. Both modes
 * write plain text to stdout; Kiro adds a SessionStart command hook's stdout
 * to the agent context.
 *
 * The persona branch in the shared skills keys on the line "Running in Kiro
 * CLI", so the exact phrase stays.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	ContentError,
	loadRegistry,
	personaSection,
	personaText,
	resolveTheme,
	type Registry,
} from "../../shared/context/context.ts";
import { startupContext } from "../../shared/notes/notes.ts";
import { projectDir, projectName } from "../../shared/notes/notes-paths.ts";
import { contentOf, kiroHome as resolveKiroHome, readTheme, rootFromScript } from "./paths.ts";
import { option } from "../../shared/argv.ts";

/** The Kiro platform note, with the session id the wrap-up and retro use. */
export function platformNote(sessionId: string, theme?: string): string {
	return [
		theme ? `## Running in Kiro CLI (persona theme: ${theme})` : "## Running in Kiro CLI",
		"",
		"- Load a skill with the `load_resource` tool: `{\"id\": \"skill::<name>\"}`. Skills also run as `/<name>`.",
		"- To review a change, load the `review` skill first; its Kiro branch builds the brief and the change key the commit gate needs.",
		"- Ask the owner in chat and wait; Kiro has no question tool.",
		"- The shell tool takes a `cwd`; pass it instead of prefixing a command with `cd`, so the permission rules match the command.",
		"- The adapter scripts are TypeScript: run them with `node --experimental-strip-types --no-warnings <path> <args>`.",
		"- A wide read-only search is a `subagent` run when one is configured; otherwise read the files yourself.",
		`- Your session id is \`${sessionId}\`; the wrap-up and retro reference files use it.`,
	].join("\n");
}

/** The session-start text: the platform note, the theme, and the persona. */
export function sessionContext(contentDir: string, theme: string, sessionId: string): string {
	const registry: Registry = loadRegistry(contentDir);
	const wanted = resolveTheme(registry, theme);
	const persona = personaText(contentDir, registry, wanted, { profession: "companion" });
	const parts = [platformNote(sessionId, wanted)];
	if (persona) parts.push("", personaSection(wanted, persona));
	return parts.join("\n");
}

/** The startup read list, with the session id at the top. */
export function startupText(cwd: string, home: string, sessionId: string): string {
	const notesDir = projectDir(cwd, home);
	return [`Session id: \`${sessionId}\``, "", startupContext(notesDir, projectName(cwd))].join("\n");
}

interface ContextOptions {
	contentDir: string;
	home: string;
	kiroHome: string;
}

/** The text for one hook mode, or null when the mode is unknown. */
export function contextFor(
	mode: string,
	input: { session_id?: unknown; cwd?: unknown },
	options: ContextOptions,
): { text: string; warning?: string } | null {
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	if (!sessionId) return null;
	if (mode === "session") {
		const theme = readTheme(options.kiroHome);
		try {
			return { text: sessionContext(options.contentDir, theme, sessionId) };
		} catch (error) {
			const reason = error instanceof ContentError ? error.message : String(error);
			return {
				text: platformNote(sessionId),
				warning: `persona-agents: ${reason}; running without a persona`,
			};
		}
	}
	if (mode === "startup") {
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
		return { text: startupText(cwd, options.home, sessionId) };
	}
	return null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: unknown; cwd?: unknown };
	const home = option("home", process.argv) ?? homedir();
	const result = contextFor(process.argv[2] ?? "", input, {
		home,
		kiroHome: option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home),
		contentDir: option("content", process.argv) ?? contentOf(rootFromScript(import.meta.url)),
	});
	if (result?.warning) process.stderr.write(`${result.warning}\n`);
	if (result) process.stdout.write(`${result.text}\n`);
}
