/**
 * Shared append-only NDJSON log for the live agent tree.
 *
 * The root process and every spawned child append to one file. Each call writes
 * exactly one complete JSON line. A reader tolerates partial or corrupt lines.
 *
 * Best-effort: no function here throws. A lost record must never break a spawn
 * or the root TUI.
 *
 * No pi import at module top: the log is plain Node I/O and testable offline.
 */

import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Token and cost totals for one run. */
export interface RunUsage {
	input: number;
	output: number;
	cost: number;
	turns: number;
}

/** One tree event. One JSON line per event. */
export interface RunEvent {
	v: 1;
	type: "start" | "update" | "end";
	runId: string;
	parentRunId: string | null;
	depth: number;
	agent: string;
	persona: string | null;
	status: "idle" | "running" | "done" | "failed";
	at: string;
	task?: string;
	bytesIn?: number;
	bytesOut?: number;
	usage?: RunUsage;
	exitCode?: number | null;
	error?: string | null;
	outputPreview?: string;
}

/**
 * Cap for one event line, including its trailing newline.
 * POSIX `O_APPEND` writes under `PIPE_BUF` do not interleave, so the whole
 * line plus its newline must stay under this cap.
 */
export const MAX_EVENT_BYTES = 4096;
/** Cap for the whole log. Only the root compacts over this size. */
export const MAX_LOG_BYTES = 1 << 20;
/** Cap for one read. Older events are dropped. */
export const MAX_EVENTS_READ = 2000;

/** Records kept at the tail by `compactLog`. */
const COMPACT_TAIL = 500;

/**
 * Byte-safe truncation. The result never exceeds `maxBytes` UTF-8 bytes.
 * Reuses the same char-slice-then-back-off style as `subagent.ts`.
 */
function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

	let truncated = value.slice(0, maxBytes);
	while (truncated.length > 0 && Buffer.byteLength(truncated, "utf8") > maxBytes) {
		truncated = truncated.slice(0, -1);
	}
	return truncated;
}

/** The variable-length text fields that `fitEventLine` may shrink. */
type TextField = "task" | "outputPreview" | "error";

/**
 * Serialize one event so its line, including the trailing newline, never
 * exceeds `MAX_EVENT_BYTES`.
 *
 * Shrinks `task` and `outputPreview` (and, as a safety net, `error`) until the
 * serialized line fits. JSON escaping can expand a string, so the loop reduces
 * the byte budget each pass. The fixed fields alone are far below the cap.
 */
function fitEventLine(event: RunEvent): string {
	// Reserve one byte for the trailing "\n" appended by `appendEvent`.
	const maxLineBytes = MAX_EVENT_BYTES - 1;
	const candidate: RunEvent = { ...event };
	let line = JSON.stringify(candidate);
	if (Buffer.byteLength(line, "utf8") <= maxLineBytes) return line;

	const fields: TextField[] = ["task", "outputPreview", "error"];
	let budget = maxLineBytes;
	for (let pass = 0; pass < 12; pass++) {
		for (const field of fields) {
			const value = candidate[field];
			if (typeof value !== "string") continue;
			candidate[field] = truncateUtf8(value, Math.max(0, Math.floor(budget / fields.length)));
		}
		line = JSON.stringify(candidate);
		if (Buffer.byteLength(line, "utf8") <= maxLineBytes) return line;
		budget = Math.floor(budget * 0.6);
	}

	// Last resort: drop the variable text fields. A fixed field can still be
	// huge, so refuse the write when the line stays over the cap.
	delete candidate.task;
	delete candidate.outputPreview;
	delete candidate.error;
	line = JSON.stringify(candidate);
	if (Buffer.byteLength(line, "utf8") > maxLineBytes) return "";
	return line;
}

/**
 * Append one event as a single JSON line. Best-effort: an I/O error is
 * swallowed so a lost record never breaks the caller.
 */
export function appendEvent(logPath: string, event: RunEvent): void {
	try {
		const fitted = fitEventLine(event);
		if (fitted.length === 0) return;
		const line = `${fitted}\n`;
		const fd = openSync(logPath, "a");
		try {
			writeSync(fd, line);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Best-effort only. A lost record must not break a spawn or the TUI.
	}
}

/** True when a parsed JSON value has the minimal shape of a `RunEvent`. */
function isRunEvent(value: unknown): value is RunEvent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.runId === "string" &&
		typeof record.type === "string" &&
		typeof record.status === "string"
	);
}

/**
 * Parse every record in the file with no read cap. Malformed lines are skipped
 * silently and a missing file returns an empty list. `compactLog` uses this so
 * it never drops a live run that sits outside the capped read window.
 */
function readAllEventsRaw(logPath: string): RunEvent[] {
	let raw: string;
	try {
		raw = readFileSync(logPath, "utf8");
	} catch {
		return [];
	}

	const events: RunEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRunEvent(parsed)) events.push(parsed);
		} catch {
			// Skip a malformed line. A partial append must not poison the reader.
		}
	}
	return events;
}

/**
 * Read the last events from the log. Malformed lines are skipped silently.
 * A missing file returns an empty list. The result is capped at
 * `min(max ?? MAX_EVENTS_READ, MAX_EVENTS_READ)`.
 */
export function readEvents(logPath: string, max?: number): RunEvent[] {
	const events = readAllEventsRaw(logPath);
	const limit = Math.min(max ?? MAX_EVENTS_READ, MAX_EVENTS_READ);
	if (limit <= 0) return [];
	return events.slice(-limit);
}

let rootPathCounter = 0;

/** A unique log path under `os.tmpdir()`, one per root process. */
export function createRootLogPath(): string {
	rootPathCounter += 1;
	const rand = Math.random().toString(36).slice(2, 10);
	return join(tmpdir(), `pi-agent-tree-${process.pid}-${rootPathCounter}-${rand}`);
}

/**
 * Root-only compaction. Keeps events whose run is live plus the most recent
 * bounded tail, writes a temp file, then renames it over the original.
 * Best-effort: never throws.
 */
export function compactLog(logPath: string, keepRunIds: Set<string> | string[]): void {
	try {
		const keep = keepRunIds instanceof Set ? keepRunIds : new Set(keepRunIds);
		// Uncapped parse: a live run must survive even when its records fall
		// outside the 2000-record read window.
		const events = readAllEventsRaw(logPath);
		if (events.length === 0) return;

		const keepIndexes = new Set<number>();
		events.forEach((event, index) => {
			if (keep.has(event.runId)) keepIndexes.add(index);
		});
		for (let index = Math.max(0, events.length - COMPACT_TAIL); index < events.length; index++) {
			keepIndexes.add(index);
		}

		const text = events
			.filter((_event, index) => keepIndexes.has(index))
			.map((event) => JSON.stringify(event))
			.join("\n");
		const tempPath = `${logPath}.compact-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			writeFileSync(tempPath, `${text}\n`, "utf8");
			renameSync(tempPath, logPath);
		} catch {
			// Leaving the original file in place is safe.
			try {
				unlinkSync(tempPath);
			} catch {
				// The temp file may not exist.
			}
		}
	} catch {
		// Best-effort only.
	}
}
