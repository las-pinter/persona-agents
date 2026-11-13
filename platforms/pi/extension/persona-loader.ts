/**
 * Persona discovery for the persona-agents pi package.
 *
 * Two layouts share one read path:
 *   - a bare file:   <dir>/<name>.md
 *   - a theme file:  <dir>/<theme>/<name>.md
 *
 * Persona files are format-tolerant: legacy persona files (plain markdown
 * starting with a `# heading`) work as-is; an optional frontmatter block adds
 * name/description metadata. The filename stem stays available, because
 * agents.json maps a (theme, profession) pair to a persona file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface PersonaConfig {
	name: string;
	theme?: string;
	description?: string;
	/** The persona's full markdown body (prompt content). Legacy files are used verbatim. */
	body: string;
	filePath: string;
	/** Filename stem (without .md) — used to match agents.json personaFile references. */
	fileNameStem: string;
}

/** First `# heading` line if present (used as description fallback for legacy personas). */
function headingFromBody(body: string): string | undefined {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			return trimmed.replace(/^#+\s*/, "").trim();
		}
		if (trimmed && !trimmed.startsWith("#")) return undefined;
	}
	return undefined;
}

/** The filename without its `.md` suffix. */
export function fileNameStem(filePath: string): string {
	return path.basename(filePath).replace(/\.md$/, "");
}

/**
 * Read one persona file. Returns null when the file cannot be read or parsed,
 * so one bad file never stops the rest of the directory.
 *
 * A bare file and a theme file call this same path: only the theme differs.
 */
export function readPersona(filePath: string, theme?: string): PersonaConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	try {
		const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
		const stem = fileNameStem(filePath);
		const name = (typeof frontmatter.name === "string" && frontmatter.name) || stem;
		return {
			name,
			...(theme === undefined ? {} : { theme }),
			description: typeof frontmatter.description === "string" ? frontmatter.description : headingFromBody(body),
			body,
			filePath,
			fileNameStem: stem,
		};
	} catch {
		return null;
	}
}

/** Load every persona file in one directory: bare files and <theme>/<name>.md. */
export function loadPersonasFromDir(dir: string): PersonaConfig[] {
	const personas: PersonaConfig[] = [];
	if (!fs.existsSync(dir)) return personas;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return personas;
	}

	for (const entry of entries) {
		if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
			const persona = readPersona(path.join(dir, entry.name));
			if (persona) personas.push(persona);
			continue;
		}
		if (!entry.isDirectory()) continue;

		const theme = entry.name;
		let themeEntries: fs.Dirent[];
		try {
			themeEntries = fs.readdirSync(path.join(dir, theme), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const themeEntry of themeEntries) {
			if (!themeEntry.name.endsWith(".md")) continue;
			if (!themeEntry.isFile() && !themeEntry.isSymbolicLink()) continue;
			const persona = readPersona(path.join(dir, theme, themeEntry.name), theme);
			if (persona) personas.push(persona);
		}
	}

	return personas;
}
