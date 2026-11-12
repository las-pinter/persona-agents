/**
 * Tests for the permission-prompt model, its labels, and its renderer.
 *
 * Cohesion: one subject, the prompt the owner sees. It has three parts: the
 * model and its labels, the renderer, and the abort and cancel behaviour.
 *
 * Runs under plain Node (type stripping):
 *   npm test
 *
 * `buildPromptModel` must never carry the rule regex, must show the human
 * reason, must show the full command with the blocked part highlighted, and
 * must keep the same three decisions for every kind. The real-gate wire-up
 * that drives the installed `tool_call` handler lives in
 * `permission-prompt.gate.test.ts`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import {
	PROMPT_OPTION_LABELS,
	buildPromptModel,
	blockedLabel,
	highlightCommand,
	humanReason,
	plainPromptTitle,
	promptOptions,
	renderPanel,
	renderPermissionPrompt,
	type PromptModel,
} from "./permission-prompt.ts";
import { isShellTool } from "./shell-tools.ts";

const REASON = "orchestrator commit requires user approval";
const REGEX = "(?:^|[;&|(\\n])\\s*git\\s+(push|pull)\\b";

function shellModel(overrides: Partial<Parameters<typeof buildPromptModel>[0]> = {}): PromptModel {
	const probe = overrides.probe ?? 'git status && git commit -m "fix" && git push';
	const segment = overrides.segment ?? 'git commit -m "fix"';
	return buildPromptModel({
		toolName: "bash",
		probe,
		segment,
		segmentStart: probe.indexOf(segment),
		reason: REASON,
		isSpanning: false,
		...overrides,
	});
}

function decisions(model: PromptModel): string[] {
	return model.options.map((option) => option.decision);
}

/** One model of each prompt kind: located segment, fallback, spanning, target. */
function everyPromptKind(): PromptModel[] {
	return [
		shellModel(),
		shellModel({
			probe: "cd a &&  git commit",
			segment: "cd a && git commit",
			segmentStart: -1,
		}),
		shellModel({ probe: "foo && bar", segment: "foo && bar", isSpanning: true }),
		buildPromptModel({
			toolName: "read",
			probe: "/etc/hosts",
			segment: "/etc/hosts",
			segmentStart: -1,
			reason: "reading system host files",
			isSpanning: false,
		}),
	];
}

test("the Why line uses the human reason", () => {
	const model = shellModel();
	const why = model.lines.find((line) => line.startsWith("Why:"));
	assert.equal(why, `Why: ${REASON}`);
});

test("the model never carries the rule regex", () => {
	const model = shellModel();
	const text = JSON.stringify(model);
	assert.ok(!text.includes(REGEX));
	assert.ok(!model.lines.some((line) => line.includes("\\b")));
	assert.ok(!model.options.some((option) => option.label.includes(REGEX)));
	assert.ok(!model.target.includes(REGEX));
	const slice = model.highlight
		? model.target.slice(model.highlight.start, model.highlight.end)
		: "";
	assert.ok(!slice.includes(REGEX));
});

test("the full command is shown and the blocked segment is located", () => {
	const model = shellModel();
	assert.equal(model.target, 'git status && git commit -m "fix" && git push');
	assert.ok(model.highlight);
	assert.equal(
		model.target.slice(model.highlight.start, model.highlight.end),
		'git commit -m "fix"',
	);
});

test("the highlight starts at zero for the first segment", () => {
	const model = shellModel({ segment: "git status" });
	assert.ok(model.highlight);
	assert.equal(model.highlight.start, 0);
});

test("the highlight uses the parser offset, not the first literal occurrence", () => {
	const model = shellModel({ probe: "git status && git", segment: "git", segmentStart: 14 });
	assert.ok(model.highlight);
	assert.equal(model.highlight.start, 14);
	assert.equal(model.target.slice(model.highlight.start, model.highlight.end), "git");
});

test("the highlight locates a repeated segment by its parser offset", () => {
	const model = shellModel({ probe: "foo && bar && foo", segment: "foo", segmentStart: 14 });
	assert.ok(model.highlight);
	assert.equal(model.highlight.start, 14);
});

test("the highlight falls back when the parser offset does not match the slice", () => {
	const model = shellModel({ probe: "git status && git", segment: "git", segmentStart: 1 });
	assert.equal(model.highlight, null);
	assert.ok(model.lines.some((line) => line === "Blocked part: git"));
});

