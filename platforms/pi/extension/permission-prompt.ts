/**
 * Permission prompt model + renderer for the pi gate.
 *
 * `buildPromptModel()` is PURE: it has no pi imports and returns the panel text
 * and the option list. `renderPermissionPrompt()` owns the pi wiring — a
 * pi-tui panel in TUI mode, a plain `ctx.ui.select` fallback otherwise.
 *
 * Every prompt kind shows the same three choices: Allow once, Always allow
 * this rule (session), and Deny. The model never carries the rule's raw regex. It
 * shows the rule's human `reason` as "Why:". The full command is the target;
 * the panel highlights the blocked segment inside it when the parsed segment
 * is a literal slice of the command.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { askPanelSlot } from "./ask-panel-slot.ts";
import { recordAsk, recordLogLine } from "./ask-record.ts";
import { boundRunRegistry, UNKNOWN_RUN_ROLE } from "./run-registry.ts";
import { sessionIdOf } from "./session-id.ts";
import { isShellTool } from "./shell-tools.ts";
import { humanReason, policyLayer, ruleReasonFallback } from "./command-segments.ts";

/** The gate decisions. The names are stable; the labels are display text. */
export type PermissionChoice = "deny" | "allow-once" | "always-allow";

/** The one block reason the prompt reports when the owner picks Deny. */
export const DENIED_BY_USER_REASON = "Denied by user";

/** A selectable option: display label plus the decision it maps to. */
export interface PromptOption {
	label: string;
	decision: PermissionChoice;
}

/**
 * The three choices in paint order, each label beside its own decision, so no
 * swap can pair a label with a decision that belongs to another row.
 */
const PROMPT_OPTION_TABLE = [
	{ label: "Allow once", decision: "allow-once" },
	{ label: "Always allow this rule (session)", decision: "always-allow" },
	{ label: "Deny", decision: "deny" },
] as const satisfies readonly PromptOption[];

/**
 * The labels of that table in paint order. The pi README quotes these labels.
 */
export const PROMPT_OPTION_LABELS = [
	PROMPT_OPTION_TABLE[0].label,
	PROMPT_OPTION_TABLE[1].label,
	PROMPT_OPTION_TABLE[2].label,
] as const;

