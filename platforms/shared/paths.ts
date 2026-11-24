/**
 * Path helpers every adapter needs: symlink-aware containment and `~`
 * expansion. One copy, so the gates agree on what "inside" means.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The real path when it exists, else the resolved path. */
export function realOrResolved(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

/** True when `path` is `base` or inside it, resolving a symlink that exists. */
export function insideDir(path: string, base: string): boolean {
	const rel = relative(realOrResolved(base), realOrResolved(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A path with a leading `~` or `~/` expanded to the home folder; `~user` is left as it is. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
