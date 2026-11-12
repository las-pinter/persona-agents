/**
 * Nested-construct grammar for the shell lexer.
 *
 * One skip loop reads a `(...)` group, a `$(...)` substitution, an arithmetic
 * `$((...))` body, and a backtick pair. The loop skips an escaped pair and a
 * quoted span, so a `)` inside a string never ends the read.
 *
 * `extractSubstitutions` walks one line once and reports each inner command it
 * finds. This module imports nothing, so it runs under plain Node.
 */

/** An inner command found by `extractSubstitutions`, with its start offset. */
export interface Substitution {
	text: string;
	/** Offset of `text` inside the input to `extractSubstitutions`. */
	offset: number;
}

/** Index after the closing single quote (or end of text). */
export function skipSingle(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		if (text[i] === "'") return i + 1;
		i++;
	}
	return text.length;
}

/** Index after the closing double quote (or end of text); honours escapes. */
function skipDouble(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === '"') return i + 1;
		i++;
	}
	return text.length;
}

/**
 * Read one balanced construct. `start` points at the first opener character,
 * and every pair is one character wide. `quotes` is false for a backtick pair,
 * because that reader skips an escaped pair only.
 *
 * Returns the inner text and the index after the closer. Unterminated input
 * reads to the end of the text.
 */
function readNested(
	text: string,
	start: number,
	opener: string,
	closer: string,
	quotes = true,
): [string, number] {
	const innerStart = start + opener.length;
	let depth = 1;
	let i = innerStart;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (quotes && c === "'") {
			i = skipSingle(text, i);
			continue;
		}
		if (quotes && c === '"') {
			i = skipDouble(text, i);
			continue;
		}
		if (opener !== closer && c === opener) {
			depth++;
			i++;
			continue;
		}
		if (c === closer) {
			depth--;
			if (depth === 0) return [text.slice(innerStart, i), i + 1];
			i++;
			continue;
		}
		i++;
	}
	return [text.slice(innerStart), text.length];
}

/**
 * Read a `(...)` group whose `(` is at `openIdx`. A `$(...)` substitution, a
 * `<(...)`/`>(...)` process substitution, and a `$((...))` arithmetic body all
 * pass the same index: the word before it holds the shape.
 */
function readParens(text: string, openIdx: number): [string, number] {
	return readNested(text, openIdx, "(", ")");
}

/** Read a backtick substitution whose opening tick is at `tickIdx`. */
function readBackticks(text: string, tickIdx: number): [string, number] {
	return readNested(text, tickIdx, "`", "`", false);
}

/** One executed construct read at one offset, with the index after it. */
interface Executed {
	subs: Substitution[];
	end: number;
}

/**
 * Read the construct that starts at `i`, or null when none starts there.
 * `processSub` is false inside a double-quoted span, where `<(id)` is literal.
 *
 * An arithmetic body is recursed into without single-quote skipping: bash still
 * runs a command inside a quoted arithmetic body.
 */
function readExecuted(text: string, i: number, processSub: boolean): Executed | null {
	const c = text[i];
	if (c === "$" && text[i + 1] === "(") {
		if (text[i + 2] === "(") {
			const [body, end] = readParens(text, i + 1);
			const subs = extractSubstitutions(body, false).map(
				(sub): Substitution => ({ text: sub.text, offset: i + 2 + sub.offset }),
			);
			return { subs, end };
		}
		const [inner, end] = readParens(text, i + 1);
		return { subs: [{ text: inner, offset: i + 2 }], end };
	}
	if (c === "`") {
		const [inner, end] = readBackticks(text, i);
		return { subs: [{ text: inner, offset: i + 1 }], end };
	}
	if (processSub && (c === "<" || c === ">") && text[i + 1] === "(") {
		const [inner, end] = readParens(text, i + 1);
		return { subs: [{ text: inner, offset: i + 2 }], end };
	}
	return null;
}

/**
 * Walk one double-quoted span and collect the constructs inside it.
 * Returns the index after the closing quote.
 */
function readQuotedSpan(text: string, start: number, out: Substitution[]): number {
	let i = start + 1;
	while (i < text.length && text[i] !== '"') {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		const found = readExecuted(text, i, false);
		if (found) {
			out.push(...found.subs);
			i = found.end;
			continue;
		}
		i++;
	}
	return i + 1;
}

/**
 * Collect the inner commands of `$(...)`, backticks, and `<(...)`/`>(...)`.
 * A construct inside a double-quoted span counts too. An arithmetic body is
 * recursed into, because bash runs command substitution inside arithmetic.
 * `${...}` and `$VAR` are expansions, not executions, so they stay in place.
 *
 * `skipSingleQuotes` guards normal extraction only. In an arithmetic body, bash
 * treats quotes as part of the expansion context, so `'$(id)'` still runs `id`
 * there; the arithmetic recursion passes `false`.
 */
export function extractSubstitutions(text: string, skipSingleQuotes = true): Substitution[] {
	const out: Substitution[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'" && skipSingleQuotes) {
			i = skipSingle(text, i);
			continue;
		}
		if (c === '"') {
			i = readQuotedSpan(text, i, out);
			continue;
		}
		const found = readExecuted(text, i, true);
		if (found) {
			out.push(...found.subs);
			i = found.end;
			continue;
		}
		i++;
	}
	return out;
}
