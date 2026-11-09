/**
 * Selection walk tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/tree-selection.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { selectNext, selectPrev } from "./tree-selection.ts";

test("selectNext and selectPrev wrap, fall back on an unknown id, and tolerate an empty list", () => {
	assert.equal(selectNext(["a", "b", "c"], "c"), "a");
	assert.equal(selectPrev(["a", "b", "c"], "a"), "c");
	assert.equal(selectNext(["a", "b"], "zzz"), "a");
	assert.equal(selectPrev(["a", "b", "c"], "zzz"), "c");
	assert.equal(selectNext(["a"], "a"), "a");
	assert.equal(selectPrev(["a"], "a"), "a");
	assert.equal(selectNext([], null), null);
	assert.equal(selectPrev([], "x"), "x");
});
