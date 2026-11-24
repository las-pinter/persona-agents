#!/usr/bin/env node
// compact — compaction recovery hooks for the companion.
//
//   compact.mjs pre     PreCompact: scan the transcript, save a reload manifest,
//                       and print instructions for the summary (stdout).
//   compact.mjs post    PostCompact: keep the summary for the session log, and
//                       log one metrics line (task notes and plugin data).
//   compact.mjs reload  SessionStart (compact): send the reload list as
//                       additional context.
//
// The manifest holds the skills the session invoked, the active task notes
// file (the last one the session wrote under <project notes>/tasks/), and
// the reference documents to read again: the project rules and summary, the
// study the task notes link, the pinned documents, and other project notes
// the session read. Working source files are not reloaded.
//
// State lives in $CLAUDE_PLUGIN_DATA/compact/ (a temp folder when unset):
//   <session>.json           the reload manifest
//   <session>.summaries.md   every compact summary of the session
//   metrics.ndjson           one line per compaction, for tuning the threshold
//
// Only the companion (agent_type persona-agents:companion) gets any effect.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, sessionLogDirs, taskDirs } from "../../shared/notes/folders.ts";
import { activeTaskNotes, pinnedDocs, projectRules, studyPath } from "../../shared/notes/notes.ts";
import { projectDir } from "./notes-paths.mjs";

const AGENT_TYPE = "persona-agents:companion";
const MAX_SKILLS = 12;
const MAX_DOCS = 20;

/** The state folder for compaction files. */
export function stateDir(env = process.env) {
	return join(env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "persona-agents"), "compact");
}

