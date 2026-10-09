/**
 * Permission prompt model + renderer for the pi gate.
 *
 * `buildPromptModel()` is PURE: it has no pi imports and returns the panel text
 * and the option list. `renderPermissionPrompt()` owns the pi wiring — a
 * pi-tui panel in TUI mode, a plain `ctx.ui.select` fallback otherwise.
 *
 * The model never carries the rule's raw regex. It shows the rule's human
 * `reason` as "Why:" so a person can decide. The four bash decisions and their
 * meaning are unchanged from the previous prompt.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** The gate decisions. The names are stable; the labels are display text. */
export type PermissionChoice =
	| "deny"
	| "allow-once-whole"
	| "allow-once-segment"
	| "always-allow";

/** A selectable option: display label plus the decision it maps to. */
export interface PromptOption {
	label: string;
	decision: PermissionChoice;
}

/** How the prompt treats the tool call. */
export type PromptKind = "shell-segment" | "shell-spanning" | "target";

/** Everything `buildPromptModel` needs. Plain data only, no pi types. */
export interface PromptInput {
	toolName: string;
	/** Whole command (shell) or path/pattern (other tools). */
	probe: string;
	/** The segment that matched the ask rule, or the whole command. */
	segment: string;
	/** 0-based index of `segment`, or -1 for a whole-command span match. */
	segmentIndex: number;
	/** Number of parsed segments in `probe`. */
	segmentCount: number;
	/** The rule's human reason. Never the regex. */
	reason?: string;
	/** True when `segmentIndex === -1` (the rule spans the whole command). */
	isSpanning: boolean;
}

/** The pure prompt model: plain text plus the option list. */
export interface PromptModel {
	title: string;
	toolName: string;
	kind: PromptKind;
	/** The whole command or the target path/pattern. */
	target: string;
	/** Plain-language detail lines. */
	lines: string[];
	/** Index into `lines` of the line to highlight, or -1. */
	highlightIndex: number;
	/** The text an "always allow" choice remembers. */
	remember: string;
	/** Decisions in display order. */
	options: PromptOption[];
}

/** Shell tools have segments; every other gated tool has one target. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Fallback for a rule without a human reason. Never the regex. */
const NO_REASON = "matches a permission rule";

/** The remembered text for an always-allow choice. */
function rememberText(reason: string | undefined): string {
	const trimmed = reason?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : NO_REASON;
}

/**
 * Build the permission panel model. Pure. The regex is never an input, so it
 * can never appear in the model.
 */
export function buildPromptModel(input: PromptInput): PromptModel {
	const isShell = SHELL_TOOLS.has(input.toolName);
	const remember = rememberText(input.reason);
	const why = `Why: ${remember}`;
	const lines: string[] = [];
	let highlightIndex = -1;
	let kind: PromptKind;
	let options: PromptOption[];

	if (!isShell) {
		kind = "target";
		lines.push(why);
		options = [
			{ label: "Deny", decision: "deny" },
			{ label: "Allow once", decision: "allow-once-whole" },
			{
				label: `Always allow this in this session: ${remember}`,
				decision: "always-allow",
			},
		];
	} else if (input.isSpanning) {
		kind = "shell-spanning";
		lines.push("This rule spans the whole command (no single part matches).");
		lines.push(why);
		lines.push(`Always allow remembers: ${remember} (session)`);
		options = [
			{ label: "Deny", decision: "deny" },
			{ label: "Allow this command once", decision: "allow-once-whole" },
			{ label: "Allow this rule once (no single part)", decision: "allow-once-segment" },
			{
				label: `Always allow this rule (this session): ${remember}`,
				decision: "always-allow",
			},
		];
	} else {
		kind = "shell-segment";
		const total = input.segmentCount > 0 ? input.segmentCount : 1;
		const position = input.segmentIndex >= 0 ? input.segmentIndex + 1 : 1;
		highlightIndex = lines.length;
		lines.push(`Blocked part (${position} of ${total}): ${input.segment}`);
		lines.push(why);
		lines.push(`Always allow remembers: ${remember} (session)`);
		options = [
			{ label: "Deny", decision: "deny" },
			{ label: "Allow this command once", decision: "allow-once-whole" },
			{ label: "Allow only the blocked part once", decision: "allow-once-segment" },
			{
				label: `Always allow the blocked part (this session): ${remember}`,
				decision: "always-allow",
			},
		];
	}

	return {
		title: "Permission required",
		toolName: input.toolName,
		kind,
		target: input.probe,
		lines,
		highlightIndex,
		remember,
		options,
	};
}

/** Plain multi-line title for the `ctx.ui.select` fallback. */
export function plainPromptTitle(model: PromptModel): string {
	const detail = model.lines.map((line) => `  ${line}`).join("\n");
	return `⚠️ ${model.title} (${model.toolName})\n\n  ${model.target}\n${detail}\n\nAllow?`;
}

