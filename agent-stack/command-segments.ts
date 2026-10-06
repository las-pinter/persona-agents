/**
 * Pure shell-command splitting + permission decision core for the pi gate.
 *
 * This module has NO pi imports, so it runs under plain Node and is testable
 * with `node:test`. `permissions.ts` keeps the pi wiring (session keys, prompt,
 * events) and calls `evaluateCommandRules` once per segment-approval round.
 *
 * Compound commands (`echo hi && id`, `a; b`, `a | b`) are split on unquoted
 * control operators. Every segment must be permitted. Fail-closed constructs
 * (heredoc, ANSI-C quoting, unbalanced quotes, dangling operators, recursion
 * limit) block the whole command.
 */

export interface RawRule {
	tool?: string;
	match: string;
	reason?: string;
}

export interface CompiledRule {
	tool: string;
	re: RegExp;
	rule: RawRule;
}

export type Decision =
	| { kind: "deny"; reason: string }
	| {
			kind: "ask";
			rule: RawRule;
			/** The segment that matched the ask rule. */
			segment: string;
			/** Index of `segment` in the parsed segment list (stable per call). */
			segmentIndex: number;
			/** Which rule set produced the ask. */
			source: "global" | "agent";
	  }
	| { kind: "allow" }
	| { kind: "default"; reason: string };

export interface ShellParse {
	segments: string[];
	/** Segments before the leading-`cd` fold. Deny/ask probes test both lists. */
	rawSegments: string[];
	unsupported: string | null;
}

export interface RuleSets {
	globalDeny: RawRule[];
	agentDeny: RawRule[];
	globalAsk: RawRule[];
	agentAsk: RawRule[];
	agentAllow: RawRule[];
}

export type PermissionMode = "deny-by-default" | "allow-unless-matched";

export interface EvaluateOptions {
	/**
	 * Segment indices the user approved with "Allow once (this segment only)".
	 * Session-allowed segments are folded in here too. Approved segments skip the
	 * ask and allow checks, but never the deny checks.
	 */
	approvedSegmentIndices?: ReadonlySet<number>;
	/**
	 * Session "Always allow (session)" predicate. `permissions.ts` owns the
	 * `agent|tool|rule.match` key format; the module only asks.
	 */
	isSessionAllowed?: (rule: RawRule) => boolean;
}

/**
 * Compiled-regex cache for the gate hot path. Semantics are identical to the
 * old gate: unanchored, case-insensitive, non-global (`lastIndex` never moves).
 */
const regexCache = new Map<string, RegExp>();

export function compileRegex(pattern: string): RegExp {
	let re = regexCache.get(pattern);
	if (!re) {
		re = new RegExp(pattern, "i");
		regexCache.set(pattern, re);
	}
	return re;
}

export function compile(rules: RawRule[] | undefined): CompiledRule[] {
	return (rules ?? [])
		.filter((r) => r && typeof r.match === "string" && r.match)
		.map((rule) => ({ tool: rule.tool ?? "*", re: compileRegex(rule.match), rule }));
}

/** Recursion depth cap for nested command substitution. */
const MAX_DEPTH = 8;

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\r";
}

/** Index after the closing single quote (or end of text). */
function skipSingle(text: string, start: number): number {
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
 * Read a balanced `(...)` starting at `openIdx` (which points at `(`).
 * Skips quoted spans and escaped characters. Returns the inner text and the
 * index after the closing paren. Unterminated input reads to the end.
 */
function readBalancedParens(text: string, openIdx: number): [string, number] {
	const start = openIdx + 1;
	let depth = 0;
	let i = openIdx;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			i = skipSingle(text, i);
			continue;
		}
		if (c === '"') {
			i = skipDouble(text, i);
			continue;
		}
		if (c === "(") {
			depth++;
			i++;
			continue;
		}
		if (c === ")") {
			depth--;
			if (depth === 0) return [text.slice(start, i), i + 1];
			i++;
			continue;
		}
		i++;
	}
	return [text.slice(start), text.length];
}

/** Read a backtick substitution. Returns inner text and index after the close. */
function readBackticks(text: string, tickIdx: number): [string, number] {
	const start = tickIdx + 1;
	let i = start;
	while (i < text.length) {
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === "`") return [text.slice(start, i), i + 1];
		i++;
	}
	return [text.slice(start), text.length];
}

/**
 * Read a balanced `$(( ... ))` arithmetic block starting at `$`. Returns the
 * inner arithmetic text and the index after the closing `)`. Skips quoted spans
 * and escaped characters, so a `)` inside a string does not end the block.
 */
