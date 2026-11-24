/**
 * The session-log path and read CLI for the Kiro adapter.
 *
 *   node session-log.ts path --session=<id> [--cwd=<dir>] [--home=<dir>]
 *       Print this session's entry path: its existing entry from today or
 *       yesterday, else a new path for now. Creates the day folder.
 *   node session-log.ts read [--days=<n>] [--cwd=<dir>] [--home=<dir>]
 *       Print the entries of the last n day folders (default 3), oldest first.
 *
 * The project notes layout is the one every adapter writes:
 * `<home>/agent-notes/project-notes/<project>/session-logs/<day>/<HHMM>-<session>.md`.
 * The wrap-up skill's Kiro reference calls this; the SessionEnd safety net uses
 * the same shared entry-path function.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { entryPath, recentSessionLogs } from "../../shared/notes/session-log.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import { option } from "../../shared/argv.ts";

/** This session's entry path for a working directory and home folder. */
export function sessionLogPath(cwd: string, home: string, sessionId: string, now: Date = new Date()): string {
	return entryPath(projectDir(cwd, home), sessionId, now);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const command = process.argv[2];
	const cwd = option("cwd", process.argv) ?? process.cwd();
	const home = option("home", process.argv) ?? homedir();
	const notesDir = projectDir(cwd, home);
	if (command === "path") {
		const session = option("session", process.argv);
		if (!session) {
			process.stderr.write("session-log: path needs --session=<id>\n");
			process.exit(2);
		}
		const file = entryPath(notesDir, session);
		mkdirSync(dirname(file), { recursive: true });
		process.stdout.write(`${file}\n`);
	} else if (command === "read") {
		const days = Number(option("days", process.argv) ?? 3);
		for (const entry of recentSessionLogs(notesDir, Number.isInteger(days) && days > 0 ? days : 3)) {
			process.stdout.write(`\n<!-- ${entry.path} -->\n${entry.text}\n`);
		}
	} else {
		process.stderr.write("usage: session-log.ts path --session=<id> | read [--days=<n>]\n");
		process.exit(2);
	}
}
