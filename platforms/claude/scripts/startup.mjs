#!/usr/bin/env node
// startup — Claude Code SessionStart hook (startup, clear) for the companion.
//
// It sends the companion its startup read list as additional context: the
// project notes folder, the project rules and summary, the last three session-log
// days, the open task notes, and the unfinished studies. It sends paths and
// short facts, not file contents, so the text stays far under the 10,000-
// character hook cap; the companion reads the files itself.
//
// Any other agent, or a session without one, gets no output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startupContext as sharedStartupContext } from "../../shared/notes/notes.ts";
import { projectDir, projectName } from "./notes-paths.mjs";

const AGENT_TYPE = "companion-agents:companion";

/**
 * The startup context text for a working directory.
 *
 * The text lives in the shared notes module; the Claude adapter passes no
 * session id, because the context hook prints it on every session source.
 */
export function startupContext(cwd, home) {
	return sharedStartupContext(projectDir(cwd, home), projectName(cwd));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const input = JSON.parse(readFileSync(0, "utf8"));
	if (input.agent_type !== AGENT_TYPE) process.exit(0);
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	// The test seam: a `--home=<path>` hook argument, which a settings env block cannot set.
	const homeArg = process.argv.find((value) => value.startsWith("--home="))?.slice("--home=".length);
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: startupContext(cwd, homeArg) },
		}),
	);
}