function readArithmetic(text: string, dollarIdx: number): [string, number] {
	let depth = 0;
	let i = dollarIdx + 1;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			i = skipSingle(text, i);
			continue;
		}
		if (c === '"') {
			i = skipDouble(text, i);
			continue;
		}
		if (c === "(") {
			depth++;
			i++;
			continue;
		}
		if (c === ")") {
			depth--;
			if (depth === 0) return [text.slice(dollarIdx + 2, i), i + 1];
			i++;
			continue;
		}
		i++;
	}
	return [text.slice(dollarIdx + 2), text.length];
}

/**
 * Collect the inner commands of `$(...)`, backticks, and `<(...)`/`>(...)`.
 * `$((...))` arithmetic bodies are recursed into: bash runs command
 * substitution inside arithmetic. `${...}` and `$VAR` are expansions, not
 * executions, so they stay in place.
 *
 * `skipSingleQuotes` guards normal extraction only. In an arithmetic body, bash
 * treats quotes as part of the expansion context, so `'$(id)'` still runs `id`
 * there; the arithmetic recursion passes `false`.
 */
function extractSubstitutions(text: string, skipSingleQuotes = true): string[] {
	const out: string[] = [];
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
			i++;
			while (i < text.length && text[i] !== '"') {
				const d = text[i];
				if (d === "\\") {
					i += 2;
					continue;
				}
				if (d === "$" && text[i + 1] === "(") {
					if (text[i + 2] === "(") {
						const [arith, j] = readArithmetic(text, i);
						out.push(...extractSubstitutions(arith, false));
						i = j;
						continue;
					}
					const [inner, j] = readBalancedParens(text, i + 1);
					out.push(inner);
					i = j;
					continue;
				}
				if (d === "`") {
					const [inner, j] = readBackticks(text, i);
					out.push(inner);
					i = j;
					continue;
				}
				i++;
			}
			i++;
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			if (text[i + 2] === "(") {
				const [arith, j] = readArithmetic(text, i);
				out.push(...extractSubstitutions(arith, false));
				i = j;
				continue;
			}
			const [inner, j] = readBalancedParens(text, i + 1);
			out.push(inner);
			i = j;
			continue;
		}
		if (c === "`") {
			const [inner, j] = readBackticks(text, i);
			out.push(inner);
			i = j;
			continue;
		}
		if ((c === "<" || c === ">") && text[i + 1] === "(") {
			const [inner, j] = readBalancedParens(text, i + 1);
			out.push(inner);
			i = j;
			continue;
		}
		i++;
	}
	return out;
}

/**
 * Fold a leading `cd <one-token>` guard into the next segment, so the git allow
 * regexes (which already encode the optional `cd X &&` prefix) keep working.
 */
function foldLeadingCdGuards(segments: string[]): string[] {
	const out: string[] = [];
	let pending: string | null = null;
	for (const seg of segments) {
		if (/^cd\s+\S+$/.test(seg)) {
			pending = pending ? `${pending} && ${seg}` : seg;
			continue;
		}
		if (pending) {
			out.push(`${pending} && ${seg}`);
			pending = null;
		} else {
			out.push(seg);
		}
	}
	if (pending) out.push(pending);
	return out;
}

/**
 * Parse a shell command into per-segment strings. Never throws.
 *
 * `unsupported` is non-null for fail-closed constructs: `heredoc`, `ansi-c`,
 * `unbalanced-quote`, `dangling-operator`, `recursion-limit`.
 */
