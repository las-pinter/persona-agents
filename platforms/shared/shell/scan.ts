/**
 * Character scanners over one shell command: output redirects, command
 * substitutions, and runtime-shaped words. The gates read their answers; a
 * platform write policy reads the redirect targets.
 */

import { normalizeHeredocs } from "./heredoc.ts";

/**
 * True when bash changes the segment at run time in a way the words do not
 * show: a `$` expansion or substitution outside single quotes, an unquoted
 * glob or brace, or an output redirect to a file (`2>&1` and `>/dev/null`
 * stay plain). A history command with this shape is raised to ask.
 */
export function runtimeShaped(segment: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "`" || (ch === "$" && /[A-Za-z_{(0-9*@#?$!-]/.test(segment[i + 1] ?? ""))) return true;
		if (quote === '"') {
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if ("*?[{".includes(ch)) return true;
	}
	return writesFile(segment);
}

/** True when the segment redirects output to a file (`2>&1` and `>/dev/null` stay plain). */
export function writesFile(segment: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "<" && segment[i + 1] === ">") return true;
		else if (ch === ">") {
			let j = i + 1;
			if (segment[j] === ">" || segment[j] === "|") j++;
			while (segment[j] === " " || segment[j] === "\t") j++;
			if (segment[j] === "&") {
				// A dup is plain only when the whole target is an fd or `-`: `>&0file` writes a file.
				if (!/^(\d+|-)(?=\s|$)/.test(segment.slice(j + 1))) return true;
			} else if (!/^\/dev\/null(?=\s|$)/.test(segment.slice(j))) return true;
		}
	}
	return false;
}

/**
 * The file targets of the output redirects in a command, in order, with their
 * quotes removed. `2>&1`, `>&2`, and `>/dev/null` are not targets: they change
 * no file. A target is returned as written, so the caller resolves it against
 * its own working directory.
 *
 * This exists so a platform can apply its write policy to `echo x > path`
 * exactly as it does to the `write` tool: a redirect to a file is a write, and
 * the path belongs to the policy, not only to the shell.
 */
export function redirectTargets(command: string): string[] {
	return redirectTargetsIn(normalizeHeredocs(command));
}

/** The redirect scan over text whose quoted commit heredocs are already removed. */
function redirectTargetsIn(command: string): string[] {
	const targets: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;
		let j = i + 1;
		if (command[j] === ">") j++;
		if (command[j] === "|") j++;
		while (command[j] === " " || command[j] === "\t") j++;
		if (command[j] === "&") {
			// `>&2` and `>&-` are dups; `>&0file` writes `file`.
			j++;
			while (/\d|-/.test(command[j] ?? "")) j++;
			if (command[j] === undefined || /\s|;|&|\|/.test(command[j])) continue;
		}
		// Read the target word, keeping the quotes out of it.
		let target = "";
		let inner: "'" | '"' | null = null;
		while (j < command.length) {
			const c = command[j];
			if (inner) {
				if (c === inner) inner = null;
				else if (c === "\\" && inner === '"' && j + 1 < command.length) target += command[++j];
				else target += c;
				j++;
				continue;
			}
			if (c === "'" || c === '"') {
				inner = c;
				j++;
				continue;
			}
			if (c === "\\" && j + 1 < command.length) {
				target += command[++j];
				j++;
				continue;
			}
			if (/\s|;|&|\|/.test(c)) break;
			target += c;
			j++;
		}
		if (target !== "" && target !== "/dev/null") targets.push(target);
	}
	return targets;
}

/** True when the command runs a `$(...)`, backtick, or `<(...)` substitution. */
export function hasSubstitution(command: string): boolean {
	let single = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (single) {
			if (ch === "'") single = false;
		} else if (ch === "\\") i++;
		else if (ch === "'") single = true;
		else if (ch === "`" || ("$<>".includes(ch) && command[i + 1] === "(")) return true;
	}
	return false;
}
