/**
 * Offline regression harness for the subagent tool render path.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   npm test -- platforms/pi/extension/subagent-render.test.ts
 *
 * Covers the inline subagent block duration feature: `formatToolDuration`
 * boundaries, the per-run TOTAL in every collapsed and expanded header, and
 * the per-command `durationMs` pairing on inner tool lines.
 *
 * The extension is registered against a fake pi that captures the tool
 * definition, then `renderResult` is driven directly with hand-built details.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentExtension, {
	formatThinkingIndicator,
	formatToolDuration,
	INITIAL_THINKING,
	makeThinkingEventHandler,
	reduceThinking,
	toInspectTask,
	type SingleResult,
	type ThinkingState,
} from "./subagent.ts";
import { archiveRun, getRuns, registerInspectorCommands } from "./inspector.ts";

// --- harness -----------------------------------------------------------------

interface Renderable {
	render(width: number): string[];
}

interface FakeTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface CapturedTool {
	renderResult: (
		result: unknown,
		options: { expanded: boolean },
		theme: FakeTheme,
		context: unknown,
	) => Renderable;
}

const THEME: FakeTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Register the extension against a fake pi and return the captured tool. */
function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool: (tool: CapturedTool) => {
			captured = tool;
		},
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	if (!captured) throw new Error("subagent extension did not register a tool");
	return captured;
}

/** Drive `renderResult` and flatten the component to plain text lines. */
function render(tool: CapturedTool, result: unknown, expanded: boolean, context: unknown = {}): string {
	return tool
		.renderResult(result, { expanded }, THEME, context)
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// --- fixtures ----------------------------------------------------------------

function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function makeSingle(overrides: Record<string, unknown> = {}) {
	return {
		agent: "tester",
		agentSource: "user" as const,
		task: "do the thing",
		exitCode: 0,
		messages: [] as unknown[],
		stderr: "",
		usage: zeroUsage(),
		...overrides,
	};
}

function makeDetails(mode: "single" | "chain" | "parallel", results: unknown[]) {
	return { mode, agentScope: "user", projectAgentsDir: null, results };
}

function makeResult(details: unknown, text = "done") {
	return { content: [{ type: "text", text }], details };
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>) {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

function toolResultMessage(toolCallId: string, durationMs?: number) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [],
		isError: false,
		timestamp: 0,
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

// --- formatToolDuration boundaries ------------------------------------------

test("formatToolDuration switches unit at each boundary", () => {
	const cases: Array<[number, string]> = [
		[0, "0ms"],
		[999, "999ms"],
		// 999.6 ms must not round into a "1000ms" label; it crosses to seconds.
		[999.6, "1.0s"],
		[1_500, "1.5s"],
		// Parity with pi core: toFixed(1) rounds 59_999 ms up to "60.0s".
		[59_999, "60.0s"],
		[60_000, "1m 0s"],
		[3_599_999, "59m 59s"],
		[1_000, "1.0s"],
		[90_000, "1m 30s"],
		[3_600_000, "1h 0m 0s"],
		[3_661_000, "1h 1m 1s"],
	];
	for (const [ms, label] of cases) assert.equal(formatToolDuration(ms), label, String(ms));
});

// --- headers: run total ------------------------------------------------------

test("every collapsed and expanded header appends the run total once and omits it without a duration", () => {
	const tool = captureTool();
	const pair = [makeSingle({ agent: "alpha", step: 1 }), makeSingle({ agent: "beta", step: 2 })];
	const modes: Array<["single" | "chain" | "parallel", unknown[], string]> = [
		["single", [makeSingle()], "✓ tester (user)"],
		["chain", pair, "✓ chain 2/2 steps"],
		["parallel", pair, "✓ parallel 2/2 tasks"],
	];
	for (const [mode, results, label] of modes) {
		for (const expanded of [false, true]) {
			const result = makeResult(makeDetails(mode, results));
			const withTotal = render(tool, result, expanded, { durationMs: 1_200 });
			assert.equal(countOccurrences(withTotal, "1.2s"), 1, `${mode} expanded=${expanded}`);
			assert.equal(withTotal.split("\n")[0], `${label} 1.2s`);
			const without = render(tool, result, expanded, {});
			assert.equal(without.split("\n")[0], label, `${mode} expanded=${expanded} has no suffix`);
		}
	}
});

// --- non-finite run totals must render nothing -------------------------------

test("a non-finite run total renders no header suffix", () => {
	const tool = captureTool();
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, { durationMs: bad });
		assert.equal(out.split("\n")[0], "✓ tester (user)", `durationMs=${bad}`);
	}
});

