/**
 * Journal paths and reads for the Pi adapter.
 *
 *   <project notes>/journal/<YYYY-MM-DD>/<HHMM>-<session id>.md
 *
 * One file per Pi session, so parallel sessions never write the same file. A
 * second wrap-up of a session rewrites its own file. The same layout as the
 * Claude adapter, so both harnesses write one journal.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** The journal folder of a project notes folder. */
export const journalDir = (notesDir: string): string => join(notesDir, "journal");

/** The existing entry of a session in the given day folders, or "". */
export function findEntry(notesDir: string, session: string, days: string[]): string {
	const suffix = `-${safeSession(session)}.md`;
	for (const day of days) {
		const dir = join(journalDir(notesDir), day);
		if (!existsSync(dir)) continue;
		const hit = readdirSync(dir).find((name) => name.endsWith(suffix));
		if (hit) return join(dir, hit);
	}
	return "";
}

/** The entry path for a session: its entry from today or yesterday, else a new path for `now`. */
export function entryPath(notesDir: string, session: string, now: Date = new Date()): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	const existing = findEntry(notesDir, session, [dayOf(now), dayOf(yesterday)]);
	if (existing) return existing;
	return join(journalDir(notesDir), dayOf(now), `${pad(now.getHours())}${pad(now.getMinutes())}-${safeSession(session)}.md`);
}

/** The entry files of the last `days` day folders, oldest first. */
export function recentEntries(notesDir: string, days = 3): string[] {
	const root = journalDir(notesDir);
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => DAY_FOLDER.test(name) && statSync(join(root, name)).isDirectory())
		.sort()
		.slice(-days)
		.flatMap((day) =>
			readdirSync(join(root, day))
				.filter((name) => name.endsWith(".md"))
				.sort()
				.map((name) => join(root, day, name)),
		);
}

/** The journal text of the last `days` days, oldest first, each with its path. */
export function recentJournal(notesDir: string, days = 3): { path: string; text: string }[] {
	return recentEntries(notesDir, days).map((path) => ({ path, text: readFileSync(path, "utf8").trim() }));
}
