/**
 * Heredoc handling for the shell gate.
 *
 * Two jobs:
 *
 *   normalizeHeredocs  remove a quoted heredoc or a single-quoted here-string
 *                      that only feeds a `git commit ... -F -` header, so the
 *                      parser sees the commit and the body stays data.
 *   safeHeredocHeader  the header of one whole-command data heredoc (cat, tee,
 *                      python3/py, node reading stdin), for the fail-closed
 *                      path.
 *
 * Everything else stays: an unquoted or expanding form, a header that is not a
 * plain `git commit -F -`, a comment, or a token the scanner cannot read. The
 * caller then falls back to the fail-closed scan.
 */

import { parseShellCommand } from "./shell-parse.ts";
import { shellWords } from "./shell-words.ts";

/** A plain file path in a heredoc header: no quotes, expansions, or operators. */
const PLAIN_PATH = String.raw`[A-Za-z0-9._/~-]+`;
const HEREDOC_REDIRECT = String.raw`>>?[ \t]*${PLAIN_PATH}`;
const HEREDOC_TOKEN = String.raw`<<[ \t]*(?:'(\w+)'|"(\w+)")`;
/**
 * The only heredoc header whose body may skip the fail-closed scan: a data
 * reader (cat, tee with one file, python3/python/node with `-`), one optional
 * output redirect to a plain path, and one heredoc with a quoted delimiter.
 */
const SAFE_HEREDOC_HEADER = new RegExp(
	String.raw`^(?:cat|tee(?:[ \t]+${PLAIN_PATH})?|(?:python3|python|node)(?:[ \t]+-)?)` +
		String.raw`(?:(?:[ \t]+${HEREDOC_REDIRECT})?[ \t]+${HEREDOC_TOKEN}|[ \t]+${HEREDOC_TOKEN}(?:[ \t]+${HEREDOC_REDIRECT})?)[ \t]*$`,
);

/**
 * A heredoc or here-string token outside quotes: where it starts and ends, the
 * delimiter, and whether `<<-` strips tabs. `delimiter` is "" when the gate
 * cannot read the word (an unquoted or expanding form), and the caller stops.
 */
interface HeredocToken {
	start: number;
	end: number;
	kind: "heredoc" | "herestring";
	delimiter: string;
	stripTabs: boolean;
}

/** The quoted word at `start` (`'EOF'` or `"EOF"`), or null. */
function quotedWord(text: string, start: number): { word: string; end: number } | null {
	const quote = text[start];
	if (quote !== "'" && quote !== '"') return null;
	const close = text.indexOf(quote, start + 1);
	if (close < 0) return null;
	return { word: text.slice(start + 1, close), end: close + 1 };
}

/** The first heredoc or here-string token outside quotes and comments, or null. */
function heredocToken(command: string): HeredocToken | null {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") i++;
			else if (ch === '"') quote = null;
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
		// A `#` at the start of a word begins a comment: the rest of the line is
		// not shell text, so a token in it must not be read.
		if (ch === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
			const newline = command.indexOf("\n", i);
			if (newline < 0) break;
			i = newline;
			continue;
		}
		if (ch !== "<" || command[i + 1] !== "<") continue;
		if (command[i + 2] === "<") {
			// Here-string: only a single-quoted literal is data. A double-quoted
			// or bare word expands, so it is not read.
			let j = i + 3;
			while (command[j] === " " || command[j] === "\t") j++;
			const word = command[j] === "'" ? quotedWord(command, j) : null;
			if (!word) return { start: i, end: j, kind: "herestring", delimiter: "", stripTabs: false };
			return { start: i, end: word.end, kind: "herestring", delimiter: word.word, stripTabs: false };
		}
		let j = i + 2;
		let stripTabs = false;
		if (command[j] === "-") {
			stripTabs = true;
			j++;
		}
		while (command[j] === " " || command[j] === "\t") j++;
		const word = quotedWord(command, j);
		if (!word) return { start: i, end: j, kind: "heredoc", delimiter: "", stripTabs };
		return { start: i, end: word.end, kind: "heredoc", delimiter: word.word, stripTabs };
	}
	return null;
}

