#!/usr/bin/env node
// startup — Claude Code SessionStart hook (startup, clear) for the companion.
//
// It sends the companion its startup read list as additional context: the
// project notes folder, the project rules and summary, the last three journal
// days, the open session notes, and the unfinished studies. It sends paths and
// short facts, not file contents, so the text stays far under the 10,000-
// character hook cap; the companion reads the files itself.
//
// Any other agent, or a session without one, gets no output.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectDir, projectName } from "./notes-paths.mjs";

const AGENT_TYPE = "persona-agents:companion";
const JOURNAL_DAYS = 3;
const UNFINISHED = new Set(["draft", "ready", "in-progress"]);
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/** The sorted names in a folder that pass `keep`, or [] when the folder is missing. */
function list(dir, keep) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => keep(name, join(dir, name)))
		.sort();
}

const isFile = (path) => statSync(path).isFile();
const isDir = (path) => statSync(path).isDirectory();

/** Session notes files whose Status line says open. */
export function openSessionNotes(dir) {
	return list(join(dir, "sessions"), (name, path) => name.endsWith(".md") && isFile(path))
		.map((name) => join(dir, "sessions", name))
		.filter((path) => /^- \*\*Status:\*\*\s*open\b/im.test(readFileSync(path, "utf8")));
}

/** Rows of studies/index.md whose stage is not done or abandoned: "title (stage): path". */
export function unfinishedStudies(dir) {
	const index = join(dir, "studies", "index.md");
	if (!existsSync(index)) return [];
	const rows = [];
	for (const line of readFileSync(index, "utf8").split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		// | title | stage | updated | `path` |  splits to ["", title, stage, updated, path, ""]
		if (cells.length < 6 || !UNFINISHED.has(cells[2])) continue;
		rows.push(`${cells[1]} (${cells[2]}): ${join(dir, cells[4].replace(/`/g, ""))}`);
	}
	return rows;
}

/** The journal entry files of the last `days` day folders, oldest first. */
export function recentJournal(dir, days = JOURNAL_DAYS) {
	const journal = join(dir, "journal");
	const folders = list(journal, (name, path) => DAY_FOLDER.test(name) && isDir(path)).slice(-days);
	return folders.flatMap((day) =>
		list(join(journal, day), (name, path) => name.endsWith(".md") && isFile(path)).map((name) =>
			join(journal, day, name),
		),
	);
}

/** The startup context text for a working directory. */
export function startupContext(cwd, home) {
	const dir = projectDir(cwd, home);
	const project = projectName(cwd);
	const rules = list(join(dir, "rules"), (name, path) => name.endsWith(".md") && isFile(path)).map((name) =>
		join(dir, "rules", name),
	);
	const summary = join(dir, "summary.md");
	const bullets = (items) => (items.length ? items.map((item) => `- ${item}`) : ["- none"]);
	const lines = [
		"# Session start: read list",
		"",
		`Project: ${project}`,
		`Project notes folder: ${dir}${existsSync(dir) ? "" : " (does not exist yet)"}`,
		"",
		"Before your first answer, read these in full (rules in this order, then the summary):",
		...bullets([...rules, ...(existsSync(summary) ? [summary] : [])]),
		"",
		`Then read the journal of the last ${JOURNAL_DAYS} days with entries:`,
		...bullets(recentJournal(dir)),
		"",
		"Open session notes (read each; offer to resume or close it):",
		...bullets(openSessionNotes(dir)),
		"",
		"Unfinished studies (read a study only when the task names it):",
		...bullets(unfinishedStudies(dir)),
	];
	return lines.join("\n");
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
