/**
 * Where the package's own files live, for the Pi adapter.
 *
 * The extension runs from `platforms/pi/extensions/index.ts` inside the
 * installed package, so the package root (which holds `content/`) is resolved
 * from this module's own URL. No environment variable decides it: a project
 * settings env block could point it anywhere else.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This module's directory: `<root>/platforms/pi/scripts`. */
const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** The package root, which holds `content/` and `platforms/`. */
export function repoRoot(): string {
	return join(scriptsDir, "..", "..", "..");
}

/** The shared content tree: professions, personas, skills, agents.json. */
export function contentDir(): string {
	return join(repoRoot(), "content");
}

/** The owner's home folder, read once per call so a test can pass its own. */
export function homeDir(): string {
	return homedir();
}

/** The agent-notes root, next to the home folder. */
export function notesRoot(home: string = homeDir()): string {
	return join(home, "agent-notes");
}
