/**
 * Shell-command lexer: splits one command line into per-segment strings.
 *
 * This module imports only the nested-construct grammar, so it runs under plain
 * Node and is testable with `node:test`. Compound commands (`echo hi && id`,
 * `a; b`, `a | b`) are split on unquoted control operators. Fail-closed
 * constructs (heredoc, ANSI-C quoting, unbalanced quotes, dangling operators,
 * recursion limit) block the whole command. `command-segments.ts` keeps the
 * permission decision core.
 */

import { extractSubstitutions } from "./shell-grammar.ts";

export interface ShellParse {
	segments: string[];
	/** Segments before the leading-`cd` fold. Deny/ask probes test both lists. */
	rawSegments: string[];
	/** Original start offset of each entry in `segments`, or -1 when unknown. */
	segmentStarts: number[];
	unsupported: string | null;
}

/** Recursion depth cap for nested command substitution. */
const MAX_DEPTH = 8;

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\r";
}

/**
 * Fold a leading `cd <one-token>` guard into the next segment, so the git allow
 * regexes (which already encode the optional `cd X &&` prefix) keep working.
 */
function foldLeadingCdGuards(
	segments: string[],
	starts: number[],
): { segments: string[]; starts: number[] } {
	const out: string[] = [];
	const outStarts: number[] = [];
	let pending: string | null = null;
	let pendingStart = -1;
	for (let k = 0; k < segments.length; k++) {
		const seg = segments[k];
		if (/^cd\s+\S+$/.test(seg)) {
			pending = pending ? `${pending} && ${seg}` : seg;
			if (pendingStart < 0) pendingStart = starts[k];
			continue;
		}
		if (pending) {
			out.push(`${pending} && ${seg}`);
			outStarts.push(pendingStart);
			pending = null;
			pendingStart = -1;
		} else {
			out.push(seg);
			outStarts.push(starts[k]);
		}
	}
	if (pending) {
		out.push(pending);
		outStarts.push(pendingStart);
	}
	return { segments: out, starts: outStarts };
}

/**
 * Parse a shell command into per-segment strings. Never throws.
 *
 * `unsupported` is non-null for fail-closed constructs: `heredoc`, `ansi-c`,
 * `unbalanced-quote`, `dangling-operator`, `recursion-limit`.
 */
export function parseShellCommand(command: string, depth = 0): ShellParse {
	if (depth > MAX_DEPTH) {
		return { segments: [command], rawSegments: [command], segmentStarts: [0], unsupported: "recursion-limit" };
	}

	const segments: string[] = [];
	const starts: number[] = [];
	let buf = "";
	let segStart = -1;
	let quote: "none" | "single" | "double" = "none";
	let escaped = false;
	let unsupported: string | null = null;
	let malformed = false;
	let expectOperand = false;
	let i = 0;
	const n = command.length;

	// Record the original index of the first significant char of a segment.
	const note = (origIndex: number, ch: string): void => {
		if (segStart < 0 && !isSpace(ch)) segStart = origIndex;
	};

	const pushBuf = (): void => {
		const s = buf.trim();
		if (s !== "") {
			segments.push(s);
			starts.push(segStart);
		}
		buf = "";
		segStart = -1;
	};

	while (i < n) {
		const c = command[i];

		if (escaped) {
			if (c === "\n") {
				buf += " ";
			} else {
				note(i - 1, "\\");
				buf += "\\" + c;
			}
			escaped = false;
			expectOperand = false;
			i++;
			continue;
		}

		if (c === "\\" && quote !== "single") {
			escaped = true;
			i++;
			continue;
		}

		if (quote === "single") {
			note(i, c);
			buf += c;
			if (c === "'") quote = "none";
			expectOperand = false;
			i++;
			continue;
		}

		if (quote === "double") {
			note(i, c);
			buf += c;
			if (c === '"') quote = "none";
			expectOperand = false;
			i++;
			continue;
		}

		// Not inside a quote.
		if (c === "$" && command[i + 1] === "'") {
			unsupported = "ansi-c";
			note(i, c);
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === "$") {
			note(i, c);
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === "'") {
			quote = "single";
			note(i, c);
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === '"') {
			quote = "double";
			note(i, c);
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}

		if (c === "<" && command[i + 1] === "<") {
			unsupported = "heredoc";
			note(i, c);
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}

		if (c === ";") {
			if (command[i + 1] === ";") {
				// `;;` is a `case` terminator, not a general separator. Fail closed.
				malformed = true;
				i += 2;
				continue;
			}
			pushBuf();
			expectOperand = false;
			i++;
			continue;
		}

		if (c === "\n") {
			pushBuf();
			expectOperand = false;
			i++;
			continue;
		}

		if (c === "|") {
			if (buf.trim() === "" || expectOperand) malformed = true;
			pushBuf();
			expectOperand = true;
			if (command[i + 1] === "|" || command[i + 1] === "&") i += 2;
			else i++;
			continue;
		}

		if (c === "&") {
			if (command[i + 1] === "&") {
				if (buf.trim() === "" || expectOperand) malformed = true;
				pushBuf();
				expectOperand = true;
				i += 2;
				continue;
			}
			// fd redirects: `2>&1`, `>&2`, `&>file` are not separators.
			if (command[i + 1] === ">" || buf.replace(/\s+$/, "").endsWith(">")) {
				note(i, c);
				buf += c;
				expectOperand = false;
				i++;
				continue;
			}
			if (buf.trim() === "") malformed = true;
			pushBuf();
			expectOperand = false;
			i++;
			continue;
		}

		note(i, c);
		buf += c;
		if (!isSpace(c)) expectOperand = false;
		i++;
	}

	if (buf.trim() !== "") pushBuf();
	if (expectOperand) malformed = true;

	if (quote !== "none" && unsupported === null) unsupported = "unbalanced-quote";
	if (malformed) {
		return { segments: [command], rawSegments: [command], segmentStarts: [0], unsupported: "dangling-operator" };
	}

	let result = segments;
	let resultStarts = starts;

	// Recurse into executed sub-commands (`$(...)`, backticks, process subs).
	const subs: { text: string; baseOffset: number }[] = [];
	for (let k = 0; k < result.length; k++) {
		for (const sub of extractSubstitutions(result[k])) {
			subs.push({ text: sub.text, baseOffset: starts[k] + sub.offset });
		}
	}
	if (subs.length > 0) {
		const extra: string[] = [];
		const extraStarts: number[] = [];
		for (const sub of subs) {
			const parsed = parseShellCommand(sub.text, depth + 1);
			for (let j = 0; j < parsed.segments.length; j++) {
				extra.push(parsed.segments[j]);
				extraStarts.push(sub.baseOffset + parsed.segmentStarts[j]);
			}
			if (parsed.unsupported) unsupported = parsed.unsupported;
		}
		result = [...result, ...extra];
		resultStarts = [...resultStarts, ...extraStarts];
	}

	const folded = foldLeadingCdGuards(result, resultStarts);
	return { segments: folded.segments, rawSegments: result, segmentStarts: folded.starts, unsupported };
}

// The expansion probe in `command-segments.ts` walks quoted spans.
export { skipSingle } from "./shell-grammar.ts";
