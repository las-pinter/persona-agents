/**
 * Offline harness for the in-memory run registry.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   node --experimental-strip-types --test platforms/pi/extension/run-registry.test.ts
 *
 * One block per acceptance item: record shape, key lookup, parent walk, depth,
 * and sweep eligibility. The clock is a fixed constant, so no case can flake.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MAX_AGENT_DEPTH } from "./depth.ts";
import { RUN_RETENTION_MS, MAX_WALK_STEPS, UNKNOWN_RUN_REASON, UNKNOWN_RUN_ROLE, RunRegistry, newRunRecord } from "./run-registry.ts";
import type { RunRecord, RunStart } from "./run-registry.ts";

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A record with the common fields filled. A case overrides what it tests. */
function record(sessionId: string, extra: Partial<RunStart> = {}): RunRecord {
	return newRunRecord({
		sessionId,
		role: "implementer",
		class: "worker",
		source: "package",
		skills: [],
		alwaysLoad: [],
		depth: 0,
		parentSessionId: null,
		sessionFile: `/tmp/${sessionId}.json`,
		startedAt: T0,
		...extra,
	});
}

/** A registry holding the given records. */
function registryOf(...records: RunRecord[]): RunRegistry {
	const registry = new RunRegistry();
	for (const one of records) registry.register(one);
	return registry;
}

/** A root and `links` children on one chain: `l0` is the root. */
function chainOf(links: number): RunRegistry {
	const registry = new RunRegistry();
	let parentSessionId: string | null = null;
	for (let level = 0; level <= links; level += 1) {
		const id = `l${level}`;
		registry.register(record(id, { depth: level, parentSessionId }));
		parentSessionId = id;
	}
	return registry;
}

// --- record shape -------------------------------------------------------------

test("a new record carries every field a run needs", () => {
	const one = record("root");

	assert.deepEqual(Object.keys(one).sort(), [
		"alwaysLoad",
		"class",
		"depth",
		"endedAt",
		"parentSessionId",
		"role",
		"sessionFile",
		"sessionId",
		"skills",
		"source",
		"startedAt",
		"status",
		"toolCount",
		"turns",
	]);
	assert.equal(one.sessionId, "root");
	assert.equal(one.role, "implementer");
	assert.equal(one.class, "worker");
	assert.equal(one.depth, 0);
	assert.equal(one.parentSessionId, null);
	assert.equal(one.sessionFile, "/tmp/root.json");
	assert.equal(one.status, "running");
	assert.equal(one.turns, 0);
	assert.equal(one.toolCount, 0);
	assert.equal(one.startedAt, T0);
	assert.equal(one.endedAt, null);
});

test("the compiler rejects a record with no session id", () => {
	const fields: Omit<RunStart, "sessionId"> = {
		role: "implementer",
		class: "worker",
		source: "package",
		skills: [],
		alwaysLoad: [],
		depth: 0,
		parentSessionId: null,
		sessionFile: "/tmp/keyless.json",
		startedAt: T0,
	};
	// @ts-expect-error the session id is the key, so a start without it is rejected
	newRunRecord({ ...fields });
});

test("register refuses an empty session id", () => {
	const registry = new RunRegistry();

	assert.throws(() => registry.register(record("")), /needs a session id/);
});

// --- key lookup ---------------------------------------------------------------

test("a known id returns its record", () => {
	const registry = registryOf(record("known", { role: "reviewer", class: "reader" }));

	assert.equal(registry.get("known")?.role, "reviewer");
	assert.equal(registry.get("known")?.class, "reader");
});

test("an unknown id returns no record and raises nothing", () => {
	const registry = registryOf(record("known"));

	assert.equal(registry.get("ghost"), undefined);
});

test("resolve returns the role and the class for a known id", () => {
	const registry = registryOf(record("known", { role: "planner", class: "reader" }));

	assert.deepEqual(registry.resolve("known"), { known: true, role: "planner", class: "reader" });
});

test("resolve reports an unknown id as unknown without raising", () => {
	const registry = registryOf(record("known"));

	assert.deepEqual(registry.resolve("ghost"), { known: false });
});

test("the unknown-id reason and role carry the deny text", () => {
	assert.equal(UNKNOWN_RUN_REASON, "Blocked: no permission record for this session");
	assert.equal(UNKNOWN_RUN_ROLE, "unknown");
});