// --- per-command durations on inner tool lines -------------------------------

test("an inner tool line shows the paired command duration", () => {
	const tool = captureTool();
	const messages = [toolCallMessage("t1", "bash", { command: "ls" }), toolResultMessage("t1", 1_500)];
	const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), false, {});

	assert.equal(countOccurrences(out, "1.5s"), 1);
	assert.ok(out.split("\n").some((line) => line === "→ $ ls  1.5s"));
});

test("inner tool lines pair durations by toolCallId, not by position", () => {
	const tool = captureTool();
	const messages = [
		toolCallMessage("t1", "bash", { command: "first" }),
		toolCallMessage("t2", "bash", { command: "second" }),
		toolResultMessage("t2", 2_000),
		toolResultMessage("t1", 1_000),
	];
	const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), false, {});

	const first = out.split("\n").find((line) => line.includes("first"));
	const second = out.split("\n").find((line) => line.includes("second"));
	assert.ok(first?.includes("1.0s"), "the first call takes the t1 duration");
	assert.ok(!first?.includes("2.0s"), "the first call must not take the t2 duration");
	assert.ok(second?.includes("2.0s"), "the second call takes the t2 duration");
	assert.ok(!second?.includes("1.0s"), "the second call must not take the t1 duration");
});

test("a tool result with no matching tool call leaves the command duration blank", () => {
	const tool = captureTool();
	const messages = [toolCallMessage("t1", "bash", { command: "lonely" }), toolResultMessage("other", 1_500)];
	const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), false, {});

	const line = out.split("\n").find((candidate) => candidate.includes("lonely"));
	assert.equal(line?.trimEnd(), "→ $ lonely");
});

test("a matching tool result without a duration renders no suffix", () => {
	const tool = captureTool();
	const messages = [toolCallMessage("t1", "bash", { command: "quiet" }), toolResultMessage("t1")];
	const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), false, {});

	const line = out.split("\n").find((candidate) => candidate.includes("quiet"));
	assert.equal(line, "→ $ quiet");
});

test("a non-finite command duration renders no suffix", () => {
	const tool = captureTool();
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const messages = [toolCallMessage("t1", "bash", { command: "risky" }), toolResultMessage("t1", bad)];
		const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), false, {});
		const line = out.split("\n").find((candidate) => candidate.includes("risky"));
		assert.equal(line?.trimEnd(), "→ $ risky", `durationMs=${bad}`);
	}
});

test("an expanded single block shows the paired command duration", () => {
	const tool = captureTool();
	const messages = [toolCallMessage("t1", "read", { file_path: "/tmp/x.ts" }), toolResultMessage("t1", 2_500)];
	const out = render(tool, makeResult(makeDetails("single", [makeSingle({ messages })])), true, {});

	const line = out.split("\n").find((candidate) => candidate.includes("read "));
	assert.ok(line?.includes("2.5s"), "the expanded tool line must show the duration");
});

// --- stop reason vs run total ordering (characterization) --------------------

test("the single run total and stop reason render duration-first in both collapsed and expanded", () => {
	const tool = captureTool();
	const failed = makeSingle({ exitCode: 1, stopReason: "aborted", errorMessage: "boom" });
	const result = makeResult(makeDetails("single", [failed]));

	const collapsed = render(tool, result, false, { durationMs: 1_200 }).split("\n")[0];
	const expanded = render(tool, result, true, { durationMs: 1_200 }).split("\n")[0];

	// Both views share one order: duration first, then the stop reason.
	assert.equal(collapsed, "✗ tester (user) 1.2s [aborted]");
	assert.equal(expanded, "✗ tester (user) 1.2s [aborted]");
});

// --- thinking reducer (pure) -------------------------------------------------

test("reduceThinking folds a thinking stretch into the run total", () => {
	let state: ThinkingState = { ...INITIAL_THINKING };
	state = reduceThinking(state, "thinking_start", 1_000);
	assert.equal(state.thinking, true);
	assert.equal(state.thinkingStartedAt, 1_000);

	state = reduceThinking(state, "thinking_delta", 1_500);
	assert.equal(state.thinking, true);

	state = reduceThinking(state, "thinking_end", 2_200);
	assert.equal(state.thinking, false);
	assert.equal(state.thinkingStartedAt, null);
	assert.equal(state.thinkingMs, 1_200);
});

