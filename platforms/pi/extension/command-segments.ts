/**
 * Permission decision core for the pi gate.
 *
 * This module has NO pi imports, so it runs under plain Node and is testable
 * with `node:test`. `permissions.ts` keeps the pi wiring (session keys, prompt,
 * events) and calls `evaluateCommandRules` once per segment-approval round. The
 * shell lexer lives in `shell-parse.ts`.
 */

import { parseShellCommand, type ShellParse, skipSingle } from "./shell-parse.ts";

export interface RawRule {
	tool?: string;
	match: string;
	reason?: string;
	/** Which configuration layer produced the rule; set by `permission-config.ts`. */
	layer?: Layer;
}

/**
 * The three permission layers, in load order: the shipped default file, the user
 * override file, and the live global overlay. A compiled rule records its layer
 * so a reader can tell a shipped row from a local one.
 */
export type Layer = "default" | "override" | "overlay";

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
			/** Real start offset of `segment` in the command, or -1 for a span. */
			segmentStart: number;
			/** Which rule set produced the ask. */
			source: "global" | "agent";
	  }
	| { kind: "allow" }
	| { kind: "default"; reason: string };

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
	 * Segment indices the user approved with "Always allow" on a segment.
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
 * Compiled-regex cache for the gate hot path. Semantics: unanchored,
 * case-insensitive, non-global, so `lastIndex` never moves. The overlay loader
 * calls this function, so its load check cannot drift from the build check.
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

/** Thin test wrapper: the segments of a command, ignoring fail-closed markers. */
export function splitShellSegments(command: string): string[] {
	return parseShellCommand(command).segments;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

/**
 * A probe with quotes removed and backslash escapes resolved. A quoted
 * separator (`"a;b"`) keeps a segment whole, and a mid-token quote
 * (`--co"nfig"`) splits a token, so both hide a literal deny from the raw
 * probe. A shell also resolves a backslash escape before cargo sees it
 * (`--co\nfig` becomes `--config`), so the deny probe must model the resolved
 * form. Deny rules test this variant as well, so it can only add a denial,
 * never an allowance.
 */
function dequoteProbe(probe: string): string {
	// `$"..."` is bash locale quoting; for the gate it behaves like `"..."`.
	// Drop the `$` first, so the content (`--lost-found`, `-w`, `--output`)
	// reaches the ask/deny guards that the quotes would otherwise split.
	return probe.replace(/\$"/g, '"').replace(/["']/g, "").replace(/\\(.)/g, "$1");
}

/** A separator that was quoted or escaped becomes `_`: it is data, not a separator. */
function neutralChar(ch: string): string {
	return ch === ";" || ch === "&" || ch === "|" || ch === "\n" ? "_" : ch;
}

/**
 * The dequoted probe with quoted and escaped separators made neutral. In
 * `dequoteProbe` a quoted `;` turns bare, so a scan that stops at a separator
 * cannot reach a quoted option after it (`-m 'a;b' '--amend'`). This variant
 * keeps that scan going. It is an extra probe next to `dequoteProbe`, never a
 * replacement, so a rule anchored on a separator still sees the old form:
 * ask and deny rules can only match more.
 */
export function neutralDequoteProbe(probe: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < probe.length; i++) {
		const ch = probe[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else out += neutralChar(ch);
			continue;
		}
		if (ch === "\\" && i + 1 < probe.length) {
			i++;
			out += neutralChar(probe[i]);
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			else out += neutralChar(ch);
			continue;
		}
		if (ch === "$" && probe[i + 1] === '"') {
			quote = '"';
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		out += ch;
	}
	return out;
}

/** Every deny/ask variant of a probe: the old dequoted form and the neutral one. */
function normalizedProbes(probe: string): string[] {
	return [dequoteProbe(probe), neutralDequoteProbe(probe)];
}

/**
 * True when `ch` can start a bash parameter expansion after a `$`: a name
 * char (`$W`), a brace (`${W}`), or a positional/special parameter (`$1`,
 * `$?`, `$$`). `$(` is excluded because the parser extracts and checks its
 * payload, and `$'`/`$"` have their own handling below.
 */
