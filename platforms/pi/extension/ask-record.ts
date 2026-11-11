/**
 * Ask records: one line per ask stage in the shared tree log, plus the pure
 * ring the LOG panel reads. The ring holds every extension message: an ask
 * queue event, and a plain log line.
 *
 * The record is written in the ask plumbing, never in the gate. The writer is
 * best-effort, so a lost record never breaks an ask. The ring holds no fs
 * handle and no timer.
 */

import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent, type RunEvent } from "./tree-log.ts";

/** What one ask settled to. `pending` marks an arrival that no verdict met yet. */
type AskVerdict = "allow" | "deny" | "expired" | "pending";

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
	/** The flag fields the panel row prints. A settle carries none. */
	flags: string;
}

/**
 * The fully resolved fields of one ask line.
 *
 * @internal The record-line tests supply every field. Production code calls
 * `recordAsk`.
 */
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
	/** Defaults to an id minted from the run id. */
	askId?: string;
	/** Defaults to `settle`. */
	phase?: AskPhase;
	/** Defaults to empty. */
	flags?: string;
}

/** The run id a write with no session carries. */
export const ASK_ROOT_RUN_ID = "root";

/**
 * The ask counter per scope. Two asks in the same millisecond share one stamp.
 * The counter keeps their ids apart, so the log folds them as two asks. The map
 * is never pruned: it keeps one small entry per distinct scope for the life of
 * the process.
 */
const askSeqByScope = new Map<string, number>();

/**
 * One ask id: the scope, the stamp, and the scope counter. A session id scopes
 * an arrival, and a run id scopes a settle with no session. One mint for both
 * gives a fold one shape to join.
 */
export function mintAskId(scope: string, at: string): string {
	const seq = (askSeqByScope.get(scope) ?? 0) + 1;
	askSeqByScope.set(scope, seq);
	return `${scope}#${at}#${seq}`;
}

/**
 * Build one `ask` event. Pure: the caller supplies every field.
 *
 * @internal The record-line tests call this. Production code calls `recordAsk`.
 */
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
				// A caller with no id gets one from the one mint, not a second shape.
				askId: input.askId ?? mintAskId(runId, at),
				phase: input.phase ?? "settle",
				flags: input.flags ?? "",
			}),
		);
	} catch {
		// A lost record must never break an ask.
	}
}

/** The caller fields of one plain log line. */
export interface RecordLogInput {
	/** The finished line. Whitespace collapses, so one message stays one line. */
	text: string;
	/** Defaults to `ASK_ROOT_RUN_ID`. */
	runId?: string;
	/** Defaults to the current time. */
	at?: string;
}

/**
 * Lines written before the log path exists, oldest first. The ring holds them,
 * so a line that arrives before the sidebar still paints with the first frame.
 */
let pendingLogs: RunEvent[] = [];

/** The plain lines held for a log path that does not exist yet, oldest first. */
export function pendingLogEvents(): RunEvent[] {
	return pendingLogs.slice();
}

/**
 * Build one `log` event. Pure: the caller supplies every field.
 *
 * @internal The line tests call this. Production code calls `recordLogLine`.
 */
export function logLineEvent(input: { text: string; at: string; runId?: string }): RunEvent {
	return {
		v: 1,
		type: "log",
		runId: input.runId ?? ASK_ROOT_RUN_ID,
		parentRunId: null,
		depth: 0,
		agent: "",
		persona: null,
		status: "idle",
		at: input.at,
		text: input.text,
	};
}

/**
 * Write the held lines when a log path exists, oldest first. A missing path
 * keeps them, so a later call still writes them. One event shifts per pass, so
 * a throw keeps the lines not yet written.
 */
export function flushPendingLogEvents(): void {
	if (pendingLogs.length === 0) return;
	try {
		const logPath = process.env[ENV_TREE_LOG];
		if (!logPath) return;
		while (pendingLogs.length > 0) {
			appendEvent(logPath, pendingLogs[0]);
			pendingLogs.shift();
		}
	} catch {
		// A lost line must never break the caller.
	}
}

