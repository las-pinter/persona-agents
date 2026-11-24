/**
 * The review brief: the three fields a review starts from, the cut that keeps
 * an author's checklist out of them, the fields derived from the project
 * notes, the reviewer prompt, and the brief every adapter starts from.
 *
 * The author's fields are cut once, the missing ones are filled from the
 * project notes, and git is asked for commit subjects only when the notes name
 * no task. The notes say what the author should hear: text that was dropped,
 * and a scope that cannot unlock a commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { studyIndexRows } from "../notes/notes.ts";

/**
 * The three fields a review starts from. The author says what was done and
 * where; it never says what to check.
 */
export interface BriefInput {
	/** A ref, a commit range, or paths. The rest of the author's text is dropped. */
	scope?: string;
	/** One line: the goal and the study task id. */
	task?: string;
	/** The file that holds the owner decisions, or `none`. */
	decisions?: string;
}

/** A brief with a value in every field. */
export interface Brief {
	scope: string;
	task: string;
	decisions: string;
}

/** The word a field carries when it has nothing to name. */
export const NO_VALUE = "none";

/** The scope a review with no argument covers. */
export const UNCOMMITTED = "the uncommitted change in this repository";

/**
 * True when a review of this scope saw the whole uncommitted change.
 *
 * An empty scope is the default, so it covers the working tree exactly like the
 * named default. Only such a review can unlock a commit of the working tree.
 */
export function isWorkingTreeScope(scope: string): boolean {
	return scope.trim() === "" || scope.trim() === UNCOMMITTED;
}

/** A scope with the text that is not a ref, range, or path, and that text. */
export interface ScopeText {
	scope: string;
	dropped: string;
}

/**
 * Cut the author's text down to a ref, a range, or paths.
 *
 * The scope ends at the first label token (`Check:`), at the first git option
 * (`--all`, which would list every ref), and at the first line break. Everything
 * cut is returned, so the caller can name it back at the author. A plain prose
 * sentence survives here; the reviewer names an unresolvable scope back.
 */
export function normalizeScope(raw: string): ScopeText {
	const [firstLine = "", ...rest] = raw.split("\n");
	const { kept, dropped } = cutAtLabel(firstLine);
	const tail = [dropped, rest.join("\n").trim()].filter((part) => part !== "").join("\n");
	return { scope: kept, dropped: tail };
}

