#!/usr/bin/env node
// journal-end — the journal safety net for a companion session that ends
// without a wrap-up.
//
//   journal-end.mjs hook             SessionEnd hook: when this session has no
//                                    journal entry, save a payload and start
//                                    the writer as a detached process. Returns
//                                    at once (the SessionEnd budget is short).
//   journal-end.mjs write <payload>  The detached writer: build the source
//                                    text, run a small headless model, and
//                                    write the entry if it is still missing.
//
// The source text is the session notes the session wrote, the compaction
// summaries that compact.mjs kept, and the tail of the transcript after the
// last compaction. The writer session runs no agent and no tools, so the
// plugin hooks do nothing in it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readTranscript, stateDir } from "./compact.mjs";
import { entryPath, findEntry, dayOf } from "./journal.mjs";
import { projectDir } from "./notes-paths.mjs";

const AGENT_TYPE = "persona-agents:companion";
const WRITER_MODEL = "haiku";
const WRITER_TIMEOUT_MS = 180_000;
const CAP_NOTES = 8_000;
const CAP_SUMMARIES = 20_000;
const CAP_TAIL = 20_000;

/** The last `max` characters of a text, marked when cut. */
const tail = (text, max) => (text.length <= max ? text : `[...cut...]\n${text.slice(-max)}`);

/** Session notes files the session wrote, in first-write order. */
export function writtenSessionNotes(entries, notesDir) {
	const prefix = join(notesDir, "sessions") + sep;
	const paths = [];
	for (const entry of entries) {
		if (entry.isSidechain || entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
		for (const block of entry.message.content) {
			const path = block?.type === "tool_use" && ["Write", "Edit", "MultiEdit"].includes(block.name) ? block.input?.file_path : null;
			if (typeof path === "string" && path.startsWith(prefix) && !paths.includes(path)) paths.push(path);
		}
	}
	return paths;
}

/** The user and assistant text after the last compaction, as "role: text" lines. */
export function conversationTail(entries) {
	let start = 0;
	entries.forEach((entry, index) => {
		if (entry.type === "system" && entry.subtype === "compact_boundary") start = index + 1;
	});
	const lines = [];
	for (const entry of entries.slice(start)) {
		if (entry.isSidechain || entry.isMeta || (entry.type !== "user" && entry.type !== "assistant")) continue;
		const content = entry.message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
					: "";
		if (text.trim() && !text.startsWith("<")) lines.push(`${entry.type}: ${text.trim()}`);
	}
	return lines.join("\n\n");
}

/** The prompt for the writer model. */
export function writerPrompt(payload, sources) {
	return [
		"Write a short journal entry for a finished Claude Code work session, from the material below.",
		"Output only the entry, in this markdown format, at most 30 lines, plain and factual, no persona voice:",
		"",
		`# ${payload.day} ${payload.time} — <short title of the session>`,
		"",
		`- **Session:** ${payload.session}`,
		`- **Session notes:** ${sources.notes.length ? sources.notes.map((n) => n.path).join(", ") : "none"}`,
		"- **Written by:** the session-end safety net (no wrap-up)",
		"",
		"## Done",
		"## Decisions",
		"## Open",
		"",
		"Use '- none' for an empty section. Name commits, files, and studies when the material names them.",
		"",
		...sources.notes.map((n) => `=== SESSION NOTES ${n.path} ===\n${n.text}`),
		sources.summaries ? `=== COMPACTION SUMMARIES ===\n${sources.summaries}` : "",
		sources.tail ? `=== CONVERSATION AFTER THE LAST COMPACTION ===\n${sources.tail}` : "",
	].join("\n");
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
	const payloadFile = join(dir, `journal-${String(input.session_id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
	writeFileSync(
		payloadFile,
		JSON.stringify({ session: input.session_id, transcript: input.transcript_path, notesDir, reason: input.reason, at: now.toISOString() }),
	);
	// The writer imports compact.mjs, which imports the shared TypeScript
	// notes parser; the flag must travel to the child, which inherits no exec args.
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
		env: { ...process.env, PERSONA_AGENTS_JOURNAL_WRITER: "1" },
	});
	child.unref();
}

function write(payloadFile, command = "claude") {
	const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
	try {
		const at = new Date(payload.at);
		const path = entryPath(payload.notesDir, payload.session, at);
		if (existsSync(path)) return;
		const entries = readTranscript(payload.transcript);
		const notes = writtenSessionNotes(entries, payload.notesDir)
			.filter((path) => existsSync(path))
			.map((path) => ({ path, text: tail(readFileSync(path, "utf8"), CAP_NOTES) }));
		const summariesFile = join(dirname(payloadFile), `${String(payload.session).replace(/[^A-Za-z0-9_-]/g, "_")}.summaries.md`);
		const summaries = existsSync(summariesFile) ? tail(readFileSync(summariesFile, "utf8"), CAP_SUMMARIES) : "";
		const convo = tail(conversationTail(entries), CAP_TAIL);
		if (!notes.length && !summaries && !convo) return;
		const pad = (n) => String(n).padStart(2, "0");
		const prompt = writerPrompt(
			{ ...payload, day: dayOf(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
			{ notes, summaries, tail: convo },
		);
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
		if (input.agent_type === AGENT_TYPE && input.session_id && !process.env.PERSONA_AGENTS_JOURNAL_WRITER) hook(input, claudeArg);
	} else if (mode === "write" && process.argv[3]) {
		// The test seam: `--claude=<path>` replaces the claude binary. The hook never passes it,
		// and an argument, unlike an env var, cannot come from a project settings env block.
		write(process.argv[3], process.argv.find((value) => value.startsWith("--claude="))?.slice("--claude=".length));
	}
}