/**
 * Append one plain line to the shared tree log. This is the one entry point for
 * an extension message that is not an ask event, so the ring keeps one order.
 * A line written before the log path exists is held, up to the ring cap, and
 * the ring shows it until the flush writes it.
 */
export function recordLogLine(input: RecordLogInput): void {
	const text = input.text.replace(/\s+/g, " ").trim();
	if (text.length === 0) return;
	try {
		const event = logLineEvent({ text, at: input.at ?? new Date().toISOString(), runId: input.runId });
		pendingLogs.push(event);
		if (pendingLogs.length > ASK_HISTORY_MAX) {
			pendingLogs = pendingLogs.slice(pendingLogs.length - ASK_HISTORY_MAX);
		}
		flushPendingLogEvents();
	} catch {
		// A lost line must never break the caller.
	}
}

/** The kind of one ring entry: an ask queue event, or a plain extension line. */
type LogKind = "ask" | "log";

/**
 * One entry kept for the LOG panel and the overlay.
 *
 * The readers' contract: every entry a reader receives carries a kind, and the
 * ring normalizes an entry that has none to an ask event. So no reader can
 * mislabel a plain line as an ask.
 */
export interface AskLogEvent {
	/** `ask` for an ask queue event, `log` for a plain line. */
	kind: LogKind;
	/** The ask this entry belongs to. Empty on a plain line. */
	askId: string;
	/** The ask stage. A plain line carries `settle`, because it has no stage. */
	phase: AskPhase;
	/** ISO stamp of the record. */
	at: string;
	/** The panel line: `<HH:MM:SS> <role>/<tool> <flags>`, or the plain line text. */
	text: string;
}

/**
 * Ask events kept in the ring. Older events drop first.
 *
 * @internal The cap tests read this. Production code never names it.
 */
export const ASK_HISTORY_MAX = 50;

/** The ring the LOG panel and the overlay read. */
export interface AskLog {
	/** Keep one event: an arrival, an expiry, or one plain line. */
	observe(event: RunEvent): void;
	/** The kept events, oldest first. */
	rows(): AskLogEvent[];
	/** Empty the ring, so a new pass can start from the same list. */
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
 * The readers' contract: a record with no kind is an ask event. The ring maps
 * every row through this one boundary, so a reader cannot mislabel a plain line
 * as an ask.
 *
 * @internal The boundary test calls this directly. Production code reads `rows`.
 */
export function logRowOf(row: AskLogEvent): AskLogEvent {
	return { ...row, kind: row.kind === "log" ? "log" : "ask" };
}

/**
 * Make one ring. It keeps an arrival and an expiry, because those are the two
 * stages a waiting child passes. A settle carries no queue state, so it is not
 * a panel event. A plain line is kept whole. The oldest entry drops past
 * `ASK_HISTORY_MAX`, whatever its kind, so one ring holds one order.
 */
export function createAskLog(): AskLog {
	let ring: AskLogEvent[] = [];
	const push = (entry: AskLogEvent): void => {
		ring.push(entry);
		if (ring.length > ASK_HISTORY_MAX) ring = ring.slice(ring.length - ASK_HISTORY_MAX);
	};
	return {
		observe(event: RunEvent): void {
			if (!event) return;
			if (event.type === "log") {
				if (typeof event.text !== "string" || event.text.length === 0) return;
				push({ kind: "log", askId: "", phase: "settle", at: event.at, text: event.text });
				return;
			}
			if (event.type !== "ask") return;
			const ask = event.ask;
			if (!ask || typeof ask.askId !== "string" || ask.askId.length === 0) return;
			if (ask.phase !== "arrival" && ask.phase !== "expiry") return;
			push({ kind: "ask", askId: ask.askId, phase: ask.phase, at: event.at, text: textOf(event, ask) });
		},
		rows(): AskLogEvent[] {
			// The one read boundary: `logRowOf` supplies the kind a reader needs.
			return ring.map(logRowOf);
		},
		reset(): void {
			ring = [];
		},
	};
}
