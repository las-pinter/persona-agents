/**
 * Tests for the permission-prompt model + the real-gate wire-up.
 *
 * Runs under plain Node (type stripping):
 *   npm test
 *
 * `buildPromptModel` must never carry the rule regex, must show the human
 * reason, must show the full command with the blocked part highlighted, and
 * must keep the same three decisions for every kind. The integration block
 * drives the real `installPermissionGate` handler to prove `permissions.ts`
 * passes the rule's reason (never its regex), runs a spanning "Allow once",
 * remembers a session rule, and fails closed without a UI.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import {
	buildPromptModel,
	herdrBlockedLabel,
	highlightCommand,
	humanReason,
	plainPromptTitle,
	renderPanel,
	type PromptModel,
} from "./permission-prompt.ts";
import { installPermissionGate } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";

const REASON = "orchestrator commit requires user approval";
const REGEX = "(?:^|[;&|(\\n])\\s*git\\s+(push|pull)\\b";
const THREE_LABELS = ["Deny", "Allow once", "Always allow this rule (session)"];

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
	assert.deepEqual(decisions(model), ["deny", "allow-once", "always-allow"]);
	assert.deepEqual(
		model.options.map((option) => option.label),
		THREE_LABELS,
	);
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
	assert.deepEqual(decisions(model), ["deny", "allow-once", "always-allow"]);
	const always = model.options.find((option) => option.decision === "always-allow");
	assert.equal(always?.label, "Always allow this rule (session)");
	assert.ok(!always?.label.includes("reading system host files"));
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
	assert.deepEqual(decisions(model), ["deny", "allow-once", "always-allow"]);
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

test("the herdr label is stable and never the rule regex", () => {
	assert.equal(herdrBlockedLabel("bash", "global", null), "Permission required: bash (global policy)");
	assert.equal(
		herdrBlockedLabel("bash", "agent", "orchestrator"),
		"Permission required: bash (orchestrator policy)",
	);
	assert.ok(!herdrBlockedLabel("bash", "agent", "orchestrator").includes(REGEX));
});

test("the herdr label appends a human reason that differs from the regex", () => {
	assert.equal(
		herdrBlockedLabel("bash", "global", null, "writes git history", REGEX),
		"Permission required: bash (global policy): writes git history",
	);
	assert.equal(
		herdrBlockedLabel("bash", "agent", "orchestrator", REASON, REGEX),
		`Permission required: bash (orchestrator policy): ${REASON}`,
	);
});

test("the herdr label drops a reason equal to the regex", () => {
	const label = herdrBlockedLabel("bash", "global", null, REGEX, REGEX);
	assert.equal(label, "Permission required: bash (global policy)");
	assert.ok(!label.includes(REGEX));
});

test("the herdr label drops a blank reason", () => {
	assert.equal(
		herdrBlockedLabel("bash", "global", null, "   ", REGEX),
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

// ---------------------------------------------------------------------------
// Integration: drive the real gate handler, not a mirror of it.
// `permissions.ts` must hand the rule's human `reason` to the prompt. A
// regression that passes `rule.match` instead would leak the regex into the
// select title and turn this test red.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// An isolated (empty) global permissions file so the repo file cannot interfere.
const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "reason-gate-")),
	"permissions.json",
);
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

type ToolCallContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
};
type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: ToolCallContext,
) => unknown;

/** Install the real gate and return its captured handler plus emitted events. */
function installGate(config: {
	mode: "deny-by-default" | "allow-unless-matched";
	deny?: PermissionRule[];
	ask?: PermissionRule[];
	allow?: PermissionRule[];
}): { handler: ToolCallHandler; events: Array<{ name: string; payload: unknown }> } {
	let captured: ToolCallHandler | null = null;
	const events: Array<{ name: string; payload: unknown }> = [];
	const pi = {
		on(name: string, handler: ToolCallHandler): void {
			if (name === "tool_call") captured = handler;
		},
		events: {
			emit(name: string, payload: unknown): void {
				events.push({ name, payload });
			},
		},
	};
	const agent: AgentConfig = {
		name: "orchestrator",
		description: "integration test agent",
		systemPrompt: "",
		source: "package",
		filePath: "",
		permissions: { mode: config.mode, deny: config.deny, ask: config.ask, allow: config.allow },
	};
	installPermissionGate(pi as unknown as ExtensionAPI, () => agent);
	assert.ok(captured, "the gate must register a tool_call handler");
	return { handler: captured, events };
}