test("a resumed round replaces the record on the same id", () => {
	const registry = registryOf(record("round", { role: "implementer", class: "worker" }));
	registry.register(record("round", { role: "tester", class: "worker", depth: 1 }));

	assert.equal(registry.size, 1);
	const resolution = registry.resolve("round");
	assert.ok(resolution.known, "the resumed round should resolve");
	assert.equal(resolution.role, "tester");
	assert.equal(registry.get("round")?.depth, 1);
});

test("a re-registered round starts its counters at zero", () => {
	const registry = registryOf(record("round"));
	registry.addTurn("round");
	registry.addToolCall("round");
	registry.finish("round", "done", T0 + DAY);

	registry.register(record("round"));
	const one = registry.get("round");

	assert.equal(one?.turns, 0);
	assert.equal(one?.toolCount, 0);
	assert.equal(one?.status, "running");
	assert.equal(one?.endedAt, null);
});

test("a counter change for an unknown id reports false and raises nothing", () => {
	const registry = registryOf(record("known"));

	assert.equal(registry.addTurn("ghost"), false);
	assert.equal(registry.addToolCall("ghost"), false);
	assert.equal(registry.finish("ghost", "done", T0), false);
});

// --- live counters ------------------------------------------------------------

test("addTurn counts one assistant turn", () => {
	const registry = registryOf(record("run"));

	registry.addTurn("run");
	registry.addTurn("run");

	assert.equal(registry.get("run")?.turns, 2);
});

test("the view from get shows a turn added after the read", () => {
	const registry = registryOf(record("run"));
	const view = registry.get("run");
	assert.equal(view?.turns, 0);

	registry.addTurn("run");

	assert.equal(view?.turns, 1);
});

test("addToolCall counts one tool call", () => {
	const registry = registryOf(record("run"));

	registry.addToolCall("run");

	assert.equal(registry.get("run")?.toolCount, 1);
});

test("finish marks the exit status and the end time", () => {
	const registry = registryOf(record("run"));

	registry.finish("run", "failed", T0 + DAY);

	assert.equal(registry.get("run")?.status, "failed");
	assert.equal(registry.get("run")?.endedAt, T0 + DAY);
});

test("delete drops a record and shrinks the map", () => {
	const registry = registryOf(record("a"), record("b"));

	assert.equal(registry.delete("a"), true);
	assert.equal(registry.delete("a"), false);
	assert.equal(registry.size, 1);
});

// --- parent walk --------------------------------------------------------------

test("a depth-0 record resolves itself as the root", () => {
	const walk = chainOf(0).walk("l0");

	assert.ok(walk.ok, "a root record should reach itself");
	assert.equal(walk.rootSessionId, "l0");
	assert.equal(walk.depth, 0);
	assert.equal(walk.failure, null);
	assert.equal(walk.failureId, null);
});

test("a depth-1 record walks to its parent root", () => {
	const walk = chainOf(1).walk("l1");

	assert.ok(walk.ok, "a depth-1 record should reach its parent");
	assert.equal(walk.rootSessionId, "l0");
	assert.equal(walk.depth, 1);
});

test("a depth-2 record walks to the root two links up", () => {
	const walk = chainOf(2).walk("l2");

	assert.ok(walk.ok, "a depth-2 record should reach the root");
	assert.equal(walk.rootSessionId, "l0");
	assert.equal(walk.depth, 2);
});

test("a missing parent link fails with the missing id", () => {
	const registry = registryOf(record("orphan", { depth: 1, parentSessionId: "gone" }));

	const walk = registry.walk("orphan");

	assert.equal(walk.ok, false);
	assert.equal(walk.failure, "missing-parent");
	assert.equal(walk.failureId, "gone");
});

test("a two-record loop fails and does not hang", () => {
	const registry = registryOf(
		record("a", { depth: 1, parentSessionId: "b" }),
		record("b", { depth: 1, parentSessionId: "a" }),
	);

	const walk = registry.walk("a");

	assert.equal(walk.ok, false);
	assert.equal(walk.failure, "loop");
	assert.equal(walk.failureId, "a");
});

test("the walk bound sits above the depth cap", () => {
	assert.ok(MAX_WALK_STEPS > MAX_AGENT_DEPTH, "the bound should sit above the cap");
});

