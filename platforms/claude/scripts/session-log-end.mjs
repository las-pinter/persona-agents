#!/usr/bin/env node
// session-log-end — the session-log safety net for a companion session that
// ends without a wrap-up.
//
//   session-log-end.mjs hook             SessionEnd hook: when this session has
//                                        no session log, save a payload and start
//                                    the writer as a detached process. Returns
//                                    at once (the SessionEnd budget is short).
//   session-log-end.mjs write <payload>  The detached writer: build the source
//                                    text, run a small headless model, and
//                                    write the entry if it is still missing.
//
// The source text is the task notes the session wrote, the compaction
// summaries that compact.mjs kept, and the tail of the transcript after the
// last compaction. The writer session runs no agent and no tools, so the
// plugin hooks do nothing in it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./compact.mjs";
import {
	CAP_SUMMARIES,
	conversationTail as sharedConversationTail,
	hasMaterial,
	tail,
	writerPrompt,
	writtenTaskNotes as sharedWrittenTaskNotes,
	CAP_NOTES,
	CAP_TAIL,
} from "../../shared/notes/session-log-net.ts";
import { dayOf, entryPath, findEntry, safeSession } from "../../shared/notes/session-log.ts";
import { projectDir } from "./notes-paths.mjs";
import { readTranscript, toEntries } from "./transcript.ts";

export { writerPrompt };

const AGENT_TYPE = "companion-agents:companion";
const WRITER_MODEL = "haiku";
const WRITER_TIMEOUT_MS = 180_000;

/** Task notes files the session wrote, in first-write order. */
export function writtenTaskNotes(entries, notesDir) {
	return sharedWrittenTaskNotes(toEntries(entries), notesDir);
}

/** The user and assistant text after the last compaction, as "role: text" lines. */
export function conversationTail(entries) {
	return sharedConversationTail(toEntries(entries));
}

function hook(input, claudeArg) {
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const notesDir = projectDir(cwd, homeArg());
	const now = new Date();
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (findEntry(notesDir, input.session_id, [dayOf(now), dayOf(yesterday)])) return;
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const payloadFile = join(dir, `session-log-${safeSession(input.session_id)}.json`);
	writeFileSync(
		payloadFile,
		JSON.stringify({ session: input.session_id, transcript: input.transcript_path, notesDir, reason: input.reason, at: now.toISOString() }),
	);
	// The writer imports the shared TypeScript modules; the flag must travel
	// to the child, which inherits no exec args.
	const args = [
		"--experimental-strip-types",
		"--no-warnings",
		fileURLToPath(import.meta.url),
		"write",
		payloadFile,
		...(claudeArg ? [claudeArg] : []),
	];
	const child = spawn(process.execPath, args, {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, COMPANION_AGENTS_SESSION_LOG_WRITER: "1" },
	});
	child.unref();
}

function write(payloadFile, command = "claude") {
	try {
		// Parsed inside the try, so a truncated payload is still removed.
		const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
		const at = new Date(payload.at);
		const path = entryPath(payload.notesDir, payload.session, at);
		if (existsSync(path)) return;
		const entries = readTranscript(payload.transcript);
		const notes = writtenTaskNotes(entries, payload.notesDir)
			.filter((path) => existsSync(path))
			.map((path) => ({ path, text: tail(readFileSync(path, "utf8"), CAP_NOTES) }));
		const summariesFile = join(dirname(payloadFile), `${safeSession(payload.session)}.summaries.md`);
		const summaries = existsSync(summariesFile) ? tail(readFileSync(summariesFile, "utf8"), CAP_SUMMARIES) : "";
		const material = { notes, summaries, tail: tail(conversationTail(entries), CAP_TAIL) };
		if (!hasMaterial(material)) return;
		const prompt = writerPrompt(payload, material);
		const run = spawnSync(
			command,
			["-p", "--model", WRITER_MODEL, "--tools", "", "--no-session-persistence", "--output-format", "text"],
			{ input: prompt, encoding: "utf8", timeout: WRITER_TIMEOUT_MS, cwd: tmpdir() },
		);
		const entry = (run.stdout ?? "").trim();
		if (run.status !== 0 || !entry.startsWith("#")) return;
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) writeFileSync(path, `${entry}\n`);
	} finally {
		rmSync(payloadFile, { force: true });
	}
}

/** The test seam: a `--home=<path>` hook argument, which a settings env block cannot set. */
function homeArg() {
	return process.argv.find((value) => value.startsWith("--home="))?.slice("--home=".length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2];
	if (mode === "hook") {
		const input = JSON.parse(readFileSync(0, "utf8"));
		const claudeArg = process.argv.find((value) => value.startsWith("--claude="));
		if (input.agent_type === AGENT_TYPE && input.session_id && !process.env.COMPANION_AGENTS_SESSION_LOG_WRITER) hook(input, claudeArg);
	} else if (mode === "write" && process.argv[3]) {
		// The test seam: `--claude=<path>` replaces the claude binary. The hook never passes it,
		// and an argument, unlike an env var, cannot come from a project settings env block.
		write(process.argv[3], process.argv.find((value) => value.startsWith("--claude="))?.slice("--claude=".length));
	}
}