/** A non-TUI context whose selector answers with `answer` and records prompts. */
function selectContext(answer: string | undefined, prompts: string[]): ToolCallContext {
	return {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc", // non-TUI: renderPermissionPrompt uses ctx.ui.select
		ui: {
			async select(title: string): Promise<string | undefined> {
				prompts.push(title);
				return answer;
			},
		},
	};
}

/** A non-TUI context that answers prompts from a queue, one answer per call. */
function selectContextQueue(answers: Array<string | undefined>, prompts: string[]): ToolCallContext {
	let next = 0;
	return {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(title: string): Promise<string | undefined> {
				prompts.push(title);
				const answer = answers[Math.min(next, answers.length - 1)];
				next += 1;
				return answer;
			},
		},
	};
}

test("the real gate prompt title carries the rule reason, not the rule regex", async () => {
	const reason = "orchestrator commit requires user approval";
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason }],
	});

	const prompts: string[] = [];
	let capturedOptions: string[] = [];
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(title: string, options: string[]): Promise<string | undefined> {
				prompts.push(title);
				capturedOptions = options;
				return undefined; // cancel => deny (fail closed)
			},
		},
	};

	await handler({ toolName: "bash", input: { command: "git commit -m tinker" } }, ctx);

	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].includes(reason), `title must show the reason: ${prompts[0]}`);
	assert.ok(!prompts[0].includes(regex), `title must not leak the regex: ${prompts[0]}`);
	assert.deepEqual(capturedOptions, THREE_LABELS);
});

test("the real gate highlights the later occurrence of a repeated segment", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "^git$" }],
		allow: [{ tool: "bash", match: "^git\\b" }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git status && git" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].includes("git status && [git]"), `wrong highlight: ${prompts[0]}`);
});

test("a spanning allow-once runs the command once", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Allow once", prompts);

	const result = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(result, undefined);
	assert.equal(prompts.length, 1);
});

test("a spanning always-allow runs and is remembered", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("a spanning always-allow that covers only part of the command runs once then blocks", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "^foo$" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined, "the first always-allow runs the call now");
	assert.ok(second && typeof second === "object", "the second call must block fail-closed");
	assert.equal((second as { block?: boolean }).block, true);
	assert.equal(prompts.length, 1, "the remembered rule suppresses the spanning ask");
});

test("a target always-allow runs now and is remembered", async () => {
	const { handler } = installGate({
		mode: "allow-unless-matched",
		ask: [{ tool: "read", match: "^/etc/hosts$" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "read", input: { path: "/etc/hosts" } }, ctx);
	const second = await handler({ toolName: "read", input: { path: "/etc/hosts" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("a segment always-allow is remembered", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "^foo\\b" }],
		allow: [{ tool: "bash", match: "^bar\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("headless ask is a hard block with a stable non-regex reason", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: "commit approval" }],
	});
	let selectCalled = false;
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: false,
		mode: "rpc",
		ui: {
			async select(): Promise<string | undefined> {
				selectCalled = true;
				return undefined;
			},
		},
	};

	const result = await handler({ toolName: "bash", input: { command: "git commit -m tinker" } }, ctx);

	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	const reason = (result as { reason?: string }).reason ?? "";
	assert.equal(reason, "Permission required: bash (orchestrator policy): commit approval");
	assert.ok(!reason.includes(regex), `block reason must not leak the regex: ${reason}`);
	assert.equal(selectCalled, false);
});

test("the real gate drops a reason equal to the regex from the prompt title", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: regex }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(!prompts[0].includes(regex), `title must not leak the regex: ${prompts[0]}`);
	assert.ok(
		prompts[0].includes("matches a permission rule"),
		`title must use the fallback: ${prompts[0]}`,
	);
});

test("the herdr event carries the stable label, never the rule regex", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler, events } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: "commit approval" }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	const blocked = events.filter((event) => event.name === "herdr:blocked");
	assert.ok(blocked.length >= 1);
	const active = blocked[0].payload as { active: boolean; label?: string };
	assert.equal(active.active, true);
	assert.equal(active.label, "Permission required: bash (orchestrator policy): commit approval");
	assert.ok(!JSON.stringify(blocked).includes(regex));
});

