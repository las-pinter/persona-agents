#!/usr/bin/env node
// session-log — paths and reads for the per-session logs.
//
//   <project notes>/session-logs/<YYYY-MM-DD>/<HHMM>-<session id>.md
//
// One file per Claude Code session, so parallel sessions never write the same
// file. A second wrap-up of a session rewrites its own file. The logic lives
// in platforms/shared/notes/session-log.ts; this file is the Claude Code CLI.
// It imports TypeScript, so run it with --experimental-strip-types.
//
// CLI:
//   node --experimental-strip-types session-log.mjs path --session=<id> [--cwd=<dir>]
//       Print this session's entry path: its existing entry from today or
//       yesterday, else a new path for now. Creates the day folder.
//   node --experimental-strip-types session-log.mjs read [--days=<n>] [--session=<id>] [--cwd=<dir>]
//       Print the entries of the last n day folders (default 3), oldest first.
//
// The project is that of --cwd; without it, that of the folder the session
// started in (the first cwd of its transcript under the Claude config folder),
// else that of the shell's folder. A `cd` moves the shell, so --session alone
// is the stable form.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "../../shared/argv.ts";
import { entryPath, recentEntries } from "../../shared/notes/session-log.ts";
import { projectDir } from "./notes-paths.mjs";
import { userConfigDir } from "./plugin-options.mjs";
import { findTranscript, startDir } from "./transcript.ts";

export { dayOf, entryPath, findEntry, recentEntries, safeSession } from "../../shared/notes/session-log.ts";
export { SESSION_LOGS, sessionLogsDir } from "../../shared/notes/folders.ts";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const argv = process.argv;
	const command = argv[2];
	// The project comes from --cwd, else from the folder the session started in
	// (a `cd` moves the shell), else from the shell's folder.
	const session = option("session", argv);
	const cwd = option("cwd", argv) ?? (session ? startDir(findTranscript(userConfigDir(), session), process.cwd()) : process.cwd());
	const notesDir = projectDir(cwd, option("home", argv));
	if (command === "path") {
		if (!session) {
			process.stderr.write("session-log: path needs --session=<id>\n");
			process.exit(2);
		}
		const path = entryPath(notesDir, session);
		mkdirSync(join(path, ".."), { recursive: true });
		process.stdout.write(`${path}\n`);
	} else if (command === "read") {
		const days = Number(option("days", argv) ?? 3);
		for (const file of recentEntries(notesDir, Number.isInteger(days) && days > 0 ? days : 3)) {
			process.stdout.write(`\n<!-- ${file} -->\n${readFileSync(file, "utf8").trim()}\n`);
		}
	} else {
		process.stderr.write("usage: session-log.mjs path --session=<id> [--cwd=<dir>] | read [--days=<n>] [--session=<id>] [--cwd=<dir>]\n");
		process.exit(2);
	}
}
