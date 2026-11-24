#!/usr/bin/env node
// session-log — paths and reads for the per-session logs.
//
//   <project notes>/session-logs/<YYYY-MM-DD>/<HHMM>-<session id>.md
//
// One file per Claude Code session, so parallel sessions never write the same
// file. A second wrap-up of a session rewrites its own file.
//
// CLI:
//   node session-log.mjs path --session=<id> [--cwd=<dir>]
//       Print this session's entry path: its existing entry from today or
//       yesterday, else a new path for now. Creates the day folder.
//   node session-log.mjs read [--days=<n>] [--cwd=<dir>]
//       Print the entries of the last n day folders (default 3), oldest first.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectDir } from "./notes-paths.mjs";

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export function dayOf(date) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A file-name-safe session id. */
export function safeSession(id) {
	return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

// The folder names, copied from platforms/shared/notes/folders.ts because the
// wrap-up skill runs this file with plain node (no type stripping); a test
// keeps the two equal. The legacy `journal/` folder is read for one release.
export const SESSION_LOGS = "session-logs";
export const LEGACY_SESSION_LOGS = "journal";

/** Where session logs are written. */
export const sessionLogsDir = (notesDir) => join(notesDir, SESSION_LOGS);
const sessionLogDirs = (notesDir) => [sessionLogsDir(notesDir), join(notesDir, LEGACY_SESSION_LOGS)];

/** The existing entry of a session in the given day folders, current folder first, or "". */
export function findEntry(notesDir, session, days, dirs = sessionLogDirs(notesDir)) {
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
export function entryPath(notesDir, session, now = new Date()) {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	// Only the current folder is rewritten; a legacy entry stays as it was.
	const existing = findEntry(notesDir, session, [dayOf(now), dayOf(yesterday)], [sessionLogsDir(notesDir)]);
	if (existing) return existing;
	return join(sessionLogsDir(notesDir), dayOf(now), `${pad(now.getHours())}${pad(now.getMinutes())}-${safeSession(session)}.md`);
}

/** The entry files of the last `days` days with entries, across both folders, oldest first. */
export function recentEntries(notesDir, days = 3) {
	const byDay = new Map();
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
		.flatMap((day) => byDay.get(day).sort((a, b) => basename(a).localeCompare(basename(b))));
}

function option(name) {
	const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const command = process.argv[2];
	const notesDir = projectDir(option("cwd") ?? process.cwd(), option("home"));
	if (command === "path") {
		const session = option("session");
		if (!session) {
			process.stderr.write("session-log: path needs --session=<id>\n");
			process.exit(2);
		}
		const path = entryPath(notesDir, session);
		mkdirSync(join(path, ".."), { recursive: true });
		process.stdout.write(`${path}\n`);
	} else if (command === "read") {
		const days = Number(option("days") ?? 3);
		for (const file of recentEntries(notesDir, Number.isInteger(days) && days > 0 ? days : 3)) {
			process.stdout.write(`\n<!-- ${file} -->\n${readFileSync(file, "utf8").trim()}\n`);
		}
	} else {
		process.stderr.write("usage: session-log.mjs path --session=<id> | read [--days=<n>]\n");
		process.exit(2);
	}
}
