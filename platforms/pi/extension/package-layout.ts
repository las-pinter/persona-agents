/**
 * Package layout: where this package keeps each resource, and the package root.
 *
 * This module resolves `import.meta.url`, so it must stay in the extension
 * folder: the depth of 3 is counted from `platforms/pi/extension/`.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { isDirectory } from "./path-glob.ts";

/**
 * Where the package keeps each resource, relative to the package root. The
 * shared content (agents.json, personas, professions, skills) lives under
 * `content/`; the pi-only files live under `platforms/pi/`.
 */
export const PACKAGE_LAYOUT = {
	agentsJson: path.join("content", "agents.json"),
	personas: path.join("content", "personas"),
	professions: path.join("content", "professions"),
	skills: path.join("content", "skills"),
	piFrontmatters: path.join("platforms", "pi", "frontmatters"),
	piAgents: path.join("platforms", "pi", "agents"),
} as const;

/** This file's depth below the package root: platforms/pi/extension/. */
const EXTENSION_DIR_DEPTH = 3;

/** Package root when this extension is loaded from a pi package (git/local install). */
export function getPackageRoot(): string | null {
	const candidate = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		...Array<string>(EXTENSION_DIR_DEPTH).fill(".."),
	);
	if (!isDirectory(candidate)) return null;
	// Only treat it as a package root when it holds the package personas or
	// agents, so plain copies under ~/.pi/agent/extensions fall back to user dirs.
	if (
		isDirectory(path.join(candidate, PACKAGE_LAYOUT.piAgents)) ||
		isDirectory(path.join(candidate, PACKAGE_LAYOUT.personas))
	) {
		return candidate;
	}
	return null;
}
