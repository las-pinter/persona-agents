/**
 * Session-log paths and reads for the adapters.
 *
 *   <project notes>/session-logs/<YYYY-MM-DD>/<HHMM>-<session id>.md
 *
 * One file per agent session, so parallel sessions never write the same file.
 * A second wrap-up of a session rewrites its own file. Reads also cover the
 * legacy `journal/` folder for one release (see `folders.ts`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { sessionLogDirs, sessionLogsDir } from "./folders.ts";

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number): string => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export function dayOf(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A file-name-safe session id. */
export function safeSession(id: string): string {
	return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The existing entry of a session in the given day folders, current folder first, or "". */
export function findEntry(notesDir: string, session: string, days: string[], dirs: string[] = sessionLogDirs(notesDir)): string {
	const suffix = `-${safeSession(session)}.md`;
	for (const root of dirs) {
		for (const day of days) {
			const dir = join(root, day);
			if (!existsSync(dir)) continue;
			const hit = readdirSync(dir).find((name) => name.endsWith(suffix));
			if (hit) return join(dir, hit);
		}
	}
	return "";
}

/** The entry path for a session: its entry from today or yesterday, else a new path for `now`. */
export function entryPath(notesDir: string, session: string, now: Date = new Date()): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	// Only the current folder is rewritten; a legacy entry stays as it was.
	const existing = findEntry(notesDir, session, [dayOf(now), dayOf(yesterday)], [sessionLogsDir(notesDir)]);
	if (existing) return existing;
	return join(sessionLogsDir(notesDir), dayOf(now), `${pad(now.getHours())}${pad(now.getMinutes())}-${safeSession(session)}.md`);
}

/** The entry files of the last `days` days with entries, across both folders, oldest first. */
export function recentEntries(notesDir: string, days = 3): string[] {
	const byDay = new Map<string, string[]>();
	for (const root of sessionLogDirs(notesDir)) {
		if (!existsSync(root)) continue;
		for (const day of readdirSync(root)) {
			if (!DAY_FOLDER.test(day) || !statSync(join(root, day)).isDirectory()) continue;
			const files = readdirSync(join(root, day))
				.filter((name) => name.endsWith(".md"))
				.map((name) => join(root, day, name));
			byDay.set(day, [...(byDay.get(day) ?? []), ...files]);
		}
	}
	return [...byDay.keys()]
		.sort()
		.slice(-days)
		.flatMap((day) => (byDay.get(day) ?? []).sort((a, b) => basename(a).localeCompare(basename(b))));
}

/** The session-log text of the last `days` days, oldest first, each with its path. */
export function recentSessionLogs(notesDir: string, days = 3): { path: string; text: string }[] {
	return recentEntries(notesDir, days).map((path) => ({ path, text: readFileSync(path, "utf8").trim() }));
}
