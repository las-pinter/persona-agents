/**
 * The Stop hook that records a reviewer's verdict against the change it
 * reviewed.
 *
 * Kiro records a sub-agent run as `sub_agent_start` / `sub_agent_complete`
 * payloads in the parent session, not as a tool call, and it fires no
 * PostToolUse hook for it. The Stop hook runs after the turn, reads the parent
 * session, and pairs each pa-reviewer run with its brief:
 *
 *   - the change key is the `Change key: <16 hex>` line in the brief the
 *     companion passed to the reviewer;
 *   - the verdict is the reviewer's `## Verdict` line.
 *
 * The record is written to the adapter's review store, keyed by the change key,
 * so the commit gate can allow a commit of that exact change without a prompt.
 * A run with no key or no verdict records nothing; the commit then asks.
 *
 * Nothing is written to stdout: a Stop hook's output is added to the context,
 * and a recording must be silent.
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseVerdict } from "../../shared/review/review.ts";
import { readSession, DEFAULT_REVIEWER } from "./session-store.ts";
import { kiroHome as resolveKiroHome, stateDir as stateDirOf } from "./paths.ts";
import { readReviews, recordReview } from "./state.ts";

/** One recorded verdict. */
export interface RecordedReview {
	key: string;
	verdict: string;
	subSession: string;
}

/** The key in a reviewer brief, or "". */
export function keyOfPrompt(prompt: string): string {
	const match = /Change key:\s*([0-9a-f]{16})\b/.exec(prompt);
	return match ? match[1] : "";
}

/**
 * Record every pa-reviewer run in a session that has not been recorded yet.
 *
 * The run carries the key from its prompt, or, when the model passed only part
 * of the printed brief, from the brief text in the transcript before the run.
 *
 * A run that already has a record for the same key and sub-session is skipped,
 * so the Stop hook can run after every turn. A re-review of the same change
 * has a different sub-session and replaces the earlier verdict.
 */
export function recordSessionReviews(
	kiroHome: string,
	sessionId: string,
	stateDir: string,
	options: { reviewer?: string; now?: Date } = {},
): RecordedReview[] {
	const reviewer = options.reviewer ?? DEFAULT_REVIEWER;
	const session = readSession(kiroHome, sessionId);
	if (!session) return [];
	const stored = readReviews(stateDir);
	const at = (options.now ?? new Date()).toISOString();
	const recorded: RecordedReview[] = [];
	for (const run of session.subAgents) {
		if (run.agent !== reviewer || run.status !== "success") continue;
		const key = run.key || keyOfPrompt(run.prompt);
		if (!key) continue;
		const verdict = parseVerdict(run.response);
		if (!verdict) continue;
		if (stored.reviews[key]?.subSession === run.subSessionId) continue;
		const record = { verdict, at, session: sessionId, subSession: run.subSessionId };
		recordReview(stateDir, key, record);
		// The scan can cover several runs of one key; the newest wins in this
		// scan too, or a later scan would re-record an older verdict.
		stored.reviews[key] = record;
		recorded.push({ key, verdict, subSession: run.subSessionId });
	}
	return recorded;
}

function option(name: string, argv: string[]): string | undefined {
	const arg = argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: unknown };
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	if (sessionId) {
		const home = option("home", process.argv) ?? homedir();
		const kiro = option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home);
		recordSessionReviews(kiro, sessionId, stateDirOf(kiro));
	}
}
