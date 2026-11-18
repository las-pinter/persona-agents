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

/** The task text the reviewer child gets. */
export function reviewerPrompt(scope: string): string {
	const target = scope.trim() === "" ? "the uncommitted change in this repository" : scope.trim();
	return [
		`Review ${target}.`,
		"",
		"Note for Pi: skill names carry no plugin prefix here. Load the",
		"`code-review-checklist` skill, not `persona-agents:code-review-checklist`.",
		"",
		"Find the change yourself with git. Read the project rules (AGENTS.md,",
		"CLAUDE.md) when they exist. Return the review in your documented output",
		"format, ending with the `## Verdict` line.",
	].join("\n");
}