test("the herdr event drops a reason equal to the regex", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler, events } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: regex }],
	});

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, []),
	);

	const active = events.find(
		(event) => event.name === "herdr:blocked" && (event.payload as { active?: boolean }).active === true,
	);
	assert.ok(active, "the gate must emit an active herdr event");
	const label = (active.payload as { label?: string }).label ?? "";
	assert.equal(label, "Permission required: bash (orchestrator policy)");
	assert.ok(!label.includes(regex), `herdr label leaks the regex: ${label}`);
});

test("a cancel answer denies the call fail-closed", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("an unknown selection denies the call fail-closed", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext("a choice that does not exist", prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("an explicit deny answer blocks the call", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext("Deny", prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("a deny rule wins over an ask rule and never prompts", async () => {
	const regex = "^git\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		deny: [{ tool: "bash", match: regex }],
		ask: [{ tool: "bash", match: regex }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git status" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0, "deny must short-circuit before any prompt");
	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	assert.ok(!JSON.stringify(result).includes(regex), `deny reason leaks the regex: ${JSON.stringify(result)}`);
});

test("a headless spanning ask is a hard block with a non-regex reason", async () => {
	const regex = "foo\\s*&&\\s*bar";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	let selectCalled = false;
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: false,
		mode: "rpc",
		ui: {
			async select(): Promise<string | undefined> {
				selectCalled = true;
				return undefined;
			},
		},
	};

	const result = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	const reason = (result as { reason?: string }).reason ?? "";
	assert.equal(reason, "Permission required: bash (orchestrator policy)");
	assert.ok(!reason.includes(regex), `block reason leaks the regex: ${reason}`);
	assert.equal(selectCalled, false);
});

test("an unnamed reason does not leak the regex into the prompt title", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(!prompts[0].includes(regex), `title leaks the regex: ${prompts[0]}`);
	assert.ok(prompts[0].includes("matches a permission rule"));
});

test("a segment always-allow re-evaluates and prompts for the next blocked segment", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [
			{ tool: "bash", match: "^foo\\b" },
			{ tool: "bash", match: "^baz\\b" },
		],
		allow: [{ tool: "bash", match: "^bar\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContextQueue(["Always allow this rule (session)", "Allow once"], prompts);

	const result = await handler(
		{ toolName: "bash", input: { command: "foo && bar && baz" } },
		ctx,
	);

	assert.equal(result, undefined);
	assert.equal(prompts.length, 2, "the approved foo segment must not hide the baz ask");
	assert.ok(prompts[1].includes("baz"), `the second prompt must show baz: ${prompts[1]}`);
});

test("a folded segment that cannot be sliced uses the Blocked part fallback", async () => {
	const { handler } = installGate({
		mode: "allow-unless-matched",
		ask: [{ tool: "bash", match: "git\\s+commit" }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "cd a &&  git commit" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(
		prompts[0].includes("Blocked part: cd a && git commit"),
		`the fallback line must name the folded segment: ${prompts[0]}`,
	);
	assert.ok(
		!prompts[0].includes("[cd a && git commit]"),
		`a segment that is not a literal slice must not be bracketed: ${prompts[0]}`,
	);
});

test("an empty command is blocked fail-closed under deny-by-default", async () => {
	const { handler } = installGate({ mode: "deny-by-default" });
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0, "an empty command must never prompt");
	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	assert.match((result as { reason?: string }).reason ?? "", /empty command/);
});

test("an empty command runs under allow-unless-matched", async () => {
	const { handler } = installGate({ mode: "allow-unless-matched" });
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0);
	assert.equal(result, undefined);
});