test("the highlight falls back when the parsed segment is not a literal slice", () => {
	const model = shellModel({ probe: "cd a &&  git commit", segment: "cd a && git commit" });
	assert.equal(model.highlight, null);
	assert.ok(model.lines.some((line) => line === "Blocked part: cd a && git commit"));
});

test("a shell segment prompt keeps the three decisions in order", () => {
	const model = shellModel();
	assert.equal(model.kind, "shell-segment");
	assert.deepEqual(decisions(model), ["allow-once", "always-allow", "deny"]);
	assert.deepEqual(
		model.options.map((option) => option.label),
		PROMPT_OPTION_LABELS,
	);
});

// Pins all three shared pairs. One label is also pinned on its own below.
test("every row of the shared table keeps its own decision", () => {
	assert.deepEqual(promptOptions(), [
		{ label: "Allow once", decision: "allow-once" },
		{ label: "Always allow this rule (session)", decision: "always-allow" },
		{ label: "Deny", decision: "deny" },
	]);
});

test("the always-allow option is the exact shared label", () => {
	const model = shellModel();
	const always = model.options.find((option) => option.decision === "always-allow");
	assert.ok(always);
	assert.equal(always.label, "Always allow this rule (session)");
	assert.ok(!always.label.includes(REASON));
	assert.match(always.label, /session/);
});

test("no kind shows an Always allow remembers line", () => {
	const model = shellModel();
	assert.ok(!model.lines.some((line) => line.startsWith("Always allow remembers")));
});

test("a non-bash tool shows the target and the three shared options", () => {
	const model = buildPromptModel({
		toolName: "read",
		probe: "/etc/hosts",
		segment: "/etc/hosts",
		segmentStart: -1,
		reason: "reading system host files",
		isSpanning: false,
	});
	assert.equal(model.kind, "target");
	assert.equal(model.target, "/etc/hosts");
	assert.equal(model.highlight, null);
	assert.deepEqual(decisions(model), ["allow-once", "always-allow", "deny"]);
	const always = model.options.find((option) => option.decision === "always-allow");
	assert.equal(always?.label, "Always allow this rule (session)");
	assert.ok(!always?.label.includes("reading system host files"));
});

// One predicate owns the shell class, so the gate and the prompt cannot drift.
test("one shell predicate decides the prompt kind", () => {
	assert.equal(isShellTool("bash"), true);
	assert.equal(isShellTool("powershell"), true);
	assert.equal(isShellTool("read"), false);
	for (const toolName of ["bash", "powershell"]) {
		const model = buildPromptModel({
			toolName,
			probe: "git status",
			segment: "git status",
			segmentStart: 0,
			reason: REASON,
			isSpanning: false,
		});
		assert.equal(model.kind, "shell-segment");
	}
});

test("a spanning probe shows the spanning note and keeps the three decisions", () => {
	const model = shellModel({
		probe: "foo && bar",
		segment: "foo && bar",
		isSpanning: true,
	});
	assert.equal(model.kind, "shell-spanning");
	assert.equal(model.highlight, null);
	assert.ok(model.lines.some((line) => /spans the whole command/i.test(line)));
	assert.deepEqual(decisions(model), ["allow-once", "always-allow", "deny"]);
});

test("a missing reason falls back without leaking the regex", () => {
	const model = shellModel({ reason: undefined });
	assert.equal(model.remember, "matches a permission rule");
	assert.ok(!JSON.stringify(model).includes(REGEX));
});

test("plainPromptTitle marks the blocked part in the full command", () => {
	const model = shellModel();
	const title = plainPromptTitle(model);
	assert.ok(title.includes('git status && [git commit -m "fix"] && git push'));
	assert.ok(title.includes(`Why: ${REASON}`));
});

// ---------------------------------------------------------------------------
// Renderer: ANSI styling, wrapping, and clipping at real widths.
// ---------------------------------------------------------------------------

/** A theme that tags each color so the direct tests can read the calls. */
function tagTheme(): Theme {
	return {
		fg(color: string, text: string): string {
			return `<${color}>${text}</${color}>`;
		},
		bold(text: string): string {
			return `<b>${text}</b>`;
		},
	} as unknown as Theme;
}

/** A theme with real ANSI codes so pi-tui can measure and clip it. */
const ansiTheme = {
	fg(_color: string, text: string): string {
		return `\x1b[36m${text}\x1b[39m`;
	},
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
} as unknown as Theme;

