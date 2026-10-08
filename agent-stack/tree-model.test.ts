/**
 * Offline regression harness for the pure agent tree model.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   npm run test:permissions -- agent-stack/tree-model.test.ts
 *
 * Covers the plan's Task 19 tree-model cases: two-level trees, order
 * independence, the root node, orphans, staleness, and independent logs.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { assembleTree, findNode, flattenTree } from "./tree-model.ts";
import type { RunEvent } from "./tree-log.ts";

const T0 = 1_700_000_000_000;

function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function makeEvent(overrides: Partial<RunEvent> & Pick<RunEvent, "runId" | "type">): RunEvent {
	return {
		v: 1,
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running",
		at: at(0),
		...overrides,
	};
}

function twoLevelEvents(): RunEvent[] {
	return [
		makeEvent({ runId: "root", type: "start", at: at(0) }),
		makeEvent({ runId: "child", type: "start", parentRunId: "root", depth: 1, at: at(10) }),
		makeEvent({ runId: "child", type: "end", parentRunId: "root", depth: 1, at: at(20), status: "done" }),
		makeEvent({ runId: "root", type: "end", at: at(30), status: "done" }),
	];
}

test("start/end pairs give a two-level tree", () => {
	const roots = assembleTree(twoLevelEvents(), T0 + 100, 1000);
	assert.equal(roots.length, 1);
	assert.equal(roots[0]?.runId, "root");
	assert.equal(roots[0]?.status, "done");
	assert.equal(roots[0]?.children.length, 1);
	assert.equal(roots[0]?.children[0]?.runId, "child");
	assert.equal(roots[0]?.children[0]?.status, "done");
	assert.equal(roots[0]?.children[0]?.endedAt, at(20));
});

test("out-of-order records assemble the same tree", () => {
	const inOrder = assembleTree(twoLevelEvents(), T0 + 100, 1000);
	const reversed = assembleTree([...twoLevelEvents()].reverse(), T0 + 100, 1000);
	assert.deepEqual(reversed, inOrder);
});

test("the root event is the top node", () => {
	const roots = assembleTree(twoLevelEvents(), T0 + 100, 1000);
	assert.equal(roots[0]?.parentRunId, null);
	assert.equal(roots[0]?.depth, 0);
	assert.equal(roots[0]?.orphan, false);
});

test("a parent-missing record is orphan and attached at top level", () => {
	const events = [
		makeEvent({ runId: "root", type: "start", at: at(0) }),
		makeEvent({ runId: "lost", type: "start", parentRunId: "ghost", depth: 1, at: at(10) }),
	];
	const roots = assembleTree(events, T0 + 100, 1000);
	assert.equal(roots.length, 2);
	const orphan = findNode(roots, "lost");
	assert.ok(orphan);
	assert.equal(orphan?.orphan, true);
	assert.equal(orphan?.parentRunId, "ghost");
});

test("a start with no end past staleMs is stale", () => {
	const events = [makeEvent({ runId: "slow", type: "start", at: at(0) })];
	const roots = assembleTree(events, T0 + 60_000, 1000);
	assert.equal(roots[0]?.status, "stale");
	assert.equal(roots[0]?.endedAt, null);
});

test("a running start within staleMs is not stale", () => {
	const events = [makeEvent({ runId: "fresh", type: "start", at: at(0) })];
	const roots = assembleTree(events, T0 + 500, 1000);
	assert.equal(roots[0]?.status, "running");
});

test("an idle root stays idle past staleMs", () => {
	const events = [makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) })];
	const roots = assembleTree(events, T0 + 10 * 60_000, 1000);
	assert.equal(roots[0]?.status, "idle");
});

test("a fresh running update keeps an old root from going stale", () => {
	const events = [
		makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) }),
		makeEvent({ runId: "root", type: "update", status: "running", at: at(310_000) }),
	];
	const roots = assembleTree(events, T0 + 311_000, 300_000);
	assert.equal(roots[0]?.status, "running");
});

test("an old running update with no recent record is stale", () => {
	const events = [
		makeEvent({ runId: "slow", type: "start", at: at(0) }),
		makeEvent({ runId: "slow", type: "update", status: "running", at: at(10_000) }),
	];
	const roots = assembleTree(events, T0 + 600_000, 300_000);
	assert.equal(roots[0]?.status, "stale");
});

test("an idle node older than staleMs stays idle", () => {
	const events = [makeEvent({ runId: "idler", type: "start", status: "idle", at: at(0) })];
	const roots = assembleTree(events, T0 + 600_000, 300_000);
	assert.equal(roots[0]?.status, "idle");
});

test("a root update folds running, then a later update folds idle", () => {
	const running = assembleTree(
		[
			makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) }),
			makeEvent({ runId: "root", type: "update", status: "running", at: at(10) }),
		],
		T0 + 500,
		1000,
	);
	assert.equal(running[0]?.status, "running");

	const idleAgain = assembleTree(
		[
			makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) }),
			makeEvent({ runId: "root", type: "update", status: "running", at: at(10) }),
			makeEvent({ runId: "root", type: "update", status: "idle", at: at(20) }),
		],
		T0 + 10 * 60_000,
		1000,
	);
	assert.equal(idleAgain[0]?.status, "idle");
});

test("a root end makes the idle root done", () => {
	const events = [
		makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) }),
		makeEvent({ runId: "root", type: "end", status: "done", at: at(30) }),
	];
	const roots = assembleTree(events, T0 + 60_000, 1000);
	assert.equal(roots[0]?.status, "done");
});

test("a start after an end still folds done", () => {
	// Current behavior: any `end` record pins the run to done, and a later
	// `start` does not revive it. This documents the fold that made a stale root
	// `end` fatal before the shutdown fix: a second `/reload` re-appends the
	// root `start`, but the node stays done.
	const events = [
		makeEvent({ runId: "root", type: "start", status: "idle", at: at(0) }),
		makeEvent({ runId: "root", type: "end", status: "done", at: at(10) }),
		makeEvent({ runId: "root", type: "start", status: "idle", at: at(20) }),
	];
	const roots = assembleTree(events, T0 + 100, 1000);
	assert.equal(roots[0]?.status, "done");
});

test("a failed end gives status failed", () => {
	const events = [
		makeEvent({ runId: "bad", type: "start", at: at(0) }),
		makeEvent({ runId: "bad", type: "end", at: at(10), status: "failed", exitCode: 1, error: "boom" }),
	];
	const roots = assembleTree(events, T0 + 100, 1000);
	assert.equal(roots[0]?.status, "failed");
	assert.equal(roots[0]?.exitCode, 1);
	assert.equal(roots[0]?.error, "boom");
});

test("a self-parent record is treated as an orphan at top level", () => {
	const events = [
		makeEvent({ runId: "self", type: "start", parentRunId: "self", depth: 1, at: at(0) }),
		makeEvent({ runId: "self", type: "end", parentRunId: "self", depth: 1, at: at(10), status: "done" }),
	];
	const roots = assembleTree(events, T0 + 100, 1000);
	assert.equal(roots.length, 1);
	assert.equal(roots[0]?.runId, "self");
	assert.equal(roots[0]?.orphan, true);
	assert.equal(roots[0]?.children.length, 0);
});

test("a parent cycle attaches every cycle node at top level", () => {
	const events = [
		makeEvent({ runId: "a", type: "start", parentRunId: "b", depth: 1, at: at(0) }),
		makeEvent({ runId: "b", type: "start", parentRunId: "a", depth: 1, at: at(10) }),
	];
	const roots = assembleTree(events, T0 + 100, 1000);
	assert.equal(roots.length, 2);
	const a = findNode(roots, "a");
	const b = findNode(roots, "b");
	assert.equal(a?.orphan, true);
	assert.equal(b?.orphan, true);
	assert.equal(a?.children.length, 0);
	assert.equal(b?.children.length, 0);
});

test("flattenTree visits parents before children", () => {
	const roots = assembleTree(twoLevelEvents(), T0 + 100, 1000);
	assert.deepEqual(
		flattenTree(roots).map((node) => node.runId),
		["root", "child"],
	);
});

test("two independent event lists give two independent trees", () => {
	const rootsA = assembleTree(twoLevelEvents(), T0 + 100, 1000);
	const rootsB = assembleTree(
		[
			makeEvent({ runId: "root-b", type: "start", at: at(0), agent: "planner" }),
			makeEvent({ runId: "root-b", type: "end", at: at(10), status: "done" }),
		],
		T0 + 100,
		1000,
	);

	assert.equal(rootsA[0]?.runId, "root");
	assert.equal(rootsB[0]?.runId, "root-b");
	assert.notEqual(rootsA[0], rootsB[0]);
	assert.equal(findNode(rootsA, "root-b"), undefined);
});
