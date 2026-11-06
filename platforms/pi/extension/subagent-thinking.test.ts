/**
 * Regression tests for the subagent thinking path.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   npm test -- platforms/pi/extension/subagent-thinking.test.ts
 *
 * Covers the pure thinking reducer, the repaint policy, the indicator text,
 * and the thinking line of the inline block.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	formatThinkingIndicator,
	INITIAL_THINKING,
	makeThinkingEventHandler,
	reduceThinking,
	type ThinkingState,
} from "./subagent.ts";
import { captureTool, makeDetails, makeResult, makeSingle, render } from "./subagent-render-fixtures.ts";

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
