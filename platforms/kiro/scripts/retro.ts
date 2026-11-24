/**
 * The Kiro facts for `/retro`.
 *
 *   node retro.ts --session=<id> [--cwd=<dir>] [--home=<dir>] [--kiro-home=<dir>]
 *
 * The retro is print-only: this script writes nothing. It gathers what the
 * session actually did — the tool calls, the changed files, the denials, the
 * reviews, the compactions, the credits, and the context usage — from the V3
 * session store and the adapter's state files, then prints the shared retro
 * instruction and the facts.
 *
 * A Kiro session log, when one exists, is named but not read: the retro's
 * review scope is the live context plus the notes the model reads itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { dayOf, findEntry } from "../../shared/notes/session-log.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import {
	parseDecisions,
	RETRO_INSTRUCTION,
	sessionDecisions,
	summarizeSession,
} from "../../shared/retro/retro.ts";
import type { EntryLike } from "../../shared/compaction/manifest.ts";
import { kiroHome as resolveKiroHome, stateDir as stateDirOf } from "./paths.ts";
import { decisionsFile } from "./state.ts";
import { metricsFile, summariesFile } from "./compact.ts";
import { readSession } from "./session-store.ts";
import { option } from "./argv.ts";

/** The facts and the instruction a Kiro retro run gets. */
export interface RetroFacts {
	instruction: string;
	facts: string;
}

/** The compaction count recorded in the adapter's metrics file. */
export function compactionCount(stateDir: string, session: string): number {
	try {
		return readFileSync(metricsFile(stateDir), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.filter((line) => {
				try {
					return (JSON.parse(line) as { session?: string }).session === session;
				} catch {
					return false;
				}
			}).length;
	} catch {
		return 0;
	}
}

/** The decisions log lines for this session. */
function decisionsFor(stateDir: string, session: string) {
	try {
		return sessionDecisions(parseDecisions(readFileSync(decisionsFile(stateDir), "utf8")), session);
	} catch {
		return [];
	}
}

/** The session log path of a session, when it has one. */
function sessionLogOf(notesDir: string, session: string, now: Date): string[] {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	const file = findEntry(notesDir, session, [dayOf(now), dayOf(yesterday)]);
	return file ? [file] : [];
}

/** The facts for one session, or null when the store does not hold it. */
export function retroFacts(
	kiroHome: string,
	sessionId: string,
	options: { cwd: string; home: string; notesDir?: string; now?: Date },
): RetroFacts | null {
	const session = readSession(kiroHome, sessionId);
	if (!session) return null;
	const stateDir = stateDirOf(kiroHome);
	const notesDir = options.notesDir ?? projectDir(options.cwd, options.home);
	const now = options.now ?? new Date();
	const compactions = compactionCount(stateDir, sessionId);
	const entries: EntryLike[] = [...session.entries, ...Array.from({ length: compactions }, () => ({ type: "compaction" }))];
	const facts = summarizeSession({
		entries,
		decisions: decisionsFor(stateDir, sessionId),
		sessionLogs: sessionLogOf(notesDir, sessionId, now),
	});
	const extras: string[] = [];
	if (session.contextUsage !== null) extras.push(`- context usage: ${session.contextUsage}%`);
	if (session.credits) {
		extras.push(`- credits: main ${session.credits.main}, delegated ${session.credits.delegated}, auxiliary ${session.credits.auxiliary}`);
	}
	if (session.subAgents.length > 0) {
		const reviewers = session.subAgents.filter((run) => run.agent === "pa-reviewer").length;
		extras.push(`- sub-agent runs: ${session.subAgents.length} (reviewer ${reviewers})`);
	}
	if (session.hooks.length > 0) {
		const counts = new Map<string, number>();
		for (const hook of session.hooks) counts.set(hook, (counts.get(hook) ?? 0) + 1);
		extras.push(
			`- hook calls: ${[...counts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([name, count]) => `${name} ×${count}`)
				.join(", ")}`,
		);
	}
	const summaries = summariesFile(stateDir, sessionId);
	if (existsSync(summaries)) extras.push(`- compaction summaries: ${summaries}`);
	if (session.meta?.modelId) extras.push(`- model: ${session.meta.modelId}`);
	const text = [facts, ...(extras.length ? ["", ...extras] : [])].join("\n");
	return { instruction: RETRO_INSTRUCTION, facts: text };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const session = option("session", process.argv);
	if (!session) {
		process.stderr.write("retro: --session=<id> is required\n");
		process.exit(2);
	}
	const home = option("home", process.argv) ?? homedir();
	const kiro = option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home);
	const cwd = option("cwd", process.argv) ?? process.cwd();
	const result = retroFacts(kiro, session, { cwd, home });
	if (!result) {
		process.stderr.write(`retro: the session store has no ${session}\n`);
		process.exit(1);
	}
	process.stdout.write(`${result.instruction}\n\n${result.facts}\n`);
}