test("highlightCommand styles only the blocked slice", () => {
	assert.equal(
		highlightCommand(shellModel(), tagTheme()),
		'<text>git status && </text><warning><b>git commit -m "fix"</b></warning><text> && git push</text>',
	);
});

test("highlightCommand returns the plain target when there is no slice", () => {
	const model = shellModel({
		probe: "cd a &&  git commit",
		segment: "cd a && git commit",
		segmentStart: -1,
	});
	assert.equal(highlightCommand(model, tagTheme()), "<text>cd a &&  git commit</text>");
});

test("renderPanel clips every line to width 1", () => {
	const lines = renderPanel(shellModel(), 1, ansiTheme, tui, 0);
	assert.ok(lines.length > 0);
	for (const line of lines) {
		assert.ok(tui.visibleWidth(line) <= 1, `line wider than 1: ${JSON.stringify(line)}`);
	}
});

test("renderPanel fits every line to width 45", () => {
	const lines = renderPanel(shellModel(), 45, ansiTheme, tui, 0);
	assert.ok(lines.length > 0);
	for (const line of lines) {
		assert.equal(tui.visibleWidth(line), 45, `line not 45 wide: ${JSON.stringify(line)}`);
	}
});

test("renderPanel clips every prompt kind to width 1", () => {
	for (const model of everyPromptKind()) {
		for (const line of renderPanel(model, 1, ansiTheme, tui, 0)) {
			assert.ok(tui.visibleWidth(line) <= 1, `line wider than 1: ${JSON.stringify(line)}`);
		}
	}
});

test("renderPanel fits every prompt kind to width 45", () => {
	for (const model of everyPromptKind()) {
		for (const line of renderPanel(model, 45, ansiTheme, tui, 0)) {
			assert.equal(tui.visibleWidth(line), 45, `line not 45 wide: ${JSON.stringify(line)}`);
		}
	}
});

test("the blocked label is stable and never the rule regex", () => {
	assert.equal(blockedLabel("bash", "global", null), "Permission required: bash (global policy)");
	assert.equal(
		blockedLabel("bash", "agent", "orchestrator"),
		"Permission required: bash (orchestrator policy)",
	);
	assert.ok(!blockedLabel("bash", "agent", "orchestrator").includes(REGEX));
});

test("the blocked label appends a human reason that differs from the regex", () => {
	assert.equal(
		blockedLabel("bash", "global", null, "writes git history", REGEX),
		"Permission required: bash (global policy): writes git history",
	);
	assert.equal(
		blockedLabel("bash", "agent", "orchestrator", REASON, REGEX),
		`Permission required: bash (orchestrator policy): ${REASON}`,
	);
});

test("the blocked label drops a reason equal to the regex", () => {
	const label = blockedLabel("bash", "global", null, REGEX, REGEX);
	assert.equal(label, "Permission required: bash (global policy)");
	assert.ok(!label.includes(REGEX));
});

test("the blocked label drops a blank reason", () => {
	assert.equal(
		blockedLabel("bash", "global", null, "   ", REGEX),
		"Permission required: bash (global policy)",
	);
});

test("humanReason drops a blank, unnamed, or regex-equal reason", () => {
	assert.equal(humanReason(REGEX, REGEX), undefined);
	assert.equal(humanReason(`  ${REGEX}  `, REGEX), undefined);
	assert.equal(humanReason(undefined, REGEX), undefined);
	assert.equal(humanReason("   ", REGEX), undefined);
	assert.equal(humanReason("  human text  ", REGEX), "human text");
});

test("renderPanel shows the full command and every choice", () => {
	const text = renderPanel(shellModel(), 60, ansiTheme, tui, 0)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(text.includes('git status && git commit -m "fix" && git push'), `panel must show the full command: ${text}`);
	assert.ok(text.includes("Deny"));
	assert.ok(text.includes("Allow once"));
	assert.ok(text.includes("Always allow this rule (session)"));
});