test("reduceThinking keeps per-run state independent across runs", () => {
	let a: ThinkingState = { ...INITIAL_THINKING };
	let b: ThinkingState = { ...INITIAL_THINKING };
	a = reduceThinking(a, "thinking_start", 1_000);
	b = reduceThinking(b, "thinking_start", 5_000);
	a = reduceThinking(a, "thinking_end", 3_000);
	assert.equal(a.thinkingMs, 2_000);
	assert.equal(b.thinkingMs, 0);
	assert.equal(b.thinking, true);
});

test("reduceThinking ignores an end with no open stretch", () => {
	const state = reduceThinking(INITIAL_THINKING, "thinking_end", 1_000);
	assert.equal(state.thinkingMs, 0);
	assert.equal(state.thinking, false);
});

test("reduceThinking opens a stretch on a lone delta", () => {
	const state = reduceThinking(INITIAL_THINKING, "thinking_delta", 800);
	assert.equal(state.thinking, true);
	assert.equal(state.thinkingStartedAt, 800);
});

// --- thinking emit policy ----------------------------------------------------

test("a thinking_delta does not trigger a repaint", () => {
	let state: ThinkingState = { ...INITIAL_THINKING };
	let emits = 0;
	const handler = makeThinkingEventHandler(
		() => state,
		(next) => {
			state = next;
		},
		() => {
			emits++;
		},
		() => 1_000,
	);

	handler("thinking_start");
	assert.equal(emits, 1);

	handler("thinking_delta");
	handler("thinking_delta");
	assert.equal(emits, 1, "deltas must not repaint; the run ticker covers them");
	assert.equal(state.thinking, true);

	handler("thinking_end");
	assert.equal(emits, 2, "end must repaint once");
	assert.equal(state.thinking, false);
});

// --- thinking indicator ------------------------------------------------------

test("formatThinkingIndicator shows the live elapsed while thinking", () => {
	const out = formatThinkingIndicator({ thinking: true, thinkingStartedAt: 1_000, thinkingMs: 0 }, undefined, 1_500);
	assert.equal(out, "🧠 thinking… 500ms");
});

test("formatThinkingIndicator keeps the prior total beside the live line", () => {
	const out = formatThinkingIndicator({ thinking: true, thinkingStartedAt: 2_000, thinkingMs: 500 }, undefined, 2_500);
	assert.equal(out, "🧠 thinking… 1.0s\n🧠 think 500ms");
});

test("formatThinkingIndicator shows the total and reasoning count after thinking", () => {
	const out = formatThinkingIndicator({ thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 }, 500, 9_999);
	assert.equal(out, "🧠 think 1.2s · 500 reasoning");
});

test("formatThinkingIndicator omits reasoning when the count is zero", () => {
	const out = formatThinkingIndicator({ thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 }, 0, 9_999);
	assert.equal(out, "🧠 think 1.2s");
});

test("formatThinkingIndicator returns null when no thinking happened", () => {
	assert.equal(formatThinkingIndicator(INITIAL_THINKING, undefined, 0), null);
	assert.equal(formatThinkingIndicator(undefined, undefined, 0), null);
	assert.equal(formatThinkingIndicator(undefined, 0, 0), null);
});

test("formatThinkingIndicator shows the count when only reasoning tokens exist", () => {
	const out = formatThinkingIndicator(undefined, 500, 0);
	assert.equal(out, "🧠 think 0ms · 500 reasoning");
});

// --- thinking indicator in the inline block ---------------------------------

test("a single block renders the thinking total and reasoning count", () => {
	const tool = captureTool();
	const result = makeSingle({
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 },
		reasoningTokens: 500,
	});
	const out = render(tool, makeResult(makeDetails("single", [result])), false, {});
	assert.ok(out.includes("🧠 think 1.2s"), out);
	assert.ok(out.includes("500 reasoning"), out);
});

test("a result without thinking fields renders no thinking line", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, {});
	assert.ok(!out.includes("🧠"), out);
});

test("an active thinking run renders the live indicator", () => {
	const tool = captureTool();
	const result = makeSingle({ thinking: { thinking: true, thinkingStartedAt: 1_000, thinkingMs: 0 } });
	const out = render(tool, makeResult(makeDetails("single", [result])), false, { now: 1_500 });
	assert.ok(out.includes("🧠 thinking… 500ms"), out);
});

test("a running result shows the live elapsed in the header", () => {
	const tool = captureTool();
	const result = makeSingle({ exitCode: -1, runStartedAt: 2_500 });
	const out = render(tool, makeResult(makeDetails("single", [result])), false, { now: 5_000 });
	assert.equal(out.split("\n")[0], "⏳ tester (user) · ⏱ 2.5s");
});