function startsParameterExpansion(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z_{0-9*@#$!-]/.test(ch);
}

/**
 * True when a segment holds a shell expansion the gate cannot resolve at
 * decision time. Bash expands `$W` / `${W}` / `$1` from the environment, so a
 * read verb can turn into a write after the allow check; the gate fails closed
 * instead. `$"..."` is resolvable (handled by `dequoteProbe`), `$'...'` is the
 * parser's `ansi-c` fail-closed construct, and `$(...)` is extracted and
 * checked by the parser, so none of those are reported here. A `$` that starts
 * no expansion (a trailing `$`, a `$` before a space or a closing quote) is
 * literal and passes.
 */
function hasUnresolvedExpansion(segment: string): boolean {
	let i = 0;
	const n = segment.length;
	while (i < n) {
		const c = segment[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			i = skipSingle(segment, i);
			continue;
		}
		if (c === '"') {
			// Inside double quotes, `$W` / `${W}` / `$1` still expand.
			i++;
			while (i < n && segment[i] !== '"') {
				const d = segment[i];
				if (d === "\\") {
					i += 2;
					continue;
				}
				if (d === "$" && startsParameterExpansion(segment[i + 1])) return true;
				i++;
			}
			i++;
			continue;
		}
		if (c === "$" && startsParameterExpansion(segment[i + 1])) return true;
		i++;
	}
	return false;
}

/**
 * A segment plus its dequoted variants. Ask rules test this list, so a
 * quote/backslash-obfuscated escape guard sees the resolved form, mirroring the
 * deny path. The raw segment stays first so a raw match wins.
 */
function askProbes(segment: string): string[] {
	return unique([segment, ...normalizedProbes(segment)]);
}

/**
 * True when a session "Always allow" approves the whole segment: at least one
 * ask rule matches it, and EVERY ask rule that matches it (over all ask
 * probes) is session-allowed. One allowed rule must not approve a segment
 * that a sibling ask rule still gates (`git pull -s ours --upload-pack=x`).
 */
function isSessionApprovedSegment(
	rules: CompiledRule[],
	toolName: string,
	segment: string,
	isSessionAllowed: (rule: RawRule) => boolean,
): boolean {
	const probes = askProbes(segment);
	const matching = rules.filter(
		(r) => (r.tool === "*" || r.tool === toolName) && probes.some((probe) => r.re.test(probe)),
	);
	return matching.length > 0 && matching.every((r) => isSessionAllowed(r.rule));
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
	isSessionAllowed?: (rule: RawRule) => boolean,
): RuleMatch | null {
	for (const r of rules) {
		if (r.tool !== "*" && r.tool !== toolName) continue;
		// A session-allowed spanning rule must not hide a later one.
		if (isSessionAllowed?.(r.rule)) continue;
		if (segments.some((s) => askProbes(s).some((probe) => r.re.test(probe)))) continue;
		for (const probe of probes) {
			if (r.re.test(probe)) return { rule: r.rule, probe };
		}
	}
	return null;
}

type AskDecision = Extract<Decision, { kind: "ask" }>;

/**
 * Find the first unapproved segment that matches an ask rule not yet allowed
 * for the session. A session-allowed rule is skipped, so the prompt names the
 * rule that still blocks. A segment whose matching rules are all allowed is
 * already in `approved` (isSessionApprovedSegment), so a skip never lets a
 * segment that should ask fall through. Returns the ask decision or `null`.
 */
function findAsk(
	rules: CompiledRule[],
	toolName: string,
	segments: string[],
	segmentStarts: number[],
	approved: ReadonlySet<number>,
	source: "global" | "agent",
	isSessionAllowed?: (rule: RawRule) => boolean,
): AskDecision | null {
	for (let idx = 0; idx < segments.length; idx++) {
		if (approved.has(idx)) continue;
		const segment = segments[idx];
		const probes = askProbes(segment);
		for (const r of rules) {
			if (r.tool !== "*" && r.tool !== toolName) continue;
			if (!probes.some((probe) => r.re.test(probe))) continue;
			// Name the first matching rule not yet allowed for the session. A
			// segment whose matching rules are all allowed is already in
			// `approved` (isSessionApprovedSegment), so skipping stays fail-closed.
			if (isSessionAllowed?.(r.rule)) continue;
			return {
				kind: "ask",
				rule: r.rule,
				segment,
				segmentIndex: idx,
				segmentStart: segmentStarts[idx],
				source,
			};
		}
	}
	return null;
}

/**
 * The policy layer that owns a rule, as the reason text names it.
 */
export function policyLayer(source: "global" | "agent", agentName: string | null): string {
	return source === "global" ? "global policy" : `${agentName ?? "agent"} policy`;
}

/**
 * The one reason sentence for a rule that carries no written reason of its own.
 * It names the policy layer and the tool, and the deny log and the ask panel
 * both show it, so one rule never reads two ways.
 */
export function ruleReasonFallback(
	toolName: string,
	source: "global" | "agent",
	agentName: string | null,
): string {
	return `${toolName} is denied by ${policyLayer(source, agentName)}, and the rule has no written reason of its own`;
}

/**
 * The rule's human reason, or undefined when the text is empty or is the rule
 * regex. A reason equal to the regex is not human text, so it is dropped.
 */
export function humanReason(
	reason: string | undefined,
	match: string | undefined,
): string | undefined {
	const trimmed = reason?.trim();
	if (!trimmed || trimmed === match) return undefined;
	return trimmed;
}

/**
 * Human deny reason. It never contains the rule regex. A rule's `reason` is
 * used only when it is human text; the fallback sentence speaks otherwise.
 */
function denyReason(
	rule: RawRule,
	toolName: string,
	source: "global" | "agent",
	agentName: string | null,
): string {
	return humanReason(rule.reason, rule.match) ?? ruleReasonFallback(toolName, source, agentName);
}

interface FoldedSegments {
	parsed: ShellParse;
	approved: Set<number>;
	/** Unapproved segments that carry an expansion or match no allow rule. */
	indices: number[];
	/** First unapproved index that holds an unresolved expansion, or -1. */
	expansion: number;
}

/**
 * Fold caller approvals and session allows into one approved set, then list the
 * unapproved segments that can never be allowed: a segment with an unresolved
 * expansion, or one that matches no agent allow rule. Every caller that needs
 * this list gets the expansion guard, so no path can skip it.
 */
function foldUnapprovedSegments(
	command: string,
	isShell: boolean,
	ruleSets: RuleSets,
	toolName: string,
	approvedSegmentIndices: ReadonlySet<number> = new Set(),
	isSessionAllowed?: (rule: RawRule) => boolean,
): FoldedSegments {
	const parsed: ShellParse = isShell
		? parseShellCommand(command)
		: { segments: [command], rawSegments: [command], segmentStarts: [0], unsupported: null };
	const approved = new Set<number>(approvedSegmentIndices);
	if (isSessionAllowed) {
		const sessionAskRules = [...compile(ruleSets.globalAsk), ...compile(ruleSets.agentAsk)];
		for (let idx = 0; idx < parsed.segments.length; idx++) {
			if (approved.has(idx)) continue;
			if (isSessionApprovedSegment(sessionAskRules, toolName, parsed.segments[idx], isSessionAllowed)) {
				approved.add(idx);
			}
		}
	}
	const allowed = compile(ruleSets.agentAllow);
	const indices: number[] = [];
	let expansion = -1;
	for (let idx = 0; idx < parsed.segments.length; idx++) {
		if (approved.has(idx)) continue;
		const seg = parsed.segments[idx];
		const expandable = hasUnresolvedExpansion(seg);
		if (expandable && expansion < 0) expansion = idx;
		if (expandable || !firstMatch(allowed, toolName, [seg])) indices.push(idx);
	}
	return { parsed, approved, indices, expansion };
}

/**
 * Pure decision over a command. No prompting: an `ask` result is returned for
 * the caller to resolve. `approvedSegmentIndices` carries the user's segment
 * "Always allow" choices across prompt rounds.
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
	const { parsed, approved, indices, expansion } = foldUnapprovedSegments(
		command,
		isShell,
		ruleSets,
		toolName,
		options.approvedSegmentIndices,
		options.isSessionAllowed,
	);
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
	// Deny-only defense in depth: a quoted separator, a mid-token quote, or a
	// backslash escape hides a literal deny from the raw probes. The normalized
	// variants can add a denial, never an allowance.
	const denyProbes = unique([...probes, ...probes.flatMap(normalizedProbes)]);

	const globalDeny = firstMatch(compile(ruleSets.globalDeny), toolName, denyProbes);
	if (globalDeny) {
		return { kind: "deny", reason: denyReason(globalDeny.rule, toolName, "global", agentName) };
	}
	const agentDeny = firstMatch(compile(ruleSets.agentDeny), toolName, denyProbes);
	if (agentDeny) {
		return { kind: "deny", reason: denyReason(agentDeny.rule, toolName, "agent", agentName) };
	}

	// "Approved" carries both segment "Always allow" choices and session-allowed
	// segments. A session-allow marks exactly its matching segment, never the
	// whole command, so every other segment is still checked below.
	// First pass = the caller has approved nothing yet. Session allows are folded
	// into `approved` above, so they must not count as a first pass.
	const wholeProbeDone = (options.approvedSegmentIndices?.size ?? 0) > 0;
	const isSessionAllowed = options.isSessionAllowed;

	// Whole-command ask probe (defense in depth): a rule whose pattern spans a
	// separator cannot match any single segment. Run it on the FIRST pass, BEFORE
	// the per-segment asks, so a spanning ask is always shown once even when a
	// per-segment ask would match first or a session-allowed segment exists. A
	// rule that already matches a segment is left to the per-segment ask below.
	// After the first pass this never runs again, so a `segmentIndex: -1` choice
	// cannot loop; it approves no real segment and the allow check fails closed.
	if (!wholeProbeDone) {
		const wholeProbes = unique(
			[command, ...segments, ...rawSegments].flatMap((probe) => askProbes(probe)),
		);
		const globalWhole = firstSpanningMatch(
			compile(ruleSets.globalAsk), toolName, wholeProbes, segments, isSessionAllowed,
		);
		if (globalWhole && !(isSessionAllowed?.(globalWhole.rule) ?? false)) {
			return {
				kind: "ask",
				rule: globalWhole.rule,
				segment: globalWhole.probe,
				segmentIndex: -1,
				segmentStart: -1,
				source: "global",
			};
		}
		const agentWhole = firstSpanningMatch(
			compile(ruleSets.agentAsk), toolName, wholeProbes, segments, isSessionAllowed,
		);
		if (agentWhole && !(isSessionAllowed?.(agentWhole.rule) ?? false)) {
			return {
				kind: "ask",
				rule: agentWhole.rule,
				segment: agentWhole.probe,
				segmentIndex: -1,
				segmentStart: -1,
				source: "agent",
			};
		}
	}

	// Ask tests each unapproved segment (global rules first, then agent rules).
	const globalAsk = findAsk(
		compile(ruleSets.globalAsk), toolName, segments, parsed.segmentStarts, approved, "global", isSessionAllowed,
	);
	if (globalAsk) return globalAsk;

	const agentAsk = findAsk(
		compile(ruleSets.agentAsk), toolName, segments, parsed.segmentStarts, approved, "agent", isSessionAllowed,
	);
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
		if (indices.length > 0) {
			const idx = indices[0];
			const seg = segments[idx].slice(0, 120);
			if (idx === expansion) {
				return {
					kind: "default",
					reason: agentName
						? `Denied by default (agent "${agentName}" is deny-by-default; unresolved shell expansion in segment: \`${seg}\`)`
						: `Denied by default: unresolved shell expansion in \`${seg}\``,
				};
			}
			return {
				kind: "default",
				reason: agentName
					? `Denied by default (agent "${agentName}" is deny-by-default; segment not allowed: \`${seg}\`)`
					: `Denied by default: \`${seg}\``,
			};
		}
		return { kind: "allow" };
	}

	// allow-unless-matched: Pi's default. An unresolved shell expansion is the
	// one exception; bash resolves it after the gate, so it cannot be allowed.
	if (expansion >= 0) {
		const seg = segments[expansion].slice(0, 120);
		return { kind: "default", reason: `Denied: unresolved shell expansion in \`${seg}\`` };
	}
	return { kind: "allow" };
}

/**
 * The parsed segments that reach deny-by-default: neither approved by the
 * caller nor matched by an agent allow rule, plus every segment that carries an
 * unresolved expansion. On a deny-by-default fall-through these are exactly the
 * segments that need the structural skill-script check. `segments` is the
 * cd-folded list, so an index lines up with the indices in
 * `evaluateCommandRules`.
 */
export function unallowedSegments(
	command: string,
	isShell: boolean,
	ruleSets: RuleSets,
	toolName: string,
	approvedSegmentIndices: ReadonlySet<number> = new Set(),
	isSessionAllowed?: (rule: RawRule) => boolean,
): { segments: string[]; indices: number[] } {
	const { parsed, indices } = foldUnapprovedSegments(
		command,
		isShell,
		ruleSets,
		toolName,
		approvedSegmentIndices,
		isSessionAllowed,
	);
	return { segments: parsed.segments, indices };
}
