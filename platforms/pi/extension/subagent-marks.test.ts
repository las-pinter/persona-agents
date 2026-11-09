/**
 * Unit tests for the shared round and resume mark rule.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   node --experimental-strip-types --test platforms/pi/extension/subagent-marks.test.ts
 *
 * The space guard matters: a resume mark with no round must not touch the text
 * before it, so both surfaces place the glyph the same way.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { roundMark } from "./subagent-marks.ts";

test("a round mark takes one leading space", () => {
	assert.equal(roundMark({ round: 1 }), " r1");
	assert.equal(roundMark({ round: 12 }), " r12");
});

test("a round mark joins the resume glyph with no space", () => {
	assert.equal(roundMark({ round: 2, resumed: true }), " r2↺");
});

test("a resume mark with no round takes its own leading space", () => {
	assert.equal(roundMark({ resumed: true }), " ↺");
});

test("a source with no round and no resume gives no mark text", () => {
	assert.equal(roundMark({}), "");
	assert.equal(roundMark({ resumed: false }), "");
	assert.equal(roundMark({ round: undefined, resumed: undefined }), "");
});
