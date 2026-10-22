/**
 * Unit tests for the shared duration and token formatters.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   node --experimental-strip-types --test platforms/pi/extension/duration.test.ts
 *
 * The token boundary matters: a value that would round to 1000k must roll up
 * to M, so `formatTokens` never prints `1000k`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { formatTokens } from "./duration.ts";

test("formatTokens keeps counts under one thousand as plain digits", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
});

test("formatTokens uses one decimal for thousands under ten thousand", () => {
	assert.equal(formatTokens(1_000), "1.0k");
	assert.equal(formatTokens(1_500), "1.5k");
	assert.equal(formatTokens(9_999), "10.0k");
});

test("formatTokens uses whole thousands up to the rounding boundary", () => {
	assert.equal(formatTokens(10_000), "10k");
	assert.equal(formatTokens(12_000), "12k");
	assert.equal(formatTokens(999_000), "999k");
	assert.equal(formatTokens(999_499), "999k");
});

test("formatTokens rolls a value that would round to 1000k up to M", () => {
	assert.equal(formatTokens(999_500), "1.0M");
	assert.equal(formatTokens(999_950), "1.0M");
	assert.equal(formatTokens(999_999), "1.0M");
});

test("formatTokens uses one decimal for millions", () => {
	assert.equal(formatTokens(1_000_000), "1.0M");
	assert.equal(formatTokens(1_500_000), "1.5M");
});
