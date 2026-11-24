/**
 * Independent review for the adapters: the change, the verdict, and the gate.
 *
 * Pure functions only. An adapter runs git, spawns the reviewer, and asks the
 * owner; this module decides what a change is, how to name it, what the reviewer
 * concluded, and whether a commit may go ahead.
 *
 * It stays one module because those four are one contract: the key names the
 * change the verdict covers, and the gate reads both. Splitting them would
 * duplicate the change shape across files.
 *
 * The gate is an ask, never a silent allow: a non-trivial change with no
 * covering review prompts. A trivial change (two files, forty lines) does not,
 * so a typo fix does not nag.
 */

import { createHash, randomUUID } from "node:crypto";
import { commandSegments, gitSubcommand, shellWords, unwrapSegment } from "../shell/gates.ts";
import { oneLine } from "./brief.ts";

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
	 * A fingerprint of every changed file's content and executable bit. An edit
	 * or a chmod after the review changes the key, so the review stops counting.
	 */
	signature: string;
}

/** The largest change the gate still treats as trivial. */
export const TRIVIAL_FILES = 2;
export const TRIVIAL_LINES = 40;

/**
 * A stable key for one exact change, so a review covers what it reviewed.
 *
 * A real adapter passes a signature that hashes each changed file's worktree
 * content; the key then ignores the index and the diff text, so `git add` does
 * not change it. A caller with no signature falls back to the diff text.
 */
export function reviewKey(change: Pick<Change, "diffText" | "untracked" | "files" | "signature">): string {
	const hash = createHash("sha256");
	hash.update([...change.files].sort().join("\n"));
	hash.update("\u0000");
	hash.update(change.signature ?? "");
	if (!change.signature) {
		hash.update("\u0000");
		hash.update(change.diffText);
	}
	return hash.digest("hex").slice(0, 16);
}

/** True when a change is small enough not to need a review before a commit. */
export function isTrivial(change: Pick<Change, "files" | "addedLines" | "removedLines">): boolean {
	return change.files.length <= TRIVIAL_FILES && change.addedLines + change.removedLines <= TRIVIAL_LINES;
}

/**
 * The change a failed git read yields: non-trivial, so the gate asks. A failed
 * read must never look like a small change, and its key is unique, so no
 * stored approval can cover it.
 */
export function failedChange(): Change {
	return { diffText: "", files: [], untracked: [], addedLines: TRIVIAL_LINES + 1, removedLines: 0, signature: `failed:${randomUUID()}` };
}

/** Count the added and removed lines of a unified diff. */
export function countDiffLines(diffText: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	let inHunk = false;
	for (const line of diffText.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		// A file header (`+++ b/x`, `--- a/x`) is not a changed line. Inside a
		// hunk, a body line may itself start with `++` or `--`.
		if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) continue;
		if (line.startsWith("+")) addedLines++;
		else if (line.startsWith("-")) removedLines++;
	}
	return { addedLines, removedLines };
}

/**
 * Undo git's C-style path quoting in a porcelain or diff path.
 *
 * Git quotes a path with spaces, non-ASCII bytes, or control characters as
 * `"a b\\n"`. The adapters disable `core.quotePath` for non-ASCII, but a space
 * still quotes, so the signature and the file list need the unquoted name.
 */