/** A file-name-safe form of a session id. */
const safeId = (id) => String(id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");

/** The parsed JSON lines of a transcript; bad lines are skipped. */
export function readTranscript(path) {
	if (!path || !existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

/** The main-chain tool_use blocks of a transcript, in order. */
function toolUses(entries) {
	const uses = [];
	for (const entry of entries) {
		if (entry.isSidechain || entry.type !== "assistant") continue;
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) if (block?.type === "tool_use") uses.push(block);
	}
	return uses;
}

/** The text of an entry's message content, string or blocks. */
function entryText(entry) {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * The skills a session invoked, in order: a `Skill` tool call, or a typed
 * `/persona-agents:<skill>` command, which Claude Code records as user text
 * with a `<command-name>` marker instead of a tool call.
 */
function skillNames(entries) {
	const names = [];
	for (const entry of entries) {
		if (entry.type === "assistant" && !entry.isSidechain && Array.isArray(entry.message?.content)) {
			for (const block of entry.message.content) {
				if (block?.type === "tool_use" && block.name === "Skill" && typeof block.input?.skill === "string") names.push(block.input.skill);
			}
		}
		for (const match of entryText(entry).matchAll(/<command-name>\/persona-agents:([a-z0-9-]+)<\/command-name>/g)) {
			names.push(`persona-agents:${match[1]}`);
		}
	}
	return names;
}

/** Keep the last `max` distinct values, ordered by their last use. */
function lastDistinct(values, max) {
	const seen = new Map();
	values.forEach((value, index) => seen.set(value, index));
	return [...seen.entries()]
		.sort((a, b) => a[1] - b[1])
		.map(([value]) => value)
		.slice(-max);
}

/** The rule files and the summary of a project notes folder. */
function projectStartupDocs(notesDir) {
	const summary = join(notesDir, "summary.md");
	return existsSync(summary) ? [...projectRules(notesDir), summary] : projectRules(notesDir);
}

/**
 * The reload manifest for a transcript and a project notes folder.
 * Docs: project rules and summary, the linked study, the pinned docs, then
 * other project notes the session read (not session logs or other tasks).
 * The active notes file comes from the session id first, so a resumed session
 * that only read its notes still finds them.
 */
export function buildManifest(entries, notesDir, sessionId = "") {
	const uses = toolUses(entries);
	const skills = lastDistinct(skillNames(entries), MAX_SKILLS);
	const tasks = taskDirs(notesDir);
	const written = uses
		.filter((use) => ["Write", "Edit", "MultiEdit"].includes(use.name))
		.map((use) => use.input?.file_path)
		.filter((path) => typeof path === "string" && isInside(tasks, path) && path.endsWith(".md"));
	const taskNotes = activeTaskNotes(notesDir, sessionId, written);
	const notesText = taskNotes && existsSync(taskNotes) ? readFileSync(taskNotes, "utf8") : "";
	const readNotes = uses
		.filter((use) => use.name === "Read" && typeof use.input?.file_path === "string")
		.map((use) => use.input.file_path)
		.filter((path) => path.startsWith(notesDir + sep) && !isInside(sessionLogDirs(notesDir), path) && !isInside(tasks, path));
	const study = studyPath(notesText);
	const docs = lastDistinct(
		[...readNotes, ...projectStartupDocs(notesDir), ...(study ? [study] : []), ...pinnedDocs(notesText)],
		MAX_DOCS,
	).filter((path) => path !== taskNotes);
	return { taskNotes, skills, docs, scan: { entries: entries.length, toolUses: uses.length } };
}

/** The PreCompact stdout: instructions that the summary must follow. */
export function summaryInstructions(manifest) {
	const lines = [
		"Compaction instructions from the persona-agents companion:",
		"- Keep the current task, the current plan step, the open decisions, and the owner's latest request word for word where short.",
		"- Do not paraphrase skill text or project rules; they are reloaded after compaction.",
	];
	if (manifest.taskNotes) {
		lines.push(`- Keep this exact path in the summary: the task notes file ${manifest.taskNotes}`);
	}
	return lines.join("\n");
}

/** The SessionStart (compact) context: what to reload, in order. */
export function reloadContext(manifest) {
	const lines = [
		"# After compaction: reload before you continue",
		"",
		"Do every step below before any other work, even when the summary seems to cover it: the summary is lossy, the files are not.",
		"",
	];
	if (manifest.taskNotes) {
		lines.push(`1. Read the task notes file first; it holds the plan: ${manifest.taskNotes}`);
	} else {
		lines.push("1. No task notes file was found for this session.");
	}
	lines.push("2. Re-invoke these skills with the Skill tool (an unchanged skill costs only a short note):");
	lines.push(...(manifest.skills.length ? manifest.skills.map((skill) => `   - ${skill}`) : ["   - none"]));
	lines.push("3. Re-read these documents in full:");
	lines.push(...(manifest.docs.length ? manifest.docs.map((doc) => `   - ${doc}`) : ["   - none"]));
	lines.push("4. Do not re-read working source files now; read them again when the next step needs them.");
	return lines.join("\n");
}

/** The latest compact_boundary metadata in a transcript, or {}. */
export function lastBoundary(entries) {
	const boundary = entries.findLast((entry) => entry.type === "system" && entry.subtype === "compact_boundary");
	return boundary?.compactMetadata ?? {};
}

/** Append one line to the `## Log` section of a task notes file. */
export function appendLog(path, line) {
	if (!path || !existsSync(path)) return false;
	const text = readFileSync(path, "utf8");
	const entry = `- ${line}`;
	const next = /^##\s+Log\s*$/m.test(text)
		? text.replace(/^(##\s+Log\s*\n)([\s\S]*?)(?=^##\s|(?![\s\S]))/m, (_all, head, body) => `${head}${body.replace(/\s*$/, "\n")}${entry}\n`)
		: `${text.replace(/\s*$/, "\n")}\n## Log\n\n${entry}\n`;
	writeFileSync(path, next);
	return true;
}

/** "YYYY-MM-DD HH:MM" in local time. */
function stamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The test seam: a `--home=<path>` hook argument, which a settings env block cannot set. */
export function homeArg(argv = process.argv) {
	const arg = argv.find((value) => value.startsWith("--home="));
	return arg ? arg.slice("--home=".length) : undefined;
}

function run(mode, input) {
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const id = safeId(input.session_id);
	const manifestFile = join(dir, `${id}.json`);
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const notesDir = projectDir(cwd, homeArg());

	const sessionId = typeof input.session_id === "string" ? input.session_id : "";

	if (mode === "pre") {
		const manifest = buildManifest(readTranscript(input.transcript_path), notesDir, sessionId);
		writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
		if (manifest.scan.entries > 0 && manifest.scan.toolUses === 0) {
			process.stderr.write(
				`persona-agents: the transcript holds ${manifest.scan.entries} entries but no tool calls; the reload list may be incomplete\n`,
			);
		}
		process.stdout.write(summaryInstructions(manifest));
		return;
	}

	const manifest = existsSync(manifestFile)
		? JSON.parse(readFileSync(manifestFile, "utf8"))
		: buildManifest(readTranscript(input.transcript_path), notesDir, sessionId);

	if (mode === "post") {
		const meta = lastBoundary(readTranscript(input.transcript_path));
		const tokens = meta.preTokens ? `, ${meta.preTokens} -> ${meta.postTokens ?? "?"} tokens` : "";
		if (typeof input.compact_summary === "string" && input.compact_summary) {
			appendFileSync(join(dir, `${id}.summaries.md`), `\n## ${stamp()} (${input.trigger})\n\n${input.compact_summary.trim()}\n`);
		}
		appendFileSync(
			join(dir, "metrics.ndjson"),
			`${JSON.stringify({ at: new Date().toISOString(), session: input.session_id, trigger: input.trigger, preTokens: meta.preTokens ?? null, postTokens: meta.postTokens ?? null, entries: manifest.scan?.entries ?? null, toolUses: manifest.scan?.toolUses ?? null, skills: manifest.skills.length, docs: manifest.docs.length })}\n`,
		);
		appendLog(manifest.taskNotes, `${stamp()} — compaction (${input.trigger}${tokens}); reload: ${manifest.skills.length} skills, ${manifest.docs.length} docs`);
		return;
	}

	if (mode === "reload") {
		process.stdout.write(
			JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: reloadContext(manifest) } }),
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const input = JSON.parse(readFileSync(0, "utf8"));
	if (input.agent_type === AGENT_TYPE) run(process.argv[2], input);
}
