/**
 * The Kiro adapter's small state files under `<payload>/state/`.
 *
 *   reviews.json       one record per reviewed change, keyed by the change key
 *   decisions.ndjson   one line per gate decision that asked or denied (and
 *                      every allow when COMPANION_AGENTS_DEBUG is set)
 *
 * The review record is what the commit gate reads: a review covers the exact
 * change it reviewed, and an edit after it changes the key. The records are
 * written by the Stop hook from a reviewer sub-agent run (see review-record.ts)
 * and read by the gate at commit time.
 *
 * Writes are atomic: a temp file in the same folder, then a rename.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One stored review. */
export interface ReviewRecord {
	verdict: string;
	at: string;
	/** The session that ran the review. */
	session?: string;
	/** The sub-agent execution id, so a Stop scan records a run once. */
	subSession?: string;
	/** The changed paths the review covered. */
	files?: string[];
}

/** The review store. */
export interface ReviewState {
	version: 1;
	reviews: Record<string, ReviewRecord>;
}

/** One gate decision line. */
export interface DecisionRecord {
	at: string;
	session?: string;
	agent: string;
	tool: string;
	verdict: string;
	reason: string;
	command?: string;
}

/** The review store file. */
export const reviewsFile = (stateDir: string): string => join(stateDir, "reviews.json");

/** The decisions log file. */
export const decisionsFile = (stateDir: string): string => join(stateDir, "decisions.ndjson");

/** The review store, or an empty one when the file is missing or bad. */
export function readReviews(stateDir: string): ReviewState {
	const file = reviewsFile(stateDir);
	if (!existsSync(file)) return { version: 1, reviews: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ReviewState>;
		if (parsed?.version !== 1 || !parsed.reviews || typeof parsed.reviews !== "object" || Array.isArray(parsed.reviews)) {
			return { version: 1, reviews: {} };
		}
		return { version: 1, reviews: parsed.reviews as Record<string, ReviewRecord> };
	} catch {
		return { version: 1, reviews: {} };
	}
}

/** The review for one change key, or null. */
export function reviewFor(stateDir: string, key: string): ReviewRecord | null {
	const record = readReviews(stateDir).reviews[key];
	return record && typeof record === "object" && typeof record.verdict === "string" ? record : null;
}

/** Store a review for one change key, replacing an earlier record for it. */
export function recordReview(stateDir: string, key: string, record: ReviewRecord): void {
	mkdirSync(stateDir, { recursive: true });
	const state = readReviews(stateDir);
	state.reviews[key] = record;
	const file = reviewsFile(stateDir);
	const temp = `${file}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temp, file);
}

/** Append one decision line; a log failure never blocks a tool call. */
export function appendDecision(stateDir: string, record: DecisionRecord): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		appendFileSync(decisionsFile(stateDir), `${JSON.stringify(record)}\n`);
	} catch {
		// The log is evidence, not a gate.
	}
}
