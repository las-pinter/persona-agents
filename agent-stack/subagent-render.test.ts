/**
 * Offline regression harness for the subagent tool render path.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   npm test -- agent-stack/subagent-render.test.ts
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
import subagentExtension, { formatToolDuration } from "./subagent.ts";

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

test("formatToolDuration renders sub-minute durations with one decimal", () => {
	assert.equal(formatToolDuration(0), "0.0s");
	assert.equal(formatToolDuration(500), "0.5s");
	assert.equal(formatToolDuration(1_500), "1.5s");
	assert.equal(formatToolDuration(59_000), "59.0s");
});

test("formatToolDuration rounds 59.999 seconds up to 60.0s", () => {
	// Parity with pi core: the sub-minute branch uses toFixed(1), so the
	// boundary value 59_999 ms displays as "60.0s" rather than "59.9s".
	assert.equal(formatToolDuration(59_999), "60.0s");
});

test("formatToolDuration renders whole minutes under an hour", () => {
	assert.equal(formatToolDuration(60_000), "1m 0s");
	assert.equal(formatToolDuration(90_000), "1m 30s");
	assert.equal(formatToolDuration(3_599_999), "59m 59s");
});

test("formatToolDuration renders hours, minutes, and seconds", () => {
	assert.equal(formatToolDuration(3_600_000), "1h 0m 0s");
	assert.equal(formatToolDuration(3_661_000), "1h 1m 1s");
});

// --- collapsed headers: run total -------------------------------------------

test("the collapsed single header appends the run total exactly once", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ tester (user) 1.2s");
});

test("the collapsed single header omits the run total when no duration is given", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, {});

	assert.equal(out.split("\n")[0], "✓ tester (user)");
});

test("the collapsed chain header appends the run total exactly once", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha", step: 1 }), makeSingle({ agent: "beta", step: 2 })];
	const out = render(tool, makeResult(makeDetails("chain", results)), false, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ chain 2/2 steps 1.2s");
});

test("the collapsed chain header omits the run total when no duration is given", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha", step: 1 }), makeSingle({ agent: "beta", step: 2 })];
	const out = render(tool, makeResult(makeDetails("chain", results)), false, {});

	assert.equal(out.split("\n")[0], "✓ chain 2/2 steps");
});

test("the collapsed parallel header appends the run total exactly once", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha" }), makeSingle({ agent: "beta" })];
	const out = render(tool, makeResult(makeDetails("parallel", results)), false, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ parallel 2/2 tasks 1.2s");
});

test("the collapsed parallel header omits the run total when no duration is given", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha" }), makeSingle({ agent: "beta" })];
	const out = render(tool, makeResult(makeDetails("parallel", results)), false, {});

	assert.equal(out.split("\n")[0], "✓ parallel 2/2 tasks");
});

// --- expanded headers: run total --------------------------------------------

test("the expanded single header appends the run total exactly once", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), true, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ tester (user) 1.2s");
});

test("the expanded chain header appends the run total exactly once", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha", step: 1 }), makeSingle({ agent: "beta", step: 2 })];
	const out = render(tool, makeResult(makeDetails("chain", results)), true, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ chain 2/2 steps 1.2s");
});

test("the expanded parallel header appends the run total exactly once", () => {
	const tool = captureTool();
	const results = [makeSingle({ agent: "alpha" }), makeSingle({ agent: "beta" })];
	const out = render(tool, makeResult(makeDetails("parallel", results)), true, { durationMs: 1_200 });

	assert.equal(countOccurrences(out, "1.2s"), 1);
	assert.equal(out.split("\n")[0], "✓ parallel 2/2 tasks 1.2s");
});

// --- non-finite run totals must render nothing -------------------------------

test("a non-finite run total renders no header suffix", () => {
	const tool = captureTool();
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), false, { durationMs: bad });
		assert.equal(out.split("\n")[0], "✓ tester (user)", `durationMs=${bad}`);
	}
});

test("the expanded single header omits the run total when no duration is given", () => {
	const tool = captureTool();
	const out = render(tool, makeResult(makeDetails("single", [makeSingle()])), true, { durationMs: undefined });
	assert.equal(out.split("\n")[0], "✓ tester (user)");
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
