/**
 * Resource expansion: frontmatter globs resolved to inlined text or to paths.
 *
 * Walks the working directory once, then folds the include and exclude
 * patterns. The three budgets below cap the depth and the inlined bytes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { globToRegExp, isDirectory } from "./path-glob.ts";

// ---------------------------------------------------------------------------
// Resources (file globs attached to the agent context)
// ---------------------------------------------------------------------------

export interface ResourcesResult {
	/** File contents inlined into the prompt (small files). */
	inlined: { path: string; content: string }[];
	/** Larger matched files; only paths are listed so the agent can read them. */
	paths: string[];
}

const RESOURCE_SKIP_DIRS = new Set([".git", "node_modules", ".pi", ".venv", "dist", "build", ".cache"]);

// Tunable resource budgets, not yet settings-backed.
const MAX_INLINE_BYTES_PER_FILE = 4096;
const MAX_TOTAL_RESOURCE_BYTES = 32768;
const MAX_RESOURCE_DIR_DEPTH = 8;

function walkFiles(dir: string, relPrefix: string, depth: number, out: string[]): void {
	if (depth > MAX_RESOURCE_DIR_DEPTH) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (RESOURCE_SKIP_DIRS.has(entry.name)) continue;
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(abs, rel, depth + 1, out);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			out.push(rel);
		}
	}
}

/** Expand "!exclusion" patterns (same convention as pi package manifests). */
function expandsTo(patterns: string[]): { include: RegExp[]; exclude: RegExp[] } {
	const include: RegExp[] = [];
	const exclude: RegExp[] = [];
	for (const raw of patterns) {
		const p = raw.trim();
		if (!p) continue;
		if (p.startsWith("!")) {
			exclude.push(globToRegExp(p.slice(1)));
		} else {
			include.push(globToRegExp(p));
		}
	}
	return { include, exclude };
}

/**
 * Resolve frontmatter `resources:` globs relative to cwd. Matched files are
 * inlined when under maxInlineBytesPerFile; larger files are listed as paths.
 */
export function resolveResources(
	patterns: string[] | undefined,
	cwd: string,
	maxInlineBytesPerFile = MAX_INLINE_BYTES_PER_FILE,
	maxTotalBytes = MAX_TOTAL_RESOURCE_BYTES,
): ResourcesResult {
	const result: ResourcesResult = { inlined: [], paths: [] };
	if (!patterns || patterns.length === 0 || !isDirectory(cwd)) return result;

	const all: string[] = [];
	walkFiles(cwd, "", 0, all);
	const { include, exclude } = expandsTo(patterns);

	let total = 0;
	for (const rel of all) {
		const posix = rel.split(path.sep).join("/");
		if (exclude.some((re) => re.test(posix))) continue;
		if (!include.some((re) => re.test(posix))) continue;

		if (total >= maxTotalBytes) {
			result.paths.push(rel);
			continue;
		}
		try {
			const stat = fs.statSync(path.join(cwd, rel));
			if (stat.size <= maxInlineBytesPerFile) {
				const content = fs.readFileSync(path.join(cwd, rel), "utf-8");
				if (total + content.length <= maxTotalBytes) {
					total += content.length;
					result.inlined.push({ path: rel, content });
				} else {
					result.paths.push(rel);
				}
			} else {
				result.paths.push(rel);
			}
		} catch {
			result.paths.push(rel);
		}
	}
	return result;
}