/** True when a segment is a plain `git commit` that reads its message from stdin. */
function isCommitStdinHeader(segment: string): boolean {
	let words = shellWords(segment);
	while (words[0] === "cd" && words[2] === "&&") words = words.slice(3);
	if (words[0] !== "git" || words[1] !== "commit") return false;
	const args = words.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "-F" || arg === "--file") && args[i + 1] === "-") return true;
		if (arg === "-F-" || arg === "--file=-") return true;
	}
	return false;
}

/**
 * Remove one heredoc or here-string when it only feeds a `git commit -F -`
 * header. The body and the close line are data, so they are removed before the
 * parser sees them; text after the header token (a pipe or a `&&`) and after
 * the close line stays. Null when the token is not one the gate reads.
 */
function stripOneHeredoc(command: string): string | null {
	const token = heredocToken(command);
	if (token === null || token.delimiter === "") return null;
	const lineStart = command.lastIndexOf("\n", token.start - 1) + 1;
	const prefix = command.slice(lineStart, token.start);
	const parsed = parseShellCommand(prefix);
	const header = parsed.unsupported ? "" : (parsed.segments[parsed.segments.length - 1] ?? "");
	if (!isCommitStdinHeader(header)) return null;
	const lineEnd = command.indexOf("\n", token.end);
	if (token.kind === "herestring") {
		// A single-line command has no body; its tail after the token is shell
		// text (`&& git push`) and must stay.
		const tail = lineEnd < 0 ? command.slice(token.end) : command.slice(token.end, lineEnd);
		const rest = lineEnd < 0 ? "" : command.slice(lineEnd + 1);
		return command.slice(0, token.start) + tail + (rest === "" ? "" : `\n${rest}`);
	}
	if (lineEnd < 0) return null;
	const headerRest = command.slice(token.end, lineEnd);
	// The close line must hold the delimiter alone (leading tabs for `<<-`).
	let pos = lineEnd + 1;
	while (pos <= command.length) {
		const next = command.indexOf("\n", pos);
		const end = next < 0 ? command.length : next;
		const line = command.slice(pos, end);
		const candidate = token.stripTabs ? line.replace(/^\t+/, "") : line;
		if (candidate === token.delimiter) {
			const rest = next < 0 ? "" : command.slice(next + 1);
			return command.slice(0, token.start) + headerRest + (rest === "" ? "" : `\n${rest}`);
		}
		if (next < 0) break;
		pos = next + 1;
	}
	return null;
}

/**
 * The command with every quoted heredoc or single-quoted here-string that only
 * feeds a `git commit -F -` header removed. Anything else stays, so the parser
 * fails closed on it. At most four tokens are removed; the rest stay.
 */
export function normalizeHeredocs(command: string): string {
	let text = command;
	for (let i = 0; i < 4; i++) {
		const next = stripOneHeredoc(text);
		if (next === null) return text;
		text = next;
	}
	return text;
}

/**
 * The header without its heredoc token when the whole command is one safe
 * data heredoc, else null. The check is a strict allow-list because any shape
 * it does not know (a shell reading the body, a pipe, a later line that runs
 * the written file) must fall back to the fail-closed scan.
 * Shape: header line (SAFE_HEREDOC_HEADER), body, a closing line equal to the
 * delimiter, then only blank lines.
 * Known limit: python or node code in a body (a subprocess or child_process
 * call to git) is not inspected; `python -c '...'` has the same limit.
 */
export function safeHeredocHeader(command: string): string | null {
	const lines = command.split("\n");
	const match = SAFE_HEREDOC_HEADER.exec(lines[0]);
	if (!match) return null;
	const delimiter = match.slice(1).find((group) => group !== undefined);
	if (!delimiter) return null;
	const close = lines.indexOf(delimiter, 1);
	if (close < 0) return null;
	if (!lines.slice(close + 1).every((line) => /^[ \t]*$/.test(line))) return null;
	return lines[0].replace(new RegExp(HEREDOC_TOKEN), " ");
}