export function parseShellCommand(command: string, depth = 0): ShellParse {
	if (depth > MAX_DEPTH) {
		return { segments: [command], rawSegments: [command], unsupported: "recursion-limit" };
	}

	const segments: string[] = [];
	let buf = "";
	let quote: "none" | "single" | "double" = "none";
	let escaped = false;
	let unsupported: string | null = null;
	let malformed = false;
	let expectOperand = false;
	let i = 0;
	const n = command.length;

	const pushBuf = (): void => {
		const s = buf.trim();
		if (s !== "") segments.push(s);
		buf = "";
	};

	while (i < n) {
		const c = command[i];

		if (escaped) {
			if (c === "\n") buf += " ";
			else buf += "\\" + c;
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
			buf += c;
			if (c === "'") quote = "none";
			expectOperand = false;
			i++;
			continue;
		}

		if (quote === "double") {
			buf += c;
			if (c === '"') quote = "none";
			expectOperand = false;
			i++;
			continue;
		}

		// Not inside a quote.
		if (c === "$" && command[i + 1] === "'") {
			unsupported = "ansi-c";
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === "$") {
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === "'") {
			quote = "single";
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}
		if (c === '"') {
			quote = "double";
			buf += c;
			expectOperand = false;
			i++;
			continue;
		}

		if (c === "<" && command[i + 1] === "<") {
			unsupported = "heredoc";
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

		buf += c;
		if (!isSpace(c)) expectOperand = false;
		i++;
	}

	if (buf.trim() !== "") pushBuf();
	if (expectOperand) malformed = true;

	if (quote !== "none" && unsupported === null) unsupported = "unbalanced-quote";
	if (malformed) return { segments: [command], rawSegments: [command], unsupported: "dangling-operator" };

	let result = segments;

	// Recurse into executed sub-commands (`$(...)`, backticks, process subs).
	const subs: string[] = [];
	for (const s of result) subs.push(...extractSubstitutions(s));
	if (subs.length > 0) {
		const extra: string[] = [];
		for (const sub of subs) {
			const parsed = parseShellCommand(sub, depth + 1);
			extra.push(...parsed.segments);
			if (parsed.unsupported) unsupported = parsed.unsupported;
		}
		result = [...result, ...extra];
	}

	return { segments: foldLeadingCdGuards(result), rawSegments: result, unsupported };
}

/** Thin test wrapper: the segments of a command, ignoring fail-closed markers. */
export function splitShellSegments(command: string): string[] {
	return parseShellCommand(command).segments;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

interface RuleMatch {
	rule: RawRule;
	probe: string;
}

/** First rule (list order) × first probe (order) that matches. */
function firstMatch(rules: CompiledRule[], toolName: string, probes: string[]): RuleMatch | null {
	for (const r of rules) {
		if (r.tool !== "*" && r.tool !== toolName) continue;
		for (const probe of probes) {
			if (r.re.test(probe)) return { rule: r.rule, probe };
		}
	}
	return null;
}

/**
 * Whole-command ask probe. Returns the first rule that matches a whole-command
 * probe but no single segment, so genuinely separator-spanning rules are caught
 * without shadowing the per-segment asks.
 */
function firstSpanningMatch(
	rules: CompiledRule[],
	toolName: string,
	probes: string[],
	segments: string[],
): RuleMatch | null {
	for (const r of rules) {
		if (r.tool !== "*" && r.tool !== toolName) continue;
		if (segments.some((s) => r.re.test(s))) continue;
		for (const probe of probes) {
			if (r.re.test(probe)) return { rule: r.rule, probe };
		}
	}
	return null;
}

type AskDecision = Extract<Decision, { kind: "ask" }>;

/**
 * Find the first unapproved segment that matches an ask rule. Session-allowed
 * segments are already folded into `approved` by the caller, so a match here is
 * always a real prompt. Returns the ask decision or `null`.
 */
function findAsk(
	rules: CompiledRule[],
	toolName: string,
	segments: string[],
	approved: ReadonlySet<number>,
	source: "global" | "agent",
): AskDecision | null {
	for (let idx = 0; idx < segments.length; idx++) {
		if (approved.has(idx)) continue;
		const segment = segments[idx];
		for (const r of rules) {
			if (r.tool !== "*" && r.tool !== toolName) continue;
			if (!r.re.test(segment)) continue;
			return { kind: "ask", rule: r.rule, segment, segmentIndex: idx, source };
		}
	}
	return null;
}

/**
 * Pure decision over a command. No prompting: an `ask` result is returned for
 * the caller to resolve. `approvedSegmentIndices` carries the user's
 * "this segment only" choices across prompt rounds.
 */
export function evaluateCommandRules(
	command: string,
	isShell: boolean,
	ruleSets: RuleSets,
	mode: PermissionMode,
	toolName: string,
	agentName: string | null,
	options: EvaluateOptions = {},
): Decision {
	const parsed: ShellParse = isShell
		? parseShellCommand(command)
		: { segments: [command], rawSegments: [command], unsupported: null };
	const segments = parsed.segments;
	const rawSegments = parsed.rawSegments;

	// Fail-closed constructs block before any allow check.
	if (parsed.unsupported !== null) {
		return { kind: "deny", reason: `Blocked: unsupported shell construct (${parsed.unsupported})` };
	}

	// Deny tests the whole command AND every segment (defense in depth): it keeps
	// compound deny rules such as `curl ... | sh` working, and the raw pre-fold
	// segments keep anchored rules working after a `cd` fold rewrites a separator.
	const probes = unique([command, ...segments, ...rawSegments]);

	const globalDeny = firstMatch(compile(ruleSets.globalDeny), toolName, probes);
	if (globalDeny) {
		return { kind: "deny", reason: globalDeny.rule.reason ?? `Denied by global policy: ${globalDeny.rule.match}` };
	}
	const agentDeny = firstMatch(compile(ruleSets.agentDeny), toolName, probes);
	if (agentDeny) {
		return {
			kind: "deny",
			reason: agentDeny.rule.reason ?? `Denied by ${agentName ?? "agent"} policy: ${agentDeny.rule.match}`,
		};
	}

	// "Approved" carries both "this segment only" choices and session-allowed
	// segments. A session-allow marks exactly its matching segment, never the
	// whole command, so every other segment is still checked below.
	const approved = new Set<number>(options.approvedSegmentIndices ?? []);
	// First pass = the caller has approved nothing yet. Session allows are folded
	// into `approved` below, so they must not count as a first pass.
	const wholeProbeDone = (options.approvedSegmentIndices?.size ?? 0) > 0;
	const isSessionAllowed = options.isSessionAllowed;
	if (isSessionAllowed) {
		const sessionAskRules = [...compile(ruleSets.globalAsk), ...compile(ruleSets.agentAsk)];
		for (let idx = 0; idx < segments.length; idx++) {
			if (approved.has(idx)) continue;
			const segment = segments[idx];
			const sessionApproved = sessionAskRules.some(
				(r) => (r.tool === "*" || r.tool === toolName) && r.re.test(segment) && isSessionAllowed(r.rule),
			);
			if (sessionApproved) approved.add(idx);
		}
	}

	// Whole-command ask probe (defense in depth): a rule whose pattern spans a
	// separator cannot match any single segment. Run it on the FIRST pass, BEFORE
	// the per-segment asks, so a spanning ask is always shown once even when a
	// per-segment ask would match first or a session-allowed segment exists. A
	// rule that already matches a segment is left to the per-segment ask below.
	// After the first pass this never runs again, so a `segmentIndex: -1` choice
	// cannot loop; it approves no real segment and the allow check fails closed.
	if (!wholeProbeDone) {
		const wholeProbes = unique([command, ...segments, ...rawSegments]);
		const globalWhole = firstSpanningMatch(compile(ruleSets.globalAsk), toolName, wholeProbes, segments);
		if (globalWhole && !(isSessionAllowed?.(globalWhole.rule) ?? false)) {
			return { kind: "ask", rule: globalWhole.rule, segment: globalWhole.probe, segmentIndex: -1, source: "global" };
		}
		const agentWhole = firstSpanningMatch(compile(ruleSets.agentAsk), toolName, wholeProbes, segments);
		if (agentWhole && !(isSessionAllowed?.(agentWhole.rule) ?? false)) {
			return { kind: "ask", rule: agentWhole.rule, segment: agentWhole.probe, segmentIndex: -1, source: "agent" };
		}
	}

	// Ask tests each unapproved segment (global rules first, then agent rules).
	const globalAsk = findAsk(compile(ruleSets.globalAsk), toolName, segments, approved, "global");
	if (globalAsk) return globalAsk;

	const agentAsk = findAsk(compile(ruleSets.agentAsk), toolName, segments, approved, "agent");
	if (agentAsk) return agentAsk;

	// Allow: deny-by-default requires every unapproved segment to match a rule.
	if (mode === "deny-by-default") {
		if (segments.length === 0) {
			return {
				kind: "default",
				reason: agentName
					? `Denied by default (agent "${agentName}" is deny-by-default; empty command)`
					: "Denied by default: empty command",
			};
		}
		const allowed = compile(ruleSets.agentAllow);
		for (let idx = 0; idx < segments.length; idx++) {
			if (approved.has(idx)) continue;
			const seg = segments[idx];
			if (!firstMatch(allowed, toolName, [seg])) {
				return {
					kind: "default",
					reason: agentName
						? `Denied by default (agent "${agentName}" is deny-by-default; segment not allowed: \`${seg.slice(0, 120)}\`)`
						: `Denied by default: \`${seg.slice(0, 120)}\``,
				};
			}
		}
		return { kind: "allow" };
	}

	// allow-unless-matched: Pi's default, unchanged.
	return { kind: "allow" };
}
