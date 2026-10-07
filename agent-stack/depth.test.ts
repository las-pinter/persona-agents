/**
 * Offline regression harness for the agent nesting depth core.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   node --experimental-strip-types --test agent-stack/depth.test.ts
 *
 * Covers the plan's depth cases: env parsing, the spawn gate, the parent
 * `--tools` strip, and the refusal at the cap.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	MAX_AGENT_DEPTH,
	canSpawn,
	childDepth,
	childToolArgs,
	depthEnv,
	parseDepth,
	planSpawn,
	stripSpawnTool,
} from "./depth.ts";

// --- env parsing -------------------------------------------------------------

test("parseDepth treats an absent value as 0", () => {
	assert.equal(parseDepth(undefined), 0);
});

test("parseDepth parses a numeric string", () => {
	assert.equal(parseDepth("2"), 2);
});

test("parseDepth treats a non-numeric value as 0", () => {
	assert.equal(parseDepth("x"), 0);
});

test("parseDepth clamps a negative value to 0", () => {
	assert.equal(parseDepth("-1"), 0);
});

// --- spawn gate --------------------------------------------------------------

test("an agent at depth 0 may spawn", () => {
	assert.equal(canSpawn(0), true);
});

test("an agent at depth 1 may spawn", () => {
	assert.equal(canSpawn(1), true);
});

test("an agent at depth 2 may not spawn", () => {
	assert.equal(canSpawn(2), false);
});

test("childDepth adds one", () => {
	assert.equal(childDepth(0), 1);
	assert.equal(childDepth(1), 2);
});

// --- parent --tools strip ----------------------------------------------------

test("stripSpawnTool removes subagent when the child would be at the cap", () => {
	// myDepth 1 -> childDepth 2 -> at the cap.
	assert.deepEqual(stripSpawnTool(["read", "subagent", "bash"], 1), ["read", "bash"]);
});

test("stripSpawnTool keeps subagent below the cap", () => {
	// myDepth 0 -> childDepth 1 -> below the cap.
	assert.deepEqual(stripSpawnTool(["read", "subagent", "bash"], 0), ["read", "subagent", "bash"]);
});

test("stripSpawnTool does not mutate the input", () => {
	const tools = ["read", "subagent"];
	stripSpawnTool(tools, 1);
	assert.deepEqual(tools, ["read", "subagent"]);
});

// --- spawn plan --------------------------------------------------------------

test("planSpawn refuses at the cap and leaves the tools unchanged", () => {
	const tools = ["read", "subagent"];
	const plan = planSpawn(MAX_AGENT_DEPTH, tools);
	assert.equal(plan.allowed, false);
	assert.deepEqual(plan.tools, tools);
});

test("planSpawn permits at depth 0 and keeps subagent", () => {
	const plan = planSpawn(0, ["read", "subagent"]);
	assert.equal(plan.allowed, true);
	assert.equal(plan.childDepth, 1);
	assert.deepEqual(plan.tools, ["read", "subagent"]);
});

test("planSpawn permits at depth 1 and strips subagent for the child", () => {
	const plan = planSpawn(1, ["read", "subagent"]);
	assert.equal(plan.allowed, true);
	assert.equal(plan.childDepth, 2);
	assert.deepEqual(plan.tools, ["read"]);
});

// --- child tool argv ---------------------------------------------------------

test("childToolArgs passes no override for an empty request", () => {
	assert.deepEqual(childToolArgs([], 0), []);
});

test("childToolArgs passes --tools for a kept list", () => {
	assert.deepEqual(childToolArgs(["read"], 0), ["--tools", "read"]);
});

test("childToolArgs keeps subagent below the cap", () => {
	assert.deepEqual(childToolArgs(["subagent"], 0), ["--tools", "subagent"]);
});

test("childToolArgs passes --no-tools when the strip empties the list", () => {
	// myDepth 1 -> childDepth 2 -> at the cap -> subagent is stripped.
	assert.deepEqual(childToolArgs(["subagent"], 1), ["--no-tools"]);
});

// --- env fragment ------------------------------------------------------------

test("depthEnv carries the child depth", () => {
	assert.deepEqual(depthEnv(0), { PI_AGENT_DEPTH: "1" });
	assert.deepEqual(depthEnv(1), { PI_AGENT_DEPTH: "2" });
});
