/**
 * One-line summaries for the Pi surfaces.
 *
 * The renderers stay thin: each surface prints its text, and a function here
 * turns that text into one line and the counts it holds. Pure functions over
 * text they are given, so the counts are testable and no renderer holds logic.
 */

import { oneLine, parseVerdict } from "./review.ts";

/** What a review's one line needs. */
export interface ReviewSummary {
	/** `Approve`, `Request Changes`, `Reject`, or `no verdict`. */
	verdict: string;
	blocker: number;
	critical: number;
	important: number;
	suggestion: number;
	nit: number;
	/** The review key, or `unknown` when the text carries none. */
	key: string;
}

/** True when a line is a level-2 heading. */
function isHeading(line: string): boolean {
	return line.startsWith("## ");
}

/** True when a heading line names `heading`, ignoring case and trailing text. */
function headingIs(line: string, heading: string): boolean {
	return isHeading(line) && line.slice(3).trim().toLowerCase().startsWith(heading.toLowerCase());
}

/** The lines of one `## Heading` section, up to the next heading. */
function sectionLines(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => headingIs(line, heading));
	if (start === -1) return [];
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(isHeading);
	return end === -1 ? rest : rest.slice(0, end);
}

/** True for a bullet that states something, false for a placeholder. */
function isBullet(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("- ")) return false;
	// `- none` and `- none: the built-in doctrine ...` are placeholders;
	// `- nonetheless the gate asks` is a real bullet.
	return !/^none\b/i.test(trimmed.slice(2).trimStart());
}

/** How many `- ` bullets a section holds. */
function bulletsIn(text: string, heading: string): number {
	return sectionLines(text, heading).filter(isBullet).length;
}

/** The severities a review may state, as they are spelled in the output. */
const SEVERITIES = ["BLOCKER", "CRITICAL", "IMPORTANT", "SUGGESTION", "NIT"] as const;
type Severity = (typeof SEVERITIES)[number];

/**
 * How many times a severity is named in the given lines.
 *
 * The word counts with or without emphasis: the reviewer template writes
 * `Severity (BLOCKER | CRITICAL | ...)` in plain text, and a bold-only match
 * would report `no issues` for a review full of findings.
 */
function severityCount(lines: string[], severity: Severity): number {
	return lines.reduce((total, line) => {
		const words = line.split(/[^A-Za-z]+/).filter((word) => word !== "");
		// Only the written label counts: `important findings` in prose is not a
		// finding, and `not a blocker` is prose too.
		return total + words.filter((word) => word === severity).length;
	}, 0);
}

/**
 * The verdict, the severity counts, and the key of a review.
 *
 * Counts come from the `## Issues` section only: a severity named under
 * `Not verified` is not a finding.
 */
export function summarizeReview(text: string): ReviewSummary {
	const issues = sectionLines(text, "Issues");
	const counts: Record<Severity, number> = {
		BLOCKER: severityCount(issues, "BLOCKER"),
		CRITICAL: severityCount(issues, "CRITICAL"),
		IMPORTANT: severityCount(issues, "IMPORTANT"),
		SUGGESTION: severityCount(issues, "SUGGESTION"),
		NIT: severityCount(issues, "NIT"),
	};
	const keyLine = text.split("\n").find((line) => line.trim().startsWith("review key: "));
	return {
		verdict: parseVerdict(text) ?? "no verdict",
		blocker: counts.BLOCKER,
		critical: counts.CRITICAL,
		important: counts.IMPORTANT,
		suggestion: counts.SUGGESTION,
		nit: counts.NIT,
		key: keyLine ? keyLine.trim().slice("review key: ".length).trim() : "unknown",
	};
}

/** `review  Request Changes · 1 imp · 3 sug · 388178d` */
export function reviewLine(summary: ReviewSummary): string {
	const parts: string[] = [];
	const add = (value: number, label: string): void => {
		if (value > 0) parts.push(`${value} ${label}`);
	};
	add(summary.blocker, "blocker");
	add(summary.critical, "crit");
	add(summary.important, "imp");
	add(summary.suggestion, "sug");
	add(summary.nit, "nit");
	return `review  ${summary.verdict} · ${parts.length > 0 ? parts.join(" · ") : "no issues"} · ${summary.key}`;
}

/** `permissions  12 rules · 2 grants · 0 errors` */
export function permissionsLine(report: string): string {
	const rules = bulletsIn(report, "Rules");
	const grants = bulletsIn(report, "Session grants");
	const errors = bulletsIn(report, "Load errors");
	return `permissions  ${rules} rules · ${grants} grants · ${errors} errors`;
}

/** A count from a `- label: N` facts line, or 0. */
function factCount(facts: string, label: string): number {
	const prefix = `- ${label.toLowerCase()}:`;
	for (const line of facts.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.toLowerCase().startsWith(prefix)) continue;
		const value = Number.parseInt(trimmed.slice(prefix.length).trim(), 10);
		return Number.isFinite(value) ? value : 0;
	}
	return 0;
}

/** `retro  6 tool calls · 3 files · 1 review` */
export function retroLine(facts: string): string {
	const reviews = factCount(facts, "independent reviews");
	const reviewWord = reviews === 1 ? "review" : "reviews";
	const tools = factCount(facts, "tool calls");
	const files = factCount(facts, "files changed");
	return `retro  ${tools} tool calls · ${files} files · ${reviews} ${reviewWord}`;
}

/** `read list  6 paths · 18 lines` */
export function listLine(name: string, text: string): string {
	const paths = text.split("\n").filter(isBullet).length;
	return `${name}  ${paths} paths · ${text.split("\n").length} lines`;
}

/** `journal  written: <path>`, or the text itself when it names no file. */
export function journalLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("journal entry written: ")) {
			return `journal  written: ${trimmed.slice("journal entry written: ".length).trim()}`;
		}
	}
	return `journal  ${oneLine(text, 80)}`;
}