/** The three options in paint order, copied from the one table. */
export function promptOptions(): PromptOption[] {
	return PROMPT_OPTION_TABLE.map((option) => ({ label: option.label, decision: option.decision }));
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
	/** The rule regex, read only to drop a reason that repeats it. Never shown. */
	match?: string;
	/** Which policy layer holds the rule. Defaults to the global layer. */
	source?: "global" | "agent";
	/** The agent name, read only when the rule is an agent rule. */
	agentName?: string | null;
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

/**
 * Stable label for the headless block reason. It is built from the tool name
 * and the rule source, plus the rule's human reason when that reason exists
 * and differs from the regex. The regex never appears.
 */
export function blockedLabel(
	toolName: string,
	source: "global" | "agent",
	agentName: string | null,
	reason?: string,
	match?: string,
): string {
	const who = policyLayer(source, agentName);
	const base = `Permission required: ${toolName} (${who})`;
	const human = humanReason(reason, match);
	return human ? `${base}: ${human}` : base;
}

/**
 * Build the permission panel model. Pure. The rule regex may come in only to
 * drop a reason that repeats it; the model never carries it.
 */
export function buildPromptModel(input: PromptInput): PromptModel {
	// Shell tools have segments; every other gated tool has one target.
	const isShell = isShellTool(input.toolName);
	// A reason equal to the rule regex is not human text, so the model drops it.
	const remember =
		humanReason(input.reason, input.match) ??
		ruleReasonFallback(input.toolName, input.source ?? "global", input.agentName ?? null);
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
	const options = promptOptions();

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
	// The first row is the default, so a bare Enter selects the first option.
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
 * pi-tui panel; every other mode falls back to `ctx.ui.select`. A cancel, an
 * abort, or a missing answer is a deny (fail closed). An abort closes the TUI
 * panel. In every other mode the answer is raced against the signal, so a
 * timed-out ask denies at once and a late answer is ignored; the host select
 * itself cannot be closed here.
 */
export async function renderPermissionPrompt(
	ctx: ExtensionContext,
	model: PromptModel,
	signal?: AbortSignal,
): Promise<PermissionChoice> {
	if (ctx.mode === "tui") {
		const mod = await import("@earendil-works/pi-tui");
		let mountedTui: TUI | undefined;
		// The mount requests a render with the cached frame, so the overlay is not
		// drawn. The synchronous paint is not forced because a forced paint clears
		// the screen and the scrollback, which strands the sidebar row cache.
		const paintOnce = (): void => {
			const target = mountedTui;
			if (!target) return;
			try {
				target.renderNow();
			} catch (error) {
				// The paint is cosmetic, so a failed paint must not fail the ask.
				recordLogLine({ text: `agent-stack: forced paint failed: ${(error as Error).message}` });
			}
		};
		const mounted = ctx.ui.custom<PermissionChoice>(
			(tui, theme, _keybindings, done) => {
				mountedTui = tui;
				const panel = createPermissionPanel(model, tui, theme, mod, done);
				// An aborted ask closes the panel and denies, so no stale prompt stays.
				if (signal) {
					if (signal.aborted) done("deny");
					else signal.addEventListener("abort", () => done("deny"), { once: true });
				}
				return panel;
			},
			{
				overlay: true,
				overlayOptions: { width: "80%", maxHeight: "100%", anchor: "center", margin: { top: 1 } },
				// The host calls this right after it pushes the overlay, so one paint
				// here lands on a mounted panel. A closed prompt never gets here.
				onHandle: paintOnce,
			},
		);
		const chosen = await mounted;
		return chosen ?? "deny";
	}

	const picked = await untilAborted(
		ctx.ui.select(plainPromptTitle(model), model.options.map((option) => option.label)),
		signal,
	);
	return model.options.find((option) => option.label === picked)?.decision ?? "deny";
}

/**
 * The role of one ask: the role in its run record, else the role the gate passed
 * in, else the unknown placeholder. The gate supplies the role, so a lost id
 * cannot name an agent the gate did not judge.
 */
function askRole(sessionId: string | null, judgedRole: string | null | undefined): string {
	const fromRecord = sessionId ? boundRunRegistry()?.get(sessionId)?.role : undefined;
	return fromRecord ?? judgedRole ?? UNKNOWN_RUN_ROLE;
}

/** What the root renderer needs from its caller. */
export interface RootAskOptions {
	/** Aborts the ask. The host select dialog is not closed by it. */
	signal?: AbortSignal;
	/** The role the gate judged, recorded at settle when no run record names one. */
	role?: string | null;
}

/**
 * Show the root permission prompt. The root holds the ask panel slot while its
 * panel is live, so a queued child ask cannot mount beside it. A child ask does
 * not come here: the child queue takes the slot itself, and a second acquire on
 * one ask would deadlock. The slot is released on every exit: answer, deny,
 * cancel, abort, or throw. A signal can release the slot while the host select
 * dialog is still on screen, because the fallback cannot close that dialog. The
 * root gate passes no signal today, so that release path is not reached.
 *
 * The options carry the role the gate judged, so the record cannot name an
 * agent the gate never saw.
 */
export async function renderRootPermissionPrompt(
	ctx: ExtensionContext,
	model: PromptModel,
	options: RootAskOptions = {},
): Promise<PermissionChoice> {
	const releaseSlot = await askPanelSlot.acquire();
	try {
		const choice = await renderPermissionPrompt(ctx, model, options.signal);
		// One settled root ask writes one record with its own id. A throw above
		// writes none. The id is read once, so the role and the run id agree.
		const sessionId = sessionIdOf(ctx);
		recordAsk({
			tool: model.toolName,
			role: askRole(sessionId, options.role),
			verdict: choice === "deny" ? "deny" : "allow",
			runId: sessionId ?? undefined,
			depth: 0,
			phase: "settle",
		});
		return choice;
	} finally {
		releaseSlot();
	}
}

/**
 * Resolve with the pending answer, or with undefined as soon as the signal
 * aborts. The pending promise keeps running, so a late answer is dropped here.
 */
function untilAborted(
	pending: Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!signal) return pending;
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<string | undefined>((resolve) => {
		const onAbort = (): void => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		const done = (value: string | undefined): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		void pending.then(done, () => done(undefined));
	});
}
