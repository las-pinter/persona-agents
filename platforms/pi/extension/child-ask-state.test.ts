/**
 * Child ask state tests: the minted ask id is unique within one session.
 *
 * The clock is frozen, so only the per-session counter can tell two asks apart.
 * The tally is the real one, so the record fold is proved too.
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/child-ask-state.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createAskTally, recordAskLine } from "./ask-record.ts";
import { newRequest, type GateRequest } from "./child-ask-state.ts";
import type { PromptModel } from "./permission-prompt.ts";

/** The session both asks belong to. */
const SESSION = "session-one";

/** The prompt model of one child ask. Plain data only. */
const MODEL: PromptModel = {
	title: "Child ask",
	toolName: "bash",
	kind: "shell-segment",
	target: "ls",
	lines: [],
	highlight: null,
	remember: "a test rule",
	options: [],
};

/** One request for the session, resolved by nothing. */
function request(): GateRequest {
	return newRequest(
		{
			sessionId: SESSION,
			role: "implementer",
			toolName: "bash",
			key: "bash:ls",
			model: MODEL,
			remember: () => {},
		},
		() => {},
	);
}

test("two asks in one frozen millisecond carry two ids and count as two", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00.000Z") });

	const first = request();
	const second = request();
	assert.ok(first.askId, "the first ask carries an id");
	assert.ok(second.askId, "the second ask carries an id");
	assert.notEqual(first.askId, second.askId, "two asks in one millisecond carry two ids");
	assert.ok(first.askId.startsWith(`${SESSION}#`), "the id still leads with the session");

	// Both ids share one stamp, so a stamp-only id would fold them as one ask.
	const stamp = new Date().toISOString();
	const tally = createAskTally();
	for (const askId of [first.askId, second.askId]) {
		tally.observe(
			recordAskLine({
				tool: "bash",
				role: "implementer",
				verdict: "pending",
				runId: SESSION,
				depth: 1,
				at: stamp,
				askId,
				phase: "arrival",
				flags: "waiting=0 shown=none place=queue",
			}),
		);
	}
	assert.equal(tally.usage().bash, 2, "both asks count, so the tally holds two");
});