test("the TUI prompt defaults its cursor to Allow once and Esc denies", async () => {
	const model = shellModel();
	let panel:
		| { render(width: number): string[]; handleInput(data: string): void }
		| undefined;
	let resolveCustom!: () => void;
	const customReady = new Promise<void>((resolve) => {
		resolveCustom = resolve;
	});
	// Drive the real renderPermissionPrompt; capture the panel component it builds.
	const ctx = {
		mode: "tui",
		ui: {
			custom<T>(
				factory: (
					tui: unknown,
					theme: Theme,
					keybindings: unknown,
					done: (choice: T) => void,
				) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					panel = factory(
						{ requestRender(): void {} },
						ansiTheme,
						{},
						(choice: T) => resolve(choice),
					) as typeof panel;
					resolveCustom();
				});
			},
		},
	} as unknown as Parameters<typeof renderPermissionPrompt>[0];

	const answered = renderPermissionPrompt(ctx, model);
	await customReady;
	const component = panel;
	assert.ok(component, "the TUI prompt must build the panel component");
	const plain = component.render(60).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const cursored = plain.split("\n").filter((line) => line.includes("❯"));
	assert.equal(cursored.length, 1, `exactly one row carries the cursor: ${plain}`);
	assert.ok(
		cursored[0].startsWith("│ ❯ Allow once"),
		`the default row must be Allow once, not Deny: ${cursored[0]}`,
	);

	component.handleInput("\x1b"); // Esc
	assert.equal(await answered, "deny");
});

test("pressing Enter on the default TUI prompt allows the call once", async () => {
	const model = shellModel();
	let panel:
		| { render(width: number): string[]; handleInput(data: string): void }
		| undefined;
	let resolveCustom!: () => void;
	const customReady = new Promise<void>((resolve) => {
		resolveCustom = resolve;
	});
	// Drive the real renderPermissionPrompt; capture the panel component it builds.
	const ctx = {
		mode: "tui",
		ui: {
			custom<T>(
				factory: (
					tui: unknown,
					theme: Theme,
					keybindings: unknown,
					done: (choice: T) => void,
				) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					panel = factory(
						{ requestRender(): void {} },
						ansiTheme,
						{},
						(choice: T) => resolve(choice),
					) as typeof panel;
					resolveCustom();
				});
			},
		},
	} as unknown as Parameters<typeof renderPermissionPrompt>[0];

	const answered = renderPermissionPrompt(ctx, model);
	await customReady;
	const component = panel;
	assert.ok(component, "the TUI prompt must build the panel component");

	component.handleInput("\r"); // Enter on the default row
	assert.equal(await answered, "allow-once");
});

// A break leaves the TUI promise pending, so the case must time out red.
test("an abort closes the TUI prompt and denies", { timeout: 2000 }, async () => {
	const model = shellModel();
	let panel:
		| { render(width: number): string[]; handleInput(data: string): void }
		| undefined;
	let resolveCustom!: () => void;
	const customReady = new Promise<void>((resolve) => {
		resolveCustom = resolve;
	});
	const ctx = {
		mode: "tui",
		ui: {
			custom<T>(
				factory: (
					tui: unknown,
					theme: Theme,
					keybindings: unknown,
					done: (choice: T) => void,
				) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					panel = factory(
						{ requestRender(): void {} },
						ansiTheme,
						{},
						(choice: T) => resolve(choice),
					) as typeof panel;
					resolveCustom();
				});
			},
		},
	} as unknown as Parameters<typeof renderPermissionPrompt>[0];

	const controller = new AbortController();
	const answered = renderPermissionPrompt(ctx, model, controller.signal);
	await customReady;
	assert.ok(panel, "the TUI prompt must build the panel component");

	controller.abort();
	assert.equal(await answered, "deny");
});

// A break leaves the select pending, so the bounded race must go red.
test("an abort in a non-TUI mode denies with the select still pending", { timeout: 2000 }, async () => {
	const model = shellModel();
	// The host select never settles: the owner does not answer.
	const pending = new Promise<string | undefined>(() => {});
	let selectCalls = 0;
	const ctx = {
		mode: "rpc",
		ui: {
			select(): Promise<string | undefined> {
				selectCalls += 1;
				return pending;
			},
		},
	} as unknown as Parameters<typeof renderPermissionPrompt>[0];

	const controller = new AbortController();
	const answered = renderPermissionPrompt(ctx, model, controller.signal);
	controller.abort();
	// The host select stays pending; the abort must still deny at once.
	const raced = await Promise.race([
		answered,
		new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 500)),
	]);
	assert.equal(raced, "deny");
	assert.equal(selectCalls, 1, "one host select per ask");
});
