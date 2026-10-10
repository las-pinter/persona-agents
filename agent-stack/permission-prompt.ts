/**
 * Permission prompt model + renderer for the pi gate.
 *
 * `buildPromptModel()` is PURE: it has no pi imports and returns the panel text
 * and the option list. `renderPermissionPrompt()` owns the pi wiring — a
 * pi-tui panel in TUI mode, a plain `ctx.ui.select` fallback otherwise.
 *
 * Every prompt kind shows the same three choices: Deny, Allow once, and Always
 * allow this rule (session). The model never carries the rule's raw regex. It
 * shows the rule's human `reason` as "Why:". The full command is the target;
 * the panel highlights the blocked segment inside it when the parsed segment
 * is a literal slice of the command.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** The gate decisions. The names are stable; the labels are display text. */
export type PermissionChoice = "deny" | "allow-once" | "always-allow";

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
	/** Real start offset of `segment` in `probe`, or -1 when unknown/spanning. */
	segmentStart: number;
	/** The rule's human reason. Never the regex. */
	reason?: string;
	/** True when the rule spans the whole command (no single segment matches). */
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
	/** The blocked slice of `target`, or null when there is no literal slice. */
	highlight: { start: number; end: number } | null;
	/** Human reason for the Why line. */
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
 * The rule's human reason, or undefined when it is empty or equals the regex.
 * A reason equal to the regex is not human text, so it is dropped.
 */
export function humanReason(reason: string | undefined, match: string | undefined): string | undefined {
	const trimmed = reason?.trim();
	return trimmed && trimmed.length > 0 && trimmed !== match ? trimmed : undefined;
}

/**
 * Stable courier label for the herdr event and the headless block reason. It is
 * built from the tool name and the rule source, plus the rule's human reason
 * when that reason exists and differs from the regex. The regex never appears.
 */
export function herdrBlockedLabel(
	toolName: string,
	source: "global" | "agent",
	agentName: string | null,
	reason?: string,
	match?: string,
): string {
	const who = source === "global" ? "global policy" : `${agentName ?? "agent"} policy`;
	const base = `Permission required: ${toolName} (${who})`;
	const human = humanReason(reason, match);
	return human ? `${base}: ${human}` : base;
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
	let highlight: { start: number; end: number } | null = null;
	let kind: PromptKind;

	if (!isShell) {
		kind = "target";
		lines.push(why);
	} else if (input.isSpanning) {
		kind = "shell-spanning";
		lines.push("This rule spans the whole command (no single part matches).");
		lines.push(why);
	} else {
		kind = "shell-segment";
		const start = input.segmentStart;
		if (start >= 0 && input.probe.slice(start, start + input.segment.length) === input.segment) {
			highlight = { start, end: start + input.segment.length };
			lines.push(why);
		} else {
			// The core folds and normalizes the segment, so the slice can miss.
			lines.push(`Blocked part: ${input.segment}`);
			lines.push(why);
		}
	}

	// One shared list: every kind offers the same three choices.
	const options: PromptOption[] = [
		{ label: "Deny", decision: "deny" },
		{ label: "Allow once", decision: "allow-once" },
		{ label: "Always allow this rule (session)", decision: "always-allow" },
	];

	return {
		title: "Permission required",
		toolName: input.toolName,
		kind,
		target: input.probe,
		lines,
		highlight,
		remember,
		options,
	};
}

/** Plain multi-line title for the `ctx.ui.select` fallback. */
export function plainPromptTitle(model: PromptModel): string {
	// No color in the fallback, so bracket the blocked part instead.
	const marked = model.highlight
		? model.target.slice(0, model.highlight.start) +
			"[" + model.target.slice(model.highlight.start, model.highlight.end) + "]" +
			model.target.slice(model.highlight.end)
		: model.target;
	const detail = model.lines.map((line) => `  ${line}`).join("\n");
	return `⚠️ ${model.title} (${model.toolName})\n\n  ${marked}\n${detail}\n\nAllow?`;
}

/** Style the target and mark the blocked slice in the warning color. */
export function highlightCommand(model: PromptModel, theme: Theme): string {
	if (!model.highlight) return theme.fg("text", model.target);
	const { start, end } = model.highlight;
	return theme.fg("text", model.target.slice(0, start)) +
		theme.fg("warning", theme.bold(model.target.slice(start, end))) +
		theme.fg("text", model.target.slice(end));
}

type TuiModule = typeof import("@earendil-works/pi-tui");

/** Pad or clip one styled line to an exact visible width. */
function fitLine(text: string, width: number, mod: TuiModule): string {
	const clipped = mod.truncateToWidth(text, width, "…", false);
	const pad = width - mod.visibleWidth(clipped);
	return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

/** Build the bordered panel lines for the current width and selection. */
export function renderPanel(
	model: PromptModel,
	width: number,
	theme: Theme,
	mod: TuiModule,
	selected: number,
): string[] {
	const total = Math.max(1, Math.floor(width));
	const inner = Math.max(1, total - 4);

	// Content in reading order: target, detail lines, options, hint.
	const content: { text: string; color: "text" | "muted" | "warning" | "accent" | "dim" | null }[] = [
		{ text: highlightCommand(model, theme), color: null },
	];
	model.lines.forEach((line) => {
		content.push({ text: line, color: "muted" });
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
			body.push(entry.color === null ? wrapped : theme.fg(entry.color, wrapped));
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