test("a chain of 64 records reaches its root", () => {
	// The bound allows 64 visits, so the deepest record still reaches the root.
	const walk = chainOf(MAX_WALK_STEPS - 1).walk(`l${MAX_WALK_STEPS - 1}`);

	assert.ok(walk.ok, "a 64-record chain should reach its root");
	assert.equal(walk.rootSessionId, "l0");
	assert.equal(walk.depth, MAX_WALK_STEPS - 1);
});

test("a chain of 65 records fails at the walk bound", () => {
	// The 65th visit breaks the bound, so the walk names the id it cannot enter.
	const walk = chainOf(MAX_WALK_STEPS).walk(`l${MAX_WALK_STEPS}`);

	assert.equal(walk.ok, false);
	assert.equal(walk.failure, "unbounded");
	assert.equal(walk.failureId, "l0");
});

test("a walk from an unknown id fails without raising", () => {
	const walk = chainOf(1).walk("ghost");

	assert.equal(walk.ok, false);
	assert.equal(walk.failure, "unknown-session");
	assert.equal(walk.failureId, "ghost");
});

// --- depth --------------------------------------------------------------------

test("a record at the depth cap reports the cap", () => {
	const walk = chainOf(2).walk("l2");

	assert.ok(walk.ok, "a depth-2 record should reach the root");
	assert.equal(walk.depth, 2);
	assert.equal(walk.atCap, true);
});

test("a record below the cap is not at the cap", () => {
	const walk = chainOf(1).walk("l1");

	assert.ok(walk.ok, "the walk should reach a root");
	assert.equal(walk.depth, 1);
	assert.equal(walk.atCap, false);
});

test("the walk depth wins over a recorded depth", () => {
	// A record that under-reports its depth must not pass the cap guard.
	const registry = registryOf(
		record("l0"),
		record("l1", { depth: 0, parentSessionId: "l0" }),
		record("l2", { depth: 0, parentSessionId: "l1" }),
	);

	const walk = registry.walk("l2");

	assert.ok(walk.ok, "the chain should reach the root");
	assert.equal(walk.depth, 2);
	assert.equal(walk.atCap, true);
});

// --- sweep eligibility --------------------------------------------------------

test("the retention window is 14 days", () => {
	assert.equal(RUN_RETENTION_MS, 14 * DAY);
});

test("a done record older than 14 days is eligible", () => {
	const registry = registryOf(record("old"));
	registry.finish("old", "done", T0);

	assert.deepEqual(
		registry.sweepable(T0 + RUN_RETENTION_MS + 1).map((one) => one.sessionId),
		["old"],
	);
});

test("a failed record older than 14 days is eligible", () => {
	const registry = registryOf(record("old"));
	registry.finish("old", "failed", T0);

	assert.deepEqual(
		registry.sweepable(T0 + RUN_RETENTION_MS + 1).map((one) => one.sessionId),
		["old"],
	);
});

test("a running record is never eligible", () => {
	const registry = registryOf(record("live"));

	assert.deepEqual(registry.sweepable(T0 + 100 * DAY), []);
});

test("a done record inside 14 days is not eligible", () => {
	const registry = registryOf(record("fresh"));
	registry.finish("fresh", "done", T0 + DAY);

	assert.deepEqual(registry.sweepable(T0 + 2 * DAY), []);
});

test("a record exactly 14 days old is not yet eligible", () => {
	const registry = registryOf(record("edge"));
	registry.finish("edge", "done", T0);

	assert.deepEqual(registry.sweepable(T0 + RUN_RETENTION_MS), []);
});

test("a record finished after the sweep instant is not eligible", () => {
	// The age counts back from the end, so an end after the sweep wins.
	const registry = registryOf(record("late"));
	registry.finish("late", "done", T0 + 20 * DAY);

	assert.deepEqual(registry.sweepable(T0 + 15 * DAY), []);
});

test("a record finished 13 days after its start is not eligible 2 days later", () => {
	// The start alone would make this record eligible, so the end must decide.
	const registry = registryOf(record("gap"));
	registry.finish("gap", "done", T0 + 13 * DAY);

	assert.deepEqual(registry.sweepable(T0 + 15 * DAY), []);
});

test("a record finished 20 days after its start is eligible 15 days after the finish", () => {
	const registry = registryOf(record("long"));
	registry.finish("long", "done", T0 + 20 * DAY);

	assert.deepEqual(
		registry.sweepable(T0 + 35 * DAY).map((one) => one.sessionId),
		["long"],
	);
});
