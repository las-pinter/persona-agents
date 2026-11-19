/**
 * Independent review for the Pi adapter: the change, the verdict, and the gate.
 *
 * Pure functions only. The extension runs git, spawns the reviewer, and asks the
 * owner; this module decides what a change is, how to name it, what the reviewer
 * concluded, and whether a commit may go ahead.
 *
 * The gate is an ask, never a silent allow: a non-trivial change with no
 * covering review prompts. A trivial change (two files, forty lines) does not,
 * so a typo fix does not nag.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { studyIndexRows } from "./notes.ts";

/** The verdict a reviewer may return, in the order the sentence reads. */
export const VERDICTS = ["Approve", "Request Changes", "Reject"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Change {
	/** `git diff HEAD` (or `git show HEAD` when the tree is clean). */
	diffText: string;
	/** The changed paths, from the diff and the untracked list. */
	files: string[];
	/** Untracked paths, which a diff does not show. */
	untracked: string[];
	addedLines: number;
	removedLines: number;
	/**
	 * A fingerprint of what a diff cannot show: the untracked files. An untracked
	 * file edited after its review changes the key, so the review stops counting.
	 */
	signature: string;
}

/** The largest change the gate still treats as trivial. */
export const TRIVIAL_FILES = 2;
export const TRIVIAL_LINES = 40;

/** A stable key for one exact change, so a review covers what it reviewed. */
export function reviewKey(change: Pick<Change, "diffText" | "untracked" | "files" | "signature">): string {
	const hash = createHash("sha256");
	hash.update([...change.files].sort().join("\n"));
	hash.update("\u0000");
	hash.update(change.diffText);
	hash.update("\u0000");
	hash.update([...change.untracked].sort().join("\n"));
	hash.update("\u0000");
	hash.update(change.signature ?? "");
	return hash.digest("hex").slice(0, 16);
}

/** True when a change is small enough not to need a review before a commit. */
export function isTrivial(change: Pick<Change, "files" | "addedLines" | "removedLines">): boolean {
	return change.files.length <= TRIVIAL_FILES && change.addedLines + change.removedLines <= TRIVIAL_LINES;
}

/** Count the added and removed lines of a unified diff. */
export function countDiffLines(diffText: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diffText.split("\n")) {
		// A file header (`+++ b/x`, `--- a/x`) is not a changed line.
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) addedLines++;
		else if (line.startsWith("-")) removedLines++;
	}
	return { addedLines, removedLines };
}

/** The changed paths a `git diff` names, in order. */
export function diffFiles(diffText: string): string[] {
	const files: string[] = [];
	for (const line of diffText.split("\n")) {
		if (!line.startsWith("+++ ")) continue;
		const path = line.slice(4).trim().replace(/^b\//, "");
		if (path !== "" && path !== "/dev/null" && !files.includes(path)) files.push(path);
	}
	return files;
}

/** The untracked paths from `git status --porcelain`. */
export function untrackedFiles(statusText: string): string[] {
	return statusText
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3).trim())
		.filter((path) => path !== "");
}

/** Build a Change from git output. */
export function makeChange(diffText: string, statusText: string, signature = ""): Change {
	const untracked = untrackedFiles(statusText);
	const files = [...new Set([...diffFiles(diffText), ...untracked])];
	return { diffText, files, untracked, ...countDiffLines(diffText), signature };
}

/**
 * The verdict a reviewer's text states, or null. Accepts the agent's
 * `[Approve | Request Changes | Reject] — reason` line, a `Verdict: X` line,
 * and bold or bracketed forms.
 */
export function parseVerdict(text: string): Verdict | null {
	const pattern = /(Request Changes|Approve|Reject)/i;
	// The `## Verdict` section wins over a stray mention earlier in the text.
	const section = /^##\s+Verdict\s*$/im.exec(text);
	const tail = section ? text.slice(section.index) : "";
	for (const source of [tail, text]) {
		if (!source) continue;
		const found = pattern.exec(source.replace(/[*_`[\]]/g, ""));
		if (found) {
			const raw = found[1].toLowerCase();
			if (raw === "approve") return "Approve";
			if (raw === "reject") return "Reject";
			return "Request Changes";
		}
	}
	return null;
}

export interface GateInput {
	trivial: boolean;
	/** The stored review for this change, if any. */
	reviewed: Verdict | null;
}

export type GateVerdict = "allow" | "ask";

/**
 * Whether a commit may run without asking. Only a trivial change, or one an
 * independent review approved, passes silently. A review that asked for changes
 * still asks: fixing it first is the companion's call, not the gate's.
 */
export function commitGate(input: GateInput): { verdict: GateVerdict; reason: string } {
	if (input.trivial) return { verdict: "allow", reason: "a trivial change needs no review before a commit" };
	if (input.reviewed === "Approve") return { verdict: "allow", reason: "an independent review approved this exact change" };
	if (input.reviewed) {
		return { verdict: "ask", reason: `the review returned ${input.reviewed}, so this commit needs your approval` };
	}
	return { verdict: "ask", reason: "this change has no independent review, so the commit needs your approval" };
}

/** True when a shell command is a plain `git commit`. */
export function isCommitCommand(command: string): boolean {
	return /(^|[;&|]\s*)(sudo\s+)?git\s+(-[^\s]+\s+\S+\s+)*commit\b/.test(command);
}

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
const UNCOMMITTED = "the uncommitted change in this repository";

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
export function promptForBrief(brief: Brief): string {
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
		"A scope that git cannot resolve is not a scope: say so in one line, and",
		"review what you can.",
		"",
		"Note for Pi: skill names carry no plugin prefix here. The agent",
		"instructions name `persona-agents:code-review-checklist`; on Pi load",
		"`code-review-checklist`. Never a name with the prefix.",
		"",
		"Orient yourself before you judge: the repository and its branch, `git log`",
		"for the scope, the project rules (AGENTS.md, CLAUDE.md), and the decisions",
		"file when it is not `none`. Return the review in your documented output",
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
 * The wait a reviewer child gets. A full review reads the change and runs the
 * test suite once, so a small window would kill a review that is still working.
 */
export const REVIEWER_TIMEOUT_MS = 600_000;

/** What a finished child reports: its exit code, whether it was killed, and its stderr. */
export interface ChildResult {
	/** Null or absent when no exit code was recorded, as with a killed child. */
	code?: number | null;
	killed?: boolean;
	stderr?: string;
	/** What the child printed; an empty review is not a review. */
	stdout?: string;
	/** True when the caller cancelled rather than the timeout firing. */
	aborted?: boolean;
}

/**
 * Why a reviewer child produced no usable review, or "" when it finished.
 *
 * A killed child and a non-zero exit used to arrive as empty review text, which
 * read like a reviewer with nothing to say. An empty review is never a review.
 */
export function reviewerFailure(result: ChildResult, timeoutMs = REVIEWER_TIMEOUT_MS): string {
	if (result.killed) return result.aborted ? "the reviewer child was cancelled" : `the reviewer child was killed after ${Math.round(timeoutMs / 1000)}s`;
	// The Pi SDK types the exit code as nullable; this branch guards that type.
	if (result.code === null || result.code === undefined) {
		return "the reviewer child recorded no exit code, so its review cannot be trusted";
	}
	if (result.code !== 0) {
		const tail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" ").trim();
		const detail = tail === "" ? "" : `: ${oneLine(tail, 200)}`;
		return `the reviewer child exited with code ${result.code}${detail}`;
	}
	if ((result.stdout ?? "").trim() === "") return "the reviewer child finished without a review";
	return "";
}

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