type TuiModule = typeof import("@earendil-works/pi-tui");

/** Pad or clip one styled line to an exact visible width. */
function fitLine(text: string, width: number, mod: TuiModule): string {
	const clipped = mod.truncateToWidth(text, width, "…", false);
	const pad = width - mod.visibleWidth(clipped);
	return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

/** Build the bordered panel lines for the current width and selection. */
function renderPanel(
	model: PromptModel,
	width: number,
	theme: Theme,
	mod: TuiModule,
	selected: number,
): string[] {
	const total = Math.max(1, Math.floor(width));
	const inner = Math.max(1, total - 4);

	// Content in reading order: target, detail lines, options, hint.
	const content: { text: string; color: "text" | "muted" | "warning" | "accent" | "dim" }[] = [
		{ text: model.target, color: "text" },
	];
	model.lines.forEach((line, index) => {
		content.push({ text: line, color: index === model.highlightIndex ? "warning" : "muted" });
	});
	content.push({ text: "", color: "text" });
	model.options.forEach((option, index) => {
		const cursor = index === selected ? "❯ " : "  ";
		content.push({ text: `${cursor}${option.label}`, color: index === selected ? "accent" : "text" });
	});
	content.push({ text: "", color: "text" });
	content.push({ text: "↑/↓ move · Enter select · Esc deny", color: "dim" });

	const body: string[] = [];
	for (const entry of content) {
		for (const wrapped of mod.wrapTextWithAnsi(entry.text, inner)) {
			body.push(theme.fg(entry.color, wrapped));
		}
	}

	// Very narrow terminals: skip the box, keep the content readable.
	if (total < 8) {
		return body.map((line) => mod.truncateToWidth(line, total, "…", false));
	}

	// Clip the title so a long title never pushes the top border past the panel width.
	const rawTitle = theme.fg("border", "─ ") + theme.fg("accent", theme.bold(model.title)) +
		theme.fg("border", ` ── ${model.toolName} `);
	const title = mod.truncateToWidth(rawTitle, Math.max(0, total - 2), "…", false);
	const used = 2 + mod.visibleWidth(title);
	const top = theme.fg("border", "┌") + title + theme.fg("border", "─".repeat(Math.max(0, total - used)) + "┐");

	const out: string[] = [top];
	for (const line of body) {
		out.push(theme.fg("border", "│ ") + fitLine(line, inner, mod) + theme.fg("border", " │"));
	}
	out.push(theme.fg("border", "└" + "─".repeat(total - 2) + "┘"));
	return out;
}

/**
 * The interactive panel component. Keyboard only: up/down move, Enter selects,
 * Esc denies. It calls `done` exactly once with the chosen decision.
 */
function createPermissionPanel(
	model: PromptModel,
	tui: TUI,
	theme: Theme,
	mod: TuiModule,
	done: (choice: PermissionChoice) => void,
): Component & { dispose?(): void } {
	let selected = 0;
	let cached: string[] | undefined;

	const invalidate = (): void => {
		cached = undefined;
	};
	const refresh = (): void => {
		invalidate();
		tui.requestRender();
	};

	const handleInput = (data: string): void => {
		if (mod.matchesKey(data, mod.Key.up)) {
			selected = Math.max(0, selected - 1);
			refresh();
			return;
		}
		if (mod.matchesKey(data, mod.Key.down)) {
			selected = Math.min(model.options.length - 1, selected + 1);
			refresh();
			return;
		}
		if (mod.matchesKey(data, mod.Key.enter)) {
			done(model.options[selected].decision);
			return;
		}
		if (mod.matchesKey(data, mod.Key.escape)) {
			done("deny");
		}
	};

	const render = (width: number): string[] => {
		if (!cached) cached = renderPanel(model, width, theme, mod, selected);
		return cached;
	};

	return { wantsKeyRelease: false, handleInput, render, invalidate };
}

/**
 * Show the permission prompt and return the chosen decision. TUI mode uses a
 * pi-tui panel; every other mode falls back to `ctx.ui.select`. A cancel or a
 * missing answer is a deny (fail closed).
 */
export async function renderPermissionPrompt(
	ctx: ExtensionContext,
	model: PromptModel,
): Promise<PermissionChoice> {
	if (ctx.mode === "tui") {
		const mod = await import("@earendil-works/pi-tui");
		const chosen = await ctx.ui.custom<PermissionChoice>(
			(tui, theme, _keybindings, done) => createPermissionPanel(model, tui, theme, mod, done),
			{
				overlay: true,
				overlayOptions: { width: "80%", maxHeight: "100%", anchor: "center", margin: { top: 1 } },
			},
		);
		return chosen ?? "deny";
	}

	const picked = await ctx.ui.select(
		plainPromptTitle(model),
		model.options.map((option) => option.label),
	);
	return model.options.find((option) => option.label === picked)?.decision ?? "deny";
}
