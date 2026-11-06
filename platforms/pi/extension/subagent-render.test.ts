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
import { formatToolDuration } from "./subagent.ts";
import { resultBodyBlock, resultText } from "./subagent-result.ts";
import {
	captureTool,
	countOccurrences,
	makeDetails,
	makeResult,
	makeSingle,
	render,
	toolCallMessage,
	toolResultMessage,
	zeroUsage,
} from "./subagent-render-fixtures.ts";

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

test("an aborted run prints its error text once in the card", () => {
	const tool = captureTool();
	const failed = makeSingle({ exitCode: 1, stopReason: "aborted", errorMessage: "boom" });
	const result = makeResult(makeDetails("single", [failed]));

	const collapsed = render(tool, result, false, {});
	assert.equal(countOccurrences(collapsed, "boom"), 1, "the collapsed card prints the reason once");
	assert.ok(collapsed.includes("Error: boom"), "the collapsed card keeps the red marker");

	const expanded = render(tool, result, true, {});
	assert.ok(!expanded.includes("Error: boom"), "the expanded card adds no second error line");
	assert.equal(countOccurrences(expanded, "boom"), 1, "the expanded card prints the reason once");
	assert.equal(resultText(failed).error, "boom", "the tree end event carries the real error");
});

// --- a run aborted by the parent -------------------------------------------

test("a run aborted by the parent shows its error once and prints no cap text", () => {
	const tool = captureTool();
	const failed = makeSingle({
		exitCode: 1,
		stopReason: "aborted",
		errorMessage: "stopped by the caller",
		usage: { ...zeroUsage(), turns: 3 },
	});
	const result = makeResult(makeDetails("single", [failed]));

	for (const expanded of [false, true]) {
		const out = render(tool, result, expanded, {});
		assert.equal(
			countOccurrences(out, "stopped by the caller"),
			1,
			`expanded=${expanded} prints the error text once`,
		);
		assert.ok(!out.includes("capped"), `expanded=${expanded} shows no cap line`);
		assert.ok(!out.includes("partial output follows"), `expanded=${expanded} promises no partial text`);
		// The body is the reason, so the card prints no no-output marker.
		assert.ok(!out.includes("(no output)"), `expanded=${expanded} shows the reason as the body`);
	}
});

// --- one error text, one place ----------------------------------------------

test("a failure prints its error text once on every card", () => {
	const tool = captureTool();
	const failed = makeSingle({ exitCode: 1, stopReason: "error", errorMessage: "boom" });
	const single = makeResult(makeDetails("single", [failed]));
	const chain = makeResult(makeDetails("chain", [{ ...failed, step: 1 }]));
	const parallel = makeResult(makeDetails("parallel", [failed]));
	const collapsed: [string, string][] = [
		["single collapsed", render(tool, single, false, {})],
		["chain collapsed", render(tool, chain, false, {})],
		["parallel collapsed", render(tool, parallel, false, {})],
	];
	for (const [name, out] of collapsed) {
		assert.equal(countOccurrences(out, "boom"), 1, `${name} prints the error text once`);
		assert.ok(out.includes("Error: boom"), `${name} keeps the red marker`);
	}
	const expanded: [string, string][] = [
		["single expanded", render(tool, single, true, {})],
		["chain expanded", render(tool, chain, true, {})],
		["parallel expanded", render(tool, parallel, true, {})],
	];
	for (const [name, out] of expanded) {
		assert.equal(countOccurrences(out, "boom"), 1, `${name} prints the error text once`);
	}

	// The tool text reads the shared rule, so the error shows once there too.
	const toolText = resultBodyBlock(failed);
	assert.equal(countOccurrences(toolText, "boom"), 1, "the tool text prints the error once");
	assert.ok(!toolText.includes("capped"), "the tool text carries no cap line");
});

test("the expanded card shows a failed run's reason as its body and adds no error line", () => {
	const tool = captureTool();
	const messageText = "half a turn of output";
	// A failed run's body is its error text, so the reason shows once, as the body.
	const failed = makeSingle({
		exitCode: 1,
		stopReason: "error",
		errorMessage: "provider exploded",
		messages: [{ role: "assistant", content: [{ type: "text", text: messageText }] }],
	});
	assert.equal(resultText(failed).body, resultText(failed).error, "the body is the error text");
	assert.equal(resultText(failed).body, "provider exploded", "the body is the plain message");
	const cards: [string, unknown][] = [
		["single", makeResult(makeDetails("single", [failed]))],
		["chain", makeResult(makeDetails("chain", [{ ...failed, step: 1 }]))],
		["parallel", makeResult(makeDetails("parallel", [failed]))],
	];
	for (const [mode, result] of cards) {
		const out = render(tool, result, true, {});
		assert.equal(countOccurrences(out, "provider exploded"), 1, `${mode} prints the body once`);
		assert.ok(!out.includes(messageText), `${mode} drops the message text, so the reason replaces it`);
	}
});