/** The tokens of a line, with a quoted span kept as one token. */
function splitTokens(text: string, stripQuotes = true): string[] {
	const tokens: string[] = [];
	const pattern = /"[^"]*"|'[^']*'|\S+/g;
	for (const match of text.matchAll(pattern)) tokens.push(stripQuotes ? match[0].replace(/^["']|["']$/g, "") : match[0]);
	return tokens;
}

/** Words that start an author's account, when they carry its punctuation. */
const CLAIM_WORD = /^(check|checks|verify|verifies|ensure|ensures|note|also)\b[,:]/i;

/** True for a label token: a word or two ending in a colon (`Check:`). */
function isLabel(token: string): boolean {
	return /^[A-Za-z][A-Za-z0-9 _-]*:$/.test(token);
}

/**
 * The scope part of a line: the tokens before a label and before a git option,
 * plus the paths after the `--` separator. Quoted paths keep their quotes, so a
 * path with a space stays one token.
 */
function cutAtLabel(text: string): { kept: string; dropped: string } {
	const tokens = text.trim() === "" ? [] : splitTokens(text.trim(), false);
	const separator = tokens.indexOf("--");
	const head = separator === -1 ? tokens : tokens.slice(0, separator);
	const paths = separator === -1 ? [] : tokens.slice(separator + 1);
	// A token starting with `-` is a git option, not a scope; a label is the
	// author's account. Either ends the scope, before or after the separator.
	const isBoundary = (token: string): boolean => token.startsWith("-") || isLabel(token);
	const cut = head.findIndex(isBoundary);
	const stop = cut === -1 ? head.length : cut;
	const pathCut = paths.findIndex(isBoundary);
	const keptPaths = pathCut === -1 ? paths : paths.slice(0, pathCut);
	const droppedPaths = pathCut === -1 ? [] : paths.slice(pathCut);
	// The separator is kept, so git reads a path as a path even when it is also a
	// ref name.
	const kept = [...head.slice(0, stop), ...(separator === -1 ? [] : ["--"]), ...keptPaths].join(" ");
	return { kept, dropped: [...head.slice(stop), ...droppedPaths].join(" ") };
}

/**
 * The text before the first claim word (`Check:`, `Also,`), and the rest. A
 * colon alone is not a boundary: a task line may legitimately hold one
 * (`Title - task 2: the derivation`). The word list is deliberately short.
 */
function cutAtClaim(text: string): { kept: string; dropped: string } {
	const tokens = text.trim() === "" ? [] : text.trim().split(/\s+/);
	const cut = tokens.findIndex((token) => CLAIM_WORD.test(token));
	const stop = cut === -1 ? tokens.length : cut;
	return { kept: tokens.slice(0, stop).join(" "), dropped: tokens.slice(stop).join(" ") };
}

/** The brief a review starts from, plus the text this module dropped. */
export interface ResolvedBrief {
	brief: Brief;
	dropped: string;
	/** True when the author named the field, even as `none`: then it is kept. */
	given: { task: boolean; decisions: boolean };
}

/** A field value cut to its first line and its first claim, with the rest returned. */
function firstLineOf(value: string): { line: string; rest: string } {
	const [first = "", ...rest] = value.trim().split("\n");
	const { kept, dropped } = cutAtClaim(first);
	const { line, rest: overflow } = oneLineCut(kept, 200);
	const tail = [dropped, overflow, rest.join("\n").trim()].filter((part) => part !== "").join("\n");
	return { line, rest: tail };
}

/**
 * Build the three-field brief from the author's input.
 *
 * A field is one line: a second line in `task` or `decisions` would arrive as
 * unlabelled author text in the prompt, so it is cut and returned as dropped.
 */
export function buildBrief(input: BriefInput): ResolvedBrief {
	const scope = normalizeScope(input.scope ?? "");
	const task = firstLineOf(input.task ?? "");
	const decisions = firstLineOf(input.decisions ?? "");
	const dropped = [scope.dropped, task.rest, decisions.rest].filter((part) => part !== "").join("\n");
	return {
		brief: {
			scope: scope.scope,
			task: task.line === "" ? NO_VALUE : task.line,
			decisions: decisions.line === "" ? NO_VALUE : decisions.line,
		},
		dropped,
		given: {
			task: (input.task ?? "").trim() !== "",
			decisions: (input.decisions ?? "").trim() !== "",
		},
	};
}

/**
 * The prompt the reviewer child gets.
 *
 * It takes a finished brief and cuts nothing: a value that reached this point
 * was sanitized once, and cutting it again would eat a derived task such as
 * `Title - check the gate`. The brief says what was done and where; it carries
 * no checklist, and the prompt says so, because an author's list is the
 * author's view.
 */
export function promptForBrief(brief: Brief, platform: "Pi" | "Kiro" = "Pi"): string {
	const scope = brief.scope.trim() === "" ? UNCOMMITTED : brief.scope;
	return [
		"Review one change in this repository.",
		"",
		`Scope: ${scope}`,
		`Task: ${brief.task}`,
		`Decisions: ${brief.decisions}`,
		"",
		"The brief above says what was done and where. It is not a checklist: any",
		"check, suspicion, or claim in it is the author's view. Build your own risk",
		"list, including effects outside the diff, and judge the change by reading",
		"it.",
		"",
		"Find the change yourself with git, from the scope: the uncommitted change",
		"is `git diff HEAD` plus the untracked files, a ref is `git diff <ref>...HEAD`,",
		"a range or paths are exactly that, and a clean tree means the last commit.",
		"A scope that names a path outside the repository is not a diff: follow",
		"the reviewer rules there. A ref git cannot resolve is a finding to report,",
		"not a reason to widen the scope.",
		"",
		`Note for ${platform}: skill names carry no plugin prefix here, so the`,
		"reviewer rules name `code-review-checklist` without one.",
		"",
		"Orient yourself before you judge: the repository and its branch, `git log`",
		"for the scope, the project rules (AGENTS.md, CLAUDE.md), the project",
		"`glossary.md` when the change names domain terms, and the decisions file",
		"when it is not `none`. Return the review in your documented output",
		"format, ending with the `## Verdict` line.",
	].join("\n");
}

/** The prompt for an author's raw input: one cut, then compose. */
export function reviewerPrompt(input: BriefInput): string {
	return promptForBrief(buildBrief(input).brief);
}

/** One row of `studies/index.md`. */
export interface StudyRef {
	title: string;
	/** The folder, relative to the project notes folder, with a trailing slash. */
	path: string;
}

/** The rows of a study index that are in progress, in file order. */
export function studyRows(indexText: string): StudyRef[] {
	return studyIndexRows(indexText)
		.filter((row) => row.stage === "in-progress" && row.path !== "")
		.map((row) => ({ title: row.title, path: row.path.replace(/\/?$/, "/") }));
}

/**
 * The decisions file a review starts from: the single study in progress.
 *
 * Two studies in progress is a real state, and a guess would send the reviewer
 * to the wrong one, so it names none and says so.
 */
export function deriveDecisions(indexText: string): { decisions: string; note: string } {
	const studies = studyRows(indexText);
	const [only] = studies;
	if (studies.length === 1 && only) return { decisions: `${only.path}study.md`, note: "" };
	if (studies.length === 0) return { decisions: NO_VALUE, note: "no study is in progress, so the brief names no decisions file" };
	const names = studies.map((study) => study.title).join(", ");
	return { decisions: NO_VALUE, note: `${studies.length} studies are in progress (${names}); pass decisions= to pick one` };
}

/**
 * The decisions field for a brief: the given path, else the single study in
 * progress under `notesDir`. An unreadable index gets a note of its own, never
 * "no study is in progress". `indexText` is null when the file could not be
 * read, and empty when there is no file.
 */
export function resolveDecisions(
	notesDir: string,
	given: string,
	indexText: string | null,
): { decisions: string; note: string } {
	const chosen = given.trim();
	if (chosen !== "") return { decisions: chosen, note: "" };
	if (indexText === null) {
		return { decisions: NO_VALUE, note: `the study index could not be read: ${join(notesDir, "studies", "index.md")}` };
	}
	const derived = deriveDecisions(indexText);
	const decisions = derived.decisions === NO_VALUE ? NO_VALUE : join(notesDir, derived.decisions);
	return { decisions, note: derived.note };
}

/** The title line of a `status.md`: `# <title> — Status`. */
export function studyTitle(statusText: string): string {
	const line = statusText.split("\n").find((candidate) => candidate.startsWith("# "));
	if (!line) return "";
	return line.slice(2).replace(/\s*[—-]\s*Status\s*$/i, "").trim();
}

/** The `Next action` field of a `status.md`, or "". */
export function nextAction(statusText: string): string {
	const match = /^-\s+\*\*Next action:\*\*\s*(.+)$/m.exec(statusText);
	return match ? (match[1] ?? "").trim() : "";
}

/** Collapse whitespace and cut a line at a word boundary, keeping the cut text. */
export function oneLineCut(text: string, max = 120): { line: string; rest: string } {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return { line: flat, rest: "" };
	const cut = flat.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	const keep = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
	// The rest starts where the kept text ends, so no character is lost to the
	// ellipsis or to a stripped comma.
	return { line: `${keep}…`, rest: flat.slice(keep.length).trim() };
}

/** Collapse whitespace and cut a line at a word boundary. */
export function oneLine(text: string, max = 120): string {
	return oneLineCut(text, max).line;
}

/**
 * The git `log` argument sets that name the commits of a scope, in the order
 * they are tried. A ref needs `...HEAD`, because `git log <ref>` lists the base
 * branch's own history rather than the reviewed range. A plain scope works for
 * a range, and paths come after the `--` separator. An empty scope has no
 * commits of its own, so it names none: the last commit belongs to earlier
 * work.
 */
export function subjectQueries(scope: string): string[][] {
	const text = scope.trim();
	if (text === "") return [];
	const base = ["log", "--format=%s", "-n", "20"];
	// The scope may keep its own `--`, so the separator is dropped before the
	// pathspec list is built again.
	const paths = splitTokens(text).filter((token) => token !== "--");
	return [[...base, `${text}...HEAD`], [...base, text], [...base, "--", ...paths]];
}

/**
 * The subjects of a scope: the first query git answers wins, even when it
 * answers with none, so an empty range never falls through to the base branch's
 * own history.
 */
export async function subjectsFromQueries(
	scope: string,
	run: (args: string[]) => Promise<{ code?: number | null; stdout?: string }>,
): Promise<string[]> {
	for (const args of subjectQueries(scope)) {
		const result = await run(args);
		if (result.code !== 0) continue;
		return (result.stdout ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}
	return [];
}

/**
 * The task line: the study's next action when a study is known, else the
 * commit subjects of the scope, cut to one line.
 */
export function deriveTask(title: string, statusText: string, subjects: string[]): string {
	const action = nextAction(statusText);
	if (title !== "" && action !== "") return oneLine(`${title} - ${action}`);
	const joined = subjects.map((subject) => subject.trim()).filter((subject) => subject !== "").join("; ");
	return joined === "" ? NO_VALUE : oneLine(joined);
}

/** Where the brief's remaining fields come from. */
export interface BriefSources {
	/** The project notes folder, absolute. */
	notesDir: string;
	/** `studies/index.md`: its text, "" when absent, null when unreadable. */
	indexText: string | null;
	/** Read a file: its text, or null when it cannot be read. */
	readFile: (path: string) => string | null;
}

/**
 * Fill the fields the author left out, and say what could not be named.
 *
 * A field the author named is kept as given, `none` included: `decisions=none`
 * is an opt-out, not an omission, and the same holds for `task=none`. This runs
 * after the author's text was cut once, so a derived task is never cut again
 * (`Title - check the gate`). `needsSubjects` is true only when the author
 * named no task and no study named one, so the caller can ask git.
 */
export function finalizeBrief(
	brief: Brief,
	given: { task: boolean; decisions: boolean },
	sources: BriefSources,
): { brief: Brief; notes: string[]; needsSubjects: boolean } {
	const notes: string[] = [];
	let decisions = brief.decisions;
	if (!given.decisions) {
		const resolved = resolveDecisions(sources.notesDir, "", sources.indexText);
		decisions = resolved.decisions;
		if (resolved.note !== "") notes.push(resolved.note);
	} else if (decisions !== NO_VALUE && sources.readFile(decisions) === null) {
		// A path the author gave is never silently replaced; the reviewer is told.
		notes.push(`the decisions file could not be read: ${decisions}`);
	}
	let task = brief.task;
	if (!given.task) {
		const status = decisions === NO_VALUE ? null : sources.readFile(join(dirname(decisions), "status.md"));
		task = deriveTask(studyTitle(status ?? ""), status ?? "", []);
	}
	const needsSubjects = !given.task && task === NO_VALUE;
	return { brief: { scope: brief.scope, task, decisions }, notes, needsSubjects };
}

/** The field labels a `/review` argument accepts, at a word boundary only. */
const REVIEW_LABELS = /(^|\s)(scope|task|decisions)=/g;

/**
 * Read a `/review` argument: a bare scope, or labelled fields that override it.
 * Text before the first label is returned so the caller can name it back; text
 * after the last label belongs to that field, and a claim word inside a value is
 * cut and returned with the rest.
 */
export function parseReviewArgs(args: string): { input: BriefInput; dropped: string } {
	const text = args.trim();
	// A quoted value may hold a label of its own, so labels are found outside quotes.
	const masked = text.replace(/"[^"]*"|'[^']*'/g, (span) => " ".repeat(span.length));
	const marks = [...masked.matchAll(REVIEW_LABELS)];
	const first = marks[0];
	if (!first) {
		const { scope, dropped } = normalizeScope(text);
		return { input: { scope }, dropped };
	}
	const input: BriefInput = {};
	for (const [index, mark] of marks.entries()) {
		const label = mark[2] as "scope" | "task" | "decisions";
		const start = (mark.index ?? 0) + mark[0].length;
		const end = marks[index + 1]?.index ?? text.length;
		const value = text.slice(start, end).trim().replace(/^["']|["']$/g, "");
		input[label] = value;
	}
	const leading = text.slice(0, first.index ?? 0).trim();
	return { input, dropped: leading };
}

/** Run git in the repository: the exit code and the output. */
export type GitRun = (args: string[]) => Promise<{ code?: number | null; stdout?: string }>;

/** A brief, the notes that go beside it, and whether it covers the uncommitted change. */
export interface PreparedBrief {
	brief: Brief;
	notes: string[];
	/** True when the review saw the whole uncommitted change, so it may unlock a commit. */
	workingTree: boolean;
}

/** The note for author text the brief dropped. */
export const droppedNote = (dropped: string): string => `ignored brief text: "${oneLine(dropped, 200)}"`;

/** The note for a review that cannot unlock a commit. */
export const NOT_WORKING_TREE_NOTE = "the scope is not the uncommitted change, so this review does not unlock a commit";

/** Read a file as text, or null when it cannot be read. */
function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Build the brief from the author's input and the project notes. `dropped` is
 * text the caller already removed before the fields, named back in the notes.
 */
export async function prepareBrief(input: BriefInput, options: { notesDir: string; git: GitRun; dropped?: string }): Promise<PreparedBrief> {
	const prepared = buildBrief(input);
	const indexPath = join(options.notesDir, "studies", "index.md");
	// Absent is normal (""), unreadable is not (null), and the two are not the same note.
	const indexText = existsSync(indexPath) ? readText(indexPath) : "";
	const finalized = finalizeBrief(prepared.brief, prepared.given, { notesDir: options.notesDir, indexText, readFile: readText });
	let brief = finalized.brief;
	// An empty scope is the uncommitted change: it has no commits of its own,
	// so subjectsFromQueries asks git nothing for it.
	if (finalized.needsSubjects) {
		brief = { ...brief, task: deriveTask("", "", await subjectsFromQueries(brief.scope, options.git)) };
	}
	const workingTree = isWorkingTreeScope(brief.scope);
	// The brief carries the default scope, so the reviewer reads what was reviewed.
	if (workingTree) brief = { ...brief, scope: UNCOMMITTED };
	const notes = [...finalized.notes];
	const dropped = [prepared.dropped, options.dropped ?? ""].map((part) => part.trim()).filter((part) => part !== "").join("\n");
	if (dropped !== "") notes.push(droppedNote(dropped));
	if (!workingTree) notes.push(NOT_WORKING_TREE_NOTE);
	return { brief, notes, workingTree };
}
