/**
 * Ask records: one line per settled ask in the shared tree log, plus the pure
 * tally the STATUS panel reads.
 *
 * The record is written in the ask plumbing, never in the gate. The writer is
 * best-effort, so a lost record never breaks an ask. The tally holds no fs
 * handle and no timer.
 */

import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent, type RunEvent } from "./tree-log.ts";

/** What one ask settled to. */
export type AskVerdict = "allow" | "deny" | "expired";

/** One settled ask, carried inside a `RunEvent`. */
export interface AskRecord {
	/** The gated tool name. */
	tool: string;
	/** The role that asked. */
	role: string;
	/** The verdict the owner or the deadline gave. */
	verdict: AskVerdict;
}

/** The fully resolved fields of one ask line. */
export interface AskLineInput {
	tool: string;
	role: string;
	verdict: AskVerdict;
	/** The asking session id. */
	runId: string;
	/** The walked depth of the asking session. */
	depth: number;
	/** ISO stamp of the write. */
	at: string;
}

/** The caller fields of one write. Every other field has a default. */
export interface RecordAskInput {
	tool: string;
	role: string;
	verdict: AskVerdict;
	/** Defaults to `ASK_ROOT_RUN_ID`. */
	runId?: string;
	/** Defaults to `0`. */
	depth?: number;
	/** Defaults to the current time. */
	at?: string;
}

/** The run id a write with no session carries. */
export const ASK_ROOT_RUN_ID = "root";

/** Build one `ask` event. Pure: the caller supplies every field. */
export function recordAskLine(input: AskLineInput): RunEvent {
	return {
		v: 1,
		type: "ask",
		runId: input.runId,
		parentRunId: null,
		depth: input.depth,
		agent: input.role,
		persona: null,
		status: "idle",
		at: input.at,
		ask: { tool: input.tool, role: input.role, verdict: input.verdict },
	};
}

/**
 * Append one ask record to the shared tree log. A missing env var writes
 * nothing, and every throw is swallowed.
 */
export function recordAsk(input: RecordAskInput): void {
	try {
		const logPath = process.env[ENV_TREE_LOG];
		if (!logPath) return;
		appendEvent(
			logPath,
			recordAskLine({
				tool: input.tool,
				role: input.role,
				verdict: input.verdict,
				runId: input.runId ?? ASK_ROOT_RUN_ID,
				depth: input.depth ?? 0,
				at: input.at ?? new Date().toISOString(),
			}),
		);
	} catch {
		// A lost record must never break an ask.
	}
}

/** The folded ask counts and the newest record. */
export interface AskTally {
	/** Fold one event. A repeated record counts once. */
	observe(event: RunEvent): void;
	/** The ask count per tool. */
	usage(): Record<string, number>;
	/** The newest counted tool and its stamp, or null before the first record. */
	latest(): { tool: string; at: string } | null;
}

/**
 * Make one tally. A count never subtracts, so a `clear` that prunes the run
 * from the tree keeps every ask record.
 */
export function createAskTally(): AskTally {
	const counts: Record<string, number> = {};
	const seen = new Set<string>();
	let latest: { tool: string; at: string } | null = null;
	let latestMs = Number.NEGATIVE_INFINITY;
	return {
		observe(event: RunEvent): void {
			if (!event || event.type !== "ask") return;
			const ask = event.ask;
			if (!ask || typeof ask.tool !== "string" || ask.tool.length === 0) return;
			// One record can arrive twice in one read, so the key is deduped.
			const key = `${event.at}\u0000${event.runId}\u0000${ask.tool}`;
			if (seen.has(key)) return;
			seen.add(key);
			counts[ask.tool] = (counts[ask.tool] ?? 0) + 1;
			const at = Date.parse(event.at);
			if (Number.isFinite(at) && at >= latestMs) {
				latestMs = at;
				latest = { tool: ask.tool, at: event.at };
			}
		},
		usage(): Record<string, number> {
			return { ...counts };
		},
		latest(): { tool: string; at: string } | null {
			return latest ? { ...latest } : null;
		},
	};
}