export function unquotePath(path: string): string {
	if (!path.startsWith('"') || !path.endsWith('"')) return path;
	const body = path.slice(1, -1);
	return body.replace(/\\(["\\abfnrtv]|[0-7]{3})/g, (_match, escape: string) => {
		switch (escape) {
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "v":
				return "\v";
			default:
				return /^[0-7]{3}$/.test(escape) ? String.fromCharCode(parseInt(escape, 8)) : escape;
		}
	});
}

/** The changed paths a `git diff` names, in order. */
export function diffFiles(diffText: string): string[] {
	const files: string[] = [];
	for (const line of diffText.split("\n")) {
		if (!line.startsWith("+++ ")) continue;
		const path = unquotePath(line.slice(4).trim()).replace(/^b\//, "");
		if (path !== "" && path !== "/dev/null" && !files.includes(path)) files.push(path);
	}
	return files;
}

/** The untracked paths from `git status --porcelain` (`-uall` lists files). */
export function untrackedFiles(statusText: string): string[] {
	return statusText
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => unquotePath(line.slice(3).trim()))
		.filter((path) => path !== "" && !path.endsWith("/"));
}

/**
 * The changed paths from `git status --porcelain`.
 *
 * `git diff` writes `+++ /dev/null` for a deletion, may show a rename as a
 * delete plus an add, and shows no `+++` line for a mode-only change, so the
 * status text is the reliable source. These paths join `files` and the content
 * signature, so deleting, renaming, or chmod-ing a file after a review changes
 * the key.
 */
export function statusFiles(statusText: string): string[] {
	const paths: string[] = [];
	for (const line of statusText.split("\n")) {
		if (line.length < 4 || line.startsWith("?? ")) continue;
		const x = line[0];
		const y = line[1];
		const rest = line.slice(3).trim();
		if (rest === "") continue;
		if (x === "R" || y === "R" || x === "C" || y === "C") {
			const [from, to] = rest.split(" -> ");
			if (from) paths.push(unquotePath(from));
			if (to) paths.push(unquotePath(to));
		} else {
			paths.push(unquotePath(rest));
		}
	}
	return paths;
}

/** The number of lines in a text; a trailing newline does not add a line. */
export function countLines(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * Build a Change from git output.
 *
 * `git diff` does not list an untracked file, so the caller passes the text of
 * each untracked file: its lines count toward the trivial-change limit. A new
 * file of any size must never pass the gate as trivial just because git has not
 * tracked it yet.
 */
export function makeChange(diffText: string, statusText: string, signature = "", untrackedTexts: string[] = []): Change {
	const untracked = untrackedFiles(statusText);
	const files = [...new Set([...diffFiles(diffText), ...untracked, ...statusFiles(statusText)])];
	const counts = countDiffLines(diffText);
	// A kilobyte counts as one line-equivalent, so a large single-line file (a
	// bundle, a blob) cannot pass the line limit by having one line.
	const untrackedLines = untrackedTexts.reduce((sum, text) => sum + countLines(text) + Math.floor(Buffer.byteLength(text, "utf8") / 1024), 0);
	// A binary swap or a mode-only change has no changed text lines; both need a
	// review, so neither may look trivial.
	const opaque = /^(GIT binary patch|Binary files .* differ|old mode \d+)$/m.test(diffText) ? TRIVIAL_LINES + 1 : 0;
	return {
		diffText,
		files,
		untracked,
		addedLines: counts.addedLines + untrackedLines + opaque,
		removedLines: counts.removedLines,
		signature,
	};
}

/**
 * The verdict a reviewer's text states, or null. Accepts the agent's
 * `[Approve | Request Changes | Reject] — reason` line, a `Verdict: X` line,
 * and bold or bracketed forms.
 *
 * A `## Verdict` section wins, then a line labelled `Verdict:`, then a line
 * that starts with the verdict word. Prose that merely mentions a verdict is
 * not a verdict: "not approved as-is" must not read as approval, and an
 * unlabelled review makes the commit ask.
 */
export function parseVerdict(text: string): Verdict | null {
	const plain = text.replace(/[*_`[\]]/g, "");
	const word = /\b(Request Changes|Approve|Reject)\b/i;
	const section = /^##\s+Verdict\s*$/im.exec(plain);
	if (section) {
		// Only the section's first non-blank line states the verdict; a template
		// echo or a sentence that mentions the words must not read as approval.
		const rest = plain.slice(section.index + section[0].length);
		const first = rest.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
		const found = /^(Request Changes|Approve|Reject)\s*(?:$|[—–:.,;!)-])(?=\s|$)/i.exec(first);
		return found ? verdictOf(found[1]) : null;
	}
	const labelled = /^\s*(?:#{1,6}\s*)?Verdict\s*:\s*(.+)$/im.exec(plain);
	if (labelled) {
		const found = word.exec(labelled[1]);
		if (found) return verdictOf(found[1]);
	}
	// An unlabelled verdict must be the whole line (or its own phrase); a
	// conditional sentence such as "Approve once the test is added" is not one.
	const lineForm = /^\s*(Request Changes|Approve|Reject)\s*(?:$|[—–:.,;!)-])(?=\s|$)/im.exec(plain);
	return lineForm ? verdictOf(lineForm[1]) : null;
}

/** The canonical verdict for a matched word. */
function verdictOf(word: string): Verdict {
	const raw = word.toLowerCase();
	if (raw === "approve") return "Approve";
	if (raw === "reject") return "Reject";
	return "Request Changes";
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

/**
 * True when a shell command runs `git commit`, including through `sudo`, an
 * env assignment, or a git global option (`git --no-pager commit`). The
 * subcommand comes from the shared shell classifier, so this cannot drift from
 * the gate.
 */
export function isCommitCommand(command: string): boolean {
	for (const raw of commandSegments(command)) {
		const words = shellWords(unwrapSegment(raw));
		let i = 0;
		if (words[i] === "sudo") i++;
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
		if (words[i] !== "git") continue;
		if (gitSubcommand(words.slice(i + 1)).sub === "commit") return true;
	}
	return false;
}

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
