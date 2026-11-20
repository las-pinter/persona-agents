/**
 * Session facts for `/retro`.
 *
 * The retro is print-only: it writes nothing durable. This module gathers what
 * the session actually did — the tools it called, the files it changed, the
 * compactions, the reviews, and every permission decision — so the model can
 * review the session against evidence instead of its own memory.
 */

import type { EntryLike } from "../compaction/manifest.ts";

/** One line of the decisions log. */
export interface DecisionLine {
	at?: string;
	session?: string;
	agent?: string;
	tool?: string;
	verdict?: string;
	source?: string;
	reason?: string;
	matched?: string;
}

export interface FactsInput {
	entries: EntryLike[];
	/** The decisions log lines for this session only. */
	decisions: DecisionLine[];
	/** The journal entry paths this session wrote, when known. */
	journal?: string[];
}

/** Parse the JSONL decisions log; a bad line is skipped, not fatal. */
export function parseDecisions(text: string): DecisionLine[] {
	const lines: DecisionLine[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as DecisionLine;
			if (parsed && typeof parsed === "object") lines.push(parsed);
		} catch {
			// A log line is best effort: one truncated write must not break the retro.
		}
	}
	return lines;
}

/** The lines that belong to one session. */
export function sessionDecisions(lines: DecisionLine[], session: string): DecisionLine[] {
	return lines.filter((line) => line.session === session);
}

const cap = (items: string[], max: number): string[] => (items.length <= max ? items : [...items.slice(0, max), `… and ${items.length - max} more`]);

/** The tool calls of the branch, by tool name. */
export function toolCalls(entries: EntryLike[]): { name: string; arguments: Record<string, unknown> }[] {
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			const candidate = block as { type?: unknown; name?: unknown; arguments?: unknown } | null;
			if (candidate?.type !== "toolCall" || typeof candidate.name !== "string") continue;
			const args = candidate.arguments;
			calls.push({ name: candidate.name, arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {} });
		}
	}
	return calls;
}

/** A compact, honest report of what the session did. */
export function summarizeSession(input: FactsInput): string {
	const calls = toolCalls(input.entries);
	const byTool = new Map<string, number>();
	for (const call of calls) byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1);
	const toolLines = [...byTool.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([name, count]) => `${name} ×${count}`);

	const changed = [
		...new Set(
			calls
				.filter((call) => ["write", "edit", "patch", "apply_patch"].includes(call.name))
				.map((call) => (typeof call.arguments.path === "string" ? call.arguments.path : ""))
				.filter((path) => path !== ""),
		),
	];
	const compactions = input.entries.filter((entry) => entry.type === "compaction").length;
	const reviews = (input.entries as (EntryLike & { customType?: string; data?: unknown })[])
		.filter((entry) => entry.customType === "persona-agents:review")
		.map((entry) => (entry.data as { verdict?: unknown } | undefined)?.verdict)
		.filter((verdict): verdict is string => typeof verdict === "string");

	const verdicts = new Map<string, number>();
	for (const decision of input.decisions) {
		const key = decision.verdict ?? "unknown";
		verdicts.set(key, (verdicts.get(key) ?? 0) + 1);
	}
	const notable = input.decisions
		.filter((decision) => decision.verdict === "ask" || decision.verdict === "deny")
		.map((decision) => `${decision.verdict} ${decision.tool ?? "?"} — ${decision.reason ?? ""}`);

	const lines = [
		"## Session facts",
		"",
		`- tool calls: ${calls.length}${toolLines.length ? ` (${toolLines.join(", ")})` : ""}`,
		`- files changed: ${changed.length}`,
		...cap(changed, 20).map((path) => `  - ${path}`),
		`- compactions: ${compactions}`,
		`- independent reviews: ${reviews.length}${reviews.length ? ` (${reviews.join(", ")})` : ""}`,
		`- permission decisions: ${input.decisions.length}${input.decisions.length ? ` (${[...verdicts.entries()].map(([verdict, count]) => `${verdict} ${count}`).join(", ")})` : ""}`,
	];
	if (notable.length > 0) {
		lines.push("- asks and denials:", ...cap(notable, 10).map((line) => `  - ${line}`));
	}
	if (input.journal && input.journal.length > 0) {
		lines.push("- journal:", ...cap(input.journal, 5).map((path) => `  - ${path}`));
	}
	return lines.join("\n");
}

/** The instruction the retro run gets on top of the facts. */
export const RETRO_INSTRUCTION = [
	"Run a blameless retro on this session, print only: what was supposed to happen, what happened, what was right and wrong, and the actions worth taking.",
	"Use the facts below as evidence. Write nothing durable: no journal entry, no notes, no commit.",
].join("\n");
