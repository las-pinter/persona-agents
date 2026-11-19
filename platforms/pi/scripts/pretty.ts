/**
 * The shaping behind the pretty results: a path list as a tree, grep output
 * grouped by file, bash output classified by outcome.
 *
 * Pure and display only. Nothing here emits ANSI; the renderer maps the kinds to
 * theme colours, so a fixture can check the shape without a terminal.
 */

/** How a bash line reads: a failure, a pass, a warning, or ordinary text. */
export type LineKind = "plain" | "fail" | "pass" | "warn";

/** One entry of a path tree. */
interface TreeNode {
	dirs: Map<string, TreeNode>;
	files: string[];
}

/** A fresh, empty node. */
function node(): TreeNode {
	return { dirs: new Map(), files: [] };
}

/** The tree of a node, as lines, with the drawing marks. */
function drawTree(current: TreeNode, prefix: string, lines: string[]): void {
	const dirs = [...current.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
	const files = [...current.files].sort((a, b) => a.localeCompare(b));
	const entries: Array<{ name: string; child?: TreeNode }> = [
		...dirs.map(([name, child]) => ({ name, child })),
		...files.map((name) => ({ name })),
	];
	for (const [index, entry] of entries.entries()) {
		const last = index === entries.length - 1;
		const mark = last ? "└── " : "├── ";
		if (entry.child) {
			lines.push(`${prefix}${mark}${entry.name}/`);
			drawTree(entry.child, `${prefix}${last ? "    " : "│   "}`, lines);
			continue;
		}
		lines.push(`${prefix}${mark}${entry.name}`);
	}
}

/**
 * A list of paths as a tree.
 *
 * One path prints as itself; a single shared root is drawn once with its
 * branches under it, so `find` output does not repeat the same prefix per line.
 */
export function treeLines(paths: string[]): string[] {
	// A trailing slash says the path is a directory, which the drawing keeps.
	const entries = paths
		.map((path) => ({ path: path.replace(/^\.\//, ""), dir: path.endsWith("/") }))
		.filter((entry) => entry.path.replace(/\/+$/, "") !== "");
	if (entries.length === 0) return [];
	const root = node();
	for (const entry of entries) {
		const parts = entry.path.split("/").filter((part) => part !== "");
		let cursor = root;
		for (const part of parts.slice(0, -1)) {
			const next = cursor.dirs.get(part) ?? node();
			cursor.dirs.set(part, next);
			cursor = next;
		}
		const last = parts[parts.length - 1] ?? "";
		if (last === "") continue;
		if (entry.dir) cursor.dirs.set(last, cursor.dirs.get(last) ?? node());
		else cursor.files.push(last);
	}
	const lines: string[] = [];
	drawTree(root, "", lines);
	return lines;
}

/** One file's matches, in the order the grep printed them. */
export interface GrepGroup {
	file: string;
	matches: string[];
}

/**
 * `grep` output grouped by file.
 *
 * Accepts `file:line:text` (the usual shape) and a line with no location, which
 * is kept as its own group so nothing is dropped.
 */
export function groupGrep(output: string): GrepGroup[] {
	const groups: GrepGroup[] = [];
	const byFile = new Map<string, GrepGroup>();
	for (const raw of output.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") continue;
		const match = /^(.+?):(\d+):(.*)$/.exec(line);
		const file = match?.[1] ?? line;
		const text = match ? `${match[2]}:${match[3]}` : "";
		let group = byFile.get(file);
		if (!group) {
			group = { file, matches: [] };
			byFile.set(file, group);
			groups.push(group);
		}
		if (text !== "") group.matches.push(text);
	}
	return groups;
}

/** True for a line that reports a failure. */
function isFailure(line: string): boolean {
	return /(^|[\s[])(FAIL|FAILED|panic|error|ERROR|✖|fatal)/.test(line);
}

/** True for a line that reports a pass. */
function isPass(line: string): boolean {
	return /(^|[\s[])(ok|PASS|passed|✓|✔)/.test(line);
}

/** True for a line that reports a warning. */
function isWarn(line: string): boolean {
	return /(^|[\s[])(warning|WARN|⚠)/.test(line);
}

/**
 * Bash output classified by outcome, one entry per line.
 *
 * A failure wins over a pass and a pass over a warning, so `ok 12 passed` and
 * `FAIL 2 failed` on one line both land on the failure side.
 */
export function bashLines(output: string): Array<{ text: string; kind: LineKind }> {
	return output
		.replace(/\n$/, "")
		.split("\n")
		.map((text) => {
			if (isFailure(text)) return { text, kind: "fail" as const };
			if (isPass(text)) return { text, kind: "pass" as const };
			if (isWarn(text)) return { text, kind: "warn" as const };
			return { text, kind: "plain" as const };
		});
}
