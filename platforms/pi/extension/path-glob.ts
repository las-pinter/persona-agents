/**
 * Path helpers shared by `resolver.ts` and `skill-discovery.ts`: a directory
 * check, the nearest `.pi/<subdir>` search, and the frontmatter glob matcher.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestConfigDir(cwd: string, subdir: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, subdir);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ---------------------------------------------------------------------------
// Glob matching, shared with skill discovery
// ---------------------------------------------------------------------------

/** Convert a frontmatter glob to RegExp. A double-star slash means any depth (incl. none); a single star is one path segment; a question mark is one char. */
export function globToRegExp(pattern: string): RegExp {
	const parts: string[] = [];
	for (let i = 0; i < pattern.length; ) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*" && pattern[i + 2] === "/") {
				parts.push("(?:.*/)?");
				i += 3;
			} else if (pattern[i + 1] === "*") {
				parts.push(".*");
				i += 2;
			} else {
				parts.push("[^/]*");
				i += 1;
			}
		} else if (ch === "?") {
			parts.push("[^/]");
			i += 1;
		} else if ("\\^$.*+()[]{}|".includes(ch)) {
			parts.push("\\" + ch);
			i += 1;
		} else {
			parts.push(ch);
			i += 1;
		}
	}
	return new RegExp(`^${parts.join("")}$`);
}

// Skill patterns and resource patterns both run through this matcher.