test("a finished result shows no live elapsed", () => {
	const tool = captureTool();
	const result = makeSingle({ exitCode: 0, runStartedAt: 2_500 });
	const out = render(tool, makeResult(makeDetails("single", [result])), false, { now: 5_000 });
	assert.ok(!out.includes("⏱"), out);
});

test("a queued parallel task with no start time shows no live elapsed", () => {
	const tool = captureTool();
	// A queued task has no runStartedAt yet; only the running task shows ⏱.
	const running = makeSingle({ agent: "alpha", exitCode: -1, runStartedAt: 2_500 });
	const queued = makeSingle({ agent: "beta", exitCode: -1 });
	const out = render(tool, makeResult(makeDetails("parallel", [running, queued])), false, { now: 5_000 });
	const alphaLine = out.split("\n").find((line) => line.includes("alpha"));
	const betaLine = out.split("\n").find((line) => line.includes("beta"));
	assert.ok(alphaLine?.includes("⏱"), out);
	assert.ok(!betaLine?.includes("⏱"), out);
});

test("a running single block with no output shows (running...)", () => {
	const tool = captureTool();
	const result = makeSingle({ exitCode: -1, runStartedAt: 5_000 });
	const out = render(tool, makeResult(makeDetails("single", [result])), false, { now: 5_000 });
	assert.ok(out.includes("(running...)"), out);
	assert.ok(!out.includes("(no output)"), out);
});

test("a finished single block with no output shows (no output)", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, {});
	assert.ok(out.includes("(no output)"), out);
});

test("a block never renders raw thinking text", () => {
	const tool = captureTool();
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-REASONING-TEXT" }] };
	const result = makeSingle({
		messages: [message],
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 10 },
	});
	const out = render(tool, makeResult(makeDetails("single", [result])), true, {});
	assert.ok(!out.includes("SECRET-REASONING-TEXT"), out);
	assert.ok(out.includes("🧠 think"), out);
});

// --- archive carries the thinking fields ------------------------------------

interface CapturedCommand {
	handler: (args: string, ctx: unknown) => unknown;
}

function captureCommands(): Map<string, CapturedCommand> {
	const commands = new Map<string, CapturedCommand>();
	const pi = {
		registerCommand: (name: string, def: CapturedCommand) => {
			commands.set(name, def);
		},
	};
	registerInspectorCommands(pi as unknown as ExtensionAPI);
	return commands;
}

test("archiveRun stores the thinking fields and /runs shows them", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 },
			reasoningTokens: 500,
		}) as unknown as SingleResult,
	);
	archiveRun({ at: "2024-01-01T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });
	const last = getRuns().at(-1);
	assert.equal(last?.results[0].thinkingMs, 1_200);
	assert.equal(last?.results[0].reasoningTokens, 500);

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	assert.ok(notified.includes("🧠 1.2s"), notified);
	assert.ok(notified.includes("500 reasoning"), notified);
});

test("the inspector detail shows the thinking summary", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 3_400 },
			reasoningTokens: 25,
		}) as unknown as SingleResult,
	);
	archiveRun({ at: "2024-01-02T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let component: { render(width: number): string[] } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) => {
				component = factory({}, {}, {}, () => {}) as { render(width: number): string[] };
			},
		},
	};
	await commands.get("inspect")?.handler("last", ctx);
	const lines = component?.render(200).join("\n") ?? "";
	assert.ok(lines.includes("🧠 3.4s"), lines);
	assert.ok(lines.includes("25 reasoning"), lines);
});

test("the inspector formats reasoning tokens like the inline block", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 },
			reasoningTokens: 1_500,
		}) as unknown as SingleResult,
	);
	archiveRun({ at: "2024-01-03T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	assert.ok(notified.includes("1.5k reasoning"), notified);
});

test("the inspector omits reasoning when the count is zero", async () => {
	const task = toInspectTask(
		makeSingle({ thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 } }) as unknown as SingleResult,
	);
	archiveRun({ at: "2024-01-05T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	const line = notified.split("\n").find((candidate) => candidate.includes("2024-01-05")) ?? "";
	assert.ok(line.includes("🧠 1.2s"), notified);
	assert.ok(!line.includes("reasoning"), line);
});

test("an old archive record without thinking fields renders without them", async () => {
	// A record written before the thinking fields existed must not crash.
	const oldTask = {
		agent: "tester",
		status: "done" as const,
		task: "old run",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
	};
	archiveRun({ at: "2024-01-06T00:00:00.000Z", mode: "single", agentScope: "user", results: [oldTask] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	const line = notified.split("\n").find((candidate) => candidate.includes("2024-01-06")) ?? "";
	assert.ok(line.includes("tester"), notified);
	assert.ok(!line.includes("🧠"), line);
});
