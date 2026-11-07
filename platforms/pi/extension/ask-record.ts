/**
 * Ask records: one line per ask stage in the shared tree log, plus the pure
 * tally the STATUS panel reads and the pure ring the LOG panel reads.
 *
 * The record is written in the ask plumbing, never in the gate. The writer is
 * best-effort, so a lost record never breaks an ask. The tally and the ring
 * hold no fs handle and no timer.
 */

import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent, type RunEvent } from "./tree-log.ts";

/** What one ask settled to. `pending` marks an arrival that no verdict met yet. */
export type AskVerdict = "allow" | "deny" | "expired" | "pending";

/** The stage of one ask that a record reports. */
export type AskPhase = "arrival" | "expiry" | "settle";

/** One ask stage, carried inside a `RunEvent`. */
export interface AskRecord {
	/** The gated tool name. */
	tool: string;
	/** The role that asked. */
	role: string;
	/** The verdict at this stage: `pending` until a settle or an expiry. */
	verdict: AskVerdict;
	/** The ask this record belongs to; an arrival and an expiry share one id. */
	askId: string;
	/** The stage the record reports. */
	phase: AskPhase;
	/** The state fields the warning line printed. A settle carries none. */
	flags: string;
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
	askId: string;
	phase: AskPhase;
	/** Empty on a settle. */
	flags: string;
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
	/** Defaults to `<runId>#<at>`. */
	askId?: string;
	/** Defaults to `settle`. */
	phase?: AskPhase;
	/** Defaults to empty. */
	flags?: string;
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
		ask: {
			tool: input.tool,
			role: input.role,
			verdict: input.verdict,
			askId: input.askId,
			phase: input.phase,
			flags: input.flags,
		},
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
		const runId = input.runId ?? ASK_ROOT_RUN_ID;
		const at = input.at ?? new Date().toISOString();
		appendEvent(
			logPath,
			recordAskLine({
				tool: input.tool,
				role: input.role,
				verdict: input.verdict,
				runId,
				depth: input.depth ?? 0,
				at,
				// A caller with no id gets a stable one, so a pair still folds as one.
				askId: input.askId ?? `${runId}#${at}`,
				phase: input.phase ?? "settle",
				flags: input.flags ?? "",
			}),
		);
	} catch {
		// A lost record must never break an ask.
	}
}

/** The folded ask counts and the newest record. */
export interface AskTally {
	/** Fold one event. One ask counts once, whatever its stages. */
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
			// One ask writes an arrival and a settle, so both fold under one id. An
			// old record carries no id, and falls back to its own stamp and tool.
			const key =
				typeof ask.askId === "string" && ask.askId.length > 0
					? ask.askId
					: `${event.at}\u0000${event.runId}\u0000${ask.tool}`;
			// Every stage of an ask advances the newest stamp, so the age follows
			// the expiry or the settle and not the arrival that queued it.
			const at = Date.parse(event.at);
			if (Number.isFinite(at) && at >= latestMs) {
				latestMs = at;
				latest = { tool: ask.tool, at: event.at };
			}
			if (seen.has(key)) return;
			seen.add(key);
			counts[ask.tool] = (counts[ask.tool] ?? 0) + 1;
		},
		usage(): Record<string, number> {
			return { ...counts };
		},
		latest(): { tool: string; at: string } | null {
			return latest ? { ...latest } : null;
		},
	};
}

/** One ask event kept for the LOG panel and the overlay. */
export interface AskLogEvent {
	askId: string;
	phase: AskPhase;
	/** ISO stamp of the record. */
	at: string;
	/** The panel line: `<HH:MM:SS> <role>/<tool> <flags>`. */
	text: string;
}

/** Ask events kept in the ring. Older events drop first. */
export const ASK_HISTORY_MAX = 50;

/** The ring the LOG panel and the overlay read. */
export interface AskLog {
	/** Fold one event. Only an arrival and an expiry are kept. */
	observe(event: RunEvent): void;
	/** The kept events, oldest first. */
	rows(): AskLogEvent[];
	/** Empty the ring, so a fold can start again from the same list. */
	reset(): void;
}

/** The clock part of an ISO stamp, or the stamp when it is not ISO. */
function clockOf(at: string): string {
	return at.length >= 19 && at.charAt(10) === "T" ? at.slice(11, 19) : at;
}

/** The panel line of one ask record. */
function textOf(event: RunEvent, ask: AskRecord): string {
	const head = `${clockOf(event.at)} ${ask.role}/${ask.tool}`;
	return typeof ask.flags === "string" && ask.flags.length > 0 ? `${head} ${ask.flags}` : head;
}

/**
 * Make one ring. It keeps an arrival and an expiry, because those are the two
 * stages a waiting child passes. A settle carries no queue state, so it is not
 * a panel event. The oldest event drops past `ASK_HISTORY_MAX`.
 */
export function createAskLog(): AskLog {
	let ring: AskLogEvent[] = [];
	return {
		observe(event: RunEvent): void {
			if (!event || event.type !== "ask") return;
			const ask = event.ask;
			if (!ask || typeof ask.askId !== "string" || ask.askId.length === 0) return;
			if (ask.phase !== "arrival" && ask.phase !== "expiry") return;
			ring.push({ askId: ask.askId, phase: ask.phase, at: event.at, text: textOf(event, ask) });
			if (ring.length > ASK_HISTORY_MAX) ring = ring.slice(ring.length - ASK_HISTORY_MAX);
		},
		rows(): AskLogEvent[] {
			return ring.slice();
		},
		reset(): void {
			ring = [];
		},
	};
}
