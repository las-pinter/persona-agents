/**
 * Offline regression harness for the shared append-only tree log.
 *
 * Runs under plain Node (type stripping). It imports only node built-ins and
 * local modules, so it needs no installed package:
 *   npm test -- agent-stack/tree-log.test.ts
 *
 * Covers append/read round-trips, a malformed line, the byte cap of one record,
 * the read cap with the `start`, `end`, and newest `clear` keep rules, the
 * `max` edge values, compaction by live run and by tail, and concurrency.
 */

import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_EVENT_BYTES,
	MAX_EVENTS_READ,
	appendEvent,
	compactLog,
	compactionLiveRuns,
	createRootLogPath,
	readAllEvents,
	readEvents,
	type RunEvent,
} from "./tree-log.ts";
import { assembleTree, findNode, flattenTree } from "./tree-model.ts";

const dir = mkdtempSync(join(tmpdir(), "tree-log-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;

function logPath(): string {
	counter += 1;
	return join(dir, `log-${counter}.ndjson`);
}

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		v: 1,
		type: "start",
		runId: "run-1",
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running",
		at: new Date(0).toISOString(),
		...overrides,
	};
}

test("append then read returns the one event", () => {
	const path = logPath();
	const event = makeEvent();
	appendEvent(path, event);

	const events = readEvents(path);
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], event);
});

test("append three then read three", () => {
	const path = logPath();
	appendEvent(path, makeEvent({ runId: "a" }));
	appendEvent(path, makeEvent({ runId: "b" }));
	appendEvent(path, makeEvent({ runId: "c" }));

	const events = readEvents(path);
	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((event) => event.runId),
		["a", "b", "c"],
	);
});

test("an idle status round-trips", () => {
	const path = logPath();
	appendEvent(path, makeEvent({ type: "update", status: "idle" }));
	const events = readEvents(path);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.status, "idle");
});

test("a malformed line is skipped silently", () => {
	const path = logPath();
	writeFileSync(
		path,
		`${JSON.stringify(makeEvent({ runId: "good-1" }))}\nnot json at all\n${JSON.stringify(
			makeEvent({ runId: "good-2" }),
		)}\n`,
		"utf8",
	);

	const events = readEvents(path);
	assert.equal(events.length, 2);
	assert.deepEqual(
		events.map((event) => event.runId),
		["good-1", "good-2"],
	);
});

test("an oversized task is truncated to the byte cap", () => {
	const path = logPath();
	appendEvent(path, makeEvent({ task: "a".repeat(10000) }));

	const raw = readFileSync(path, "utf8");
	assert.ok(raw.endsWith("\n"), "line must end with a newline");
	const line = raw.slice(0, -1);
	assert.ok(Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES, "line exceeds MAX_EVENT_BYTES");
	assert.ok(
		Buffer.byteLength(`${line}\n`, "utf8") <= MAX_EVENT_BYTES,
		"line including newline exceeds MAX_EVENT_BYTES",
	);
	assert.ok(line.endsWith("}"), "line must stay valid JSON");

	const parsed = JSON.parse(line) as RunEvent;
	assert.equal(typeof parsed.task, "string");
	assert.ok((parsed.task ?? "").length < 10000, "task was not truncated");
});

test("a missing file returns an empty list", () => {
	assert.deepEqual(readEvents(join(dir, "does-not-exist.ndjson")), []);
});

test("createRootLogPath is under os.tmpdir and unique across calls", () => {
	const first = createRootLogPath();
	const second = createRootLogPath();
	assert.ok(first.startsWith(tmpdir()), "path must live under os.tmpdir()");
	assert.notEqual(first, second);
});

test("readEvents returns exactly the capped tail when the log is longer", () => {
	const path = logPath();
	const total = MAX_EVENTS_READ + 5;
	for (let index = 0; index < total; index++) {
		appendEvent(path, makeEvent({ runId: `run-${index}`, type: "update" }));
	}

	const events = readEvents(path);
	assert.equal(events.length, MAX_EVENTS_READ);
	assert.equal(events[0]?.runId, "run-5");
	assert.equal(events[events.length - 1]?.runId, `run-${total - 1}`);
});

test("a start record older than the cap survives with one capped tail", () => {
	const path = logPath();
	appendEvent(path, makeEvent({ runId: "root", type: "start", at: new Date(0).toISOString() }));
	const total = MAX_EVENTS_READ + 5;
	for (let index = 0; index < total; index++) {
		appendEvent(path, makeEvent({ runId: `run-${index}`, type: "update", at: new Date(index + 1).toISOString() }));
	}

	const events = readEvents(path);
	assert.equal(events.length, MAX_EVENTS_READ + 1, "the old start plus one capped tail");
	assert.equal(events[0]?.runId, "root", "the old start comes first");
	assert.equal(events[1]?.runId, "run-5", "the oldest record over the cap is dropped");
	assert.equal(events[events.length - 1]?.runId, `run-${total - 1}`, "the newest record comes last");

	const times = events.map((event) => Date.parse(event.at));
	assert.deepEqual(times, [...times].sort((a, b) => a - b), "the kept records stay in file order");
});

test("an old child start and end and the newest clear survive outside the tail", () => {
	const path = logPath();
	const base = 1_700_000_000_000;
	const stamp = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
	appendEvent(path, makeEvent({ runId: "root", type: "start", status: "idle", at: stamp(0) }));
	appendEvent(
		path,
		makeEvent({ runId: "child", type: "start", parentRunId: "root", depth: 1, agent: "implementer", at: stamp(1) }),
	);
	appendEvent(
		path,
		makeEvent({
			runId: "child",
			type: "end",
			parentRunId: "root",
			depth: 1,
			agent: "implementer",
			status: "done",
			at: stamp(2),
		}),
	);
	appendEvent(path, makeEvent({ runId: "root", type: "clear", status: "running", at: stamp(3) }));
	const fillerCount = MAX_EVENTS_READ + 5;
	for (let index = 0; index < fillerCount; index++) {
		appendEvent(path, makeEvent({ runId: "root", type: "update", status: "running", at: stamp(4 + index) }));
	}

	const events = readEvents(path);
	assert.ok(
		events.some((event) => event.runId === "child" && event.type === "end"),
		"the child end record survives",
	);
	assert.ok(
		events.some((event) => event.type === "clear"),
		"the newest clear record survives",
	);

	const roots = assembleTree(events, base + fillerCount + 6, 1000);
	assert.equal(findNode(roots, "child"), undefined, "the clear drops the finished child");
	assert.deepEqual(
		flattenTree(roots).filter((node) => node.status === "stale").map((node) => node.runId),
		[],
		"no node rebuilds as stale",
	);
});

test("the newest of two clear records outside the tail survives", () => {
	const path = logPath();
	const base = 1_700_000_000_000;
	const stamp = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
	appendEvent(path, makeEvent({ runId: "root", type: "clear", status: "running", at: stamp(0) }));
	appendEvent(path, makeEvent({ runId: "root", type: "clear", status: "running", at: stamp(1) }));
	const fillerCount = MAX_EVENTS_READ + 5;
	for (let index = 0; index < fillerCount; index++) {
		appendEvent(path, makeEvent({ runId: "root", type: "update", status: "running", at: stamp(2 + index) }));
	}

	const clears = readEvents(path).filter((event) => event.type === "clear");
	assert.equal(clears.length, 1, "only one clear record survives");
	assert.equal(clears[0]?.at, stamp(1), "the kept clear is the newer one");
});

interface EdgeMaxCase {
	name: string;
	max: number;
	write: (path: string) => void;
	/** The kept records as `type:runId`, in file order. */
	expected: string[];
}

const edgeMaxCases: EdgeMaxCase[] = [
	{
		name: "max 0 keeps no record",
		max: 0,
		write: (path) => {
			appendEvent(path, makeEvent({ runId: "a", type: "start" }));
			appendEvent(path, makeEvent({ runId: "a", type: "end", status: "done" }));
		},
		expected: [],
	},
	{
		name: "a negative max keeps no record",
		max: -5,
		write: (path) => {
			appendEvent(path, makeEvent({ runId: "a", type: "start" }));
			appendEvent(path, makeEvent({ runId: "a", type: "end", status: "done" }));
		},
		expected: [],
	},
	{
		name: "max 2 over start records only keeps all 3 start records",
		max: 2,
		write: (path) => {
			for (const runId of ["a", "b", "c"]) {
				appendEvent(path, makeEvent({ runId, type: "start" }));
			}
		},
		expected: ["start:a", "start:b", "start:c"],
	},
	{
		name: "max 1 below 3 start records keeps all 3 start records plus the tail",
		max: 1,
		write: (path) => {
			for (const runId of ["a", "b", "c"]) {
				appendEvent(path, makeEvent({ runId, type: "start" }));
			}
			appendEvent(path, makeEvent({ runId: "c", type: "update" }));
		},
		expected: ["start:a", "start:b", "start:c", "update:c"],
	},
];

for (const item of edgeMaxCases) {
	test(item.name, () => {
		const path = logPath();
		item.write(path);
		const kept = readEvents(path, item.max).map((event) => `${event.type}:${event.runId}`);
		assert.deepEqual(kept, item.expected);
	});
}

test("compaction drops a finished run that sits outside the read window", () => {
	const path = logPath();
	const base = 1_700_000_000_000;
	const stamp = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
	appendEvent(path, makeEvent({ runId: "old", type: "start", at: stamp(0) }));
	appendEvent(path, makeEvent({ runId: "old", type: "end", status: "done", at: stamp(1) }));
	const fillerCount = MAX_EVENTS_READ + 5;
	for (let index = 0; index < fillerCount; index++) {
		appendEvent(path, makeEvent({ runId: "root", type: "update", status: "idle", at: stamp(2 + index) }));
	}

	const live = compactionLiveRuns(path, "root");
	assert.equal(live.has("old"), false, "an ended run is not live");
	compactLog(path, live);

	const runIds = readAllEvents(path).map((event) => event.runId);
	assert.equal(runIds.includes("old"), false, "the finished run outside the window is gone");
	assert.ok(runIds.includes("root"), "the live root stays");
	assert.ok(
		readEvents(path).some((event) => event.runId === "root"),
		"the tree still reads the live root",
	);
});

test("compaction keeps a live run that has only update records outside the read window", () => {
	const path = logPath();
	// Only `update` records: no start and no end, so the capped read drops them.
	for (let index = 0; index < 3; index++) {
		appendEvent(path, makeEvent({ runId: "quiet", type: "update" }));
	}
	const fillerCount = MAX_EVENTS_READ + 5;
	for (let index = 0; index < fillerCount; index++) {
		appendEvent(path, makeEvent({ runId: "root", type: "update" }));
	}

	assert.ok(
		readEvents(path).every((event) => event.runId !== "quiet"),
		"the capped read drops every quiet record",
	);

	const live = compactionLiveRuns(path, "root");
	assert.equal(live.has("quiet"), true, "a run with no end record is live");
	compactLog(path, live);

	const runIds = readAllEvents(path).map((event) => event.runId);
	assert.ok(runIds.includes("quiet"), "the live run outside the window stays");
	assert.ok(runIds.includes("root"), "the live root stays");
});

test("compactLog keeps requested run ids and the recent tail, drops the rest", () => {
	const path = logPath();
	// The keep event goes first so it sits outside the capped read window.
	const fillerCount = MAX_EVENTS_READ + 600;
	appendEvent(path, makeEvent({ runId: "keep", type: "start" }));
	for (let index = 0; index < fillerCount; index++) {
		appendEvent(path, makeEvent({ runId: `filler-${index}`, type: "update" }));
	}

	compactLog(path, ["keep"]);
	const runIds = readEvents(path).map((event) => event.runId);
	assert.ok(runIds.includes("keep"), "requested run id must survive");
	assert.ok(runIds.includes(`filler-${fillerCount - 1}`), "recent tail must survive");
	assert.equal(runIds.includes("filler-0"), false, "old unrequested record must be dropped");
});

test("a lone update and a lone end do not throw and the model handles them", () => {
	const path = logPath();
	appendEvent(path, makeEvent({ runId: "lonely-update", type: "update" }));
	appendEvent(path, makeEvent({ runId: "lonely-end", type: "end", status: "done" }));

	let events: RunEvent[] = [];
	assert.doesNotThrow(() => {
		events = readEvents(path);
	});
	assert.equal(events.length, 2);

	const roots = assembleTree(events, Date.now(), 60_000);
	assert.equal(findNode(roots, "lonely-update")?.status, "running");
	assert.equal(findNode(roots, "lonely-end")?.status, "done");
});

test("two independent logs give two independent trees (concurrent roots)", () => {
	const pathA = logPath();
	const pathB = logPath();

	appendEvent(pathA, makeEvent({ runId: "root-a", type: "start" }));
	appendEvent(pathA, makeEvent({ runId: "root-a", type: "end", status: "done" }));
	appendEvent(pathB, makeEvent({ runId: "root-b", type: "start", agent: "planner" }));
	appendEvent(pathB, makeEvent({ runId: "root-b", type: "end", status: "done" }));

	const treeA = assembleTree(readEvents(pathA), Date.now(), 60_000);
	const treeB = assembleTree(readEvents(pathB), Date.now(), 60_000);

	assert.equal(treeA.length, 1);
	assert.equal(treeB.length, 1);
	assert.equal(treeA[0]?.runId, "root-a");
	assert.equal(treeB[0]?.runId, "root-b");
	assert.equal(findNode(treeA, "root-b"), undefined);
	assert.equal(findNode(treeB, "root-a"), undefined);

	// No record leaks across the two files.
	assert.equal(readEvents(pathA).some((event) => event.runId === "root-b"), false);
	assert.equal(readEvents(pathB).some((event) => event.runId === "root-a"), false);
});

test("interleaved appends from two writers to one log keep every record", () => {
	const path = logPath();
	const perWriter = 200;

	// Two logical writers share one O_APPEND log, so their lines interleave.
	for (let index = 0; index < perWriter; index++) {
		appendEvent(path, makeEvent({ runId: "writer-a", type: "update" }));
		appendEvent(path, makeEvent({ runId: "writer-b", type: "update" }));
	}

	const events = readEvents(path, perWriter * 2);
	assert.equal(events.length, perWriter * 2, "every appended record must survive");

	let seenA = 0;
	let seenB = 0;
	for (const event of events) {
		assert.ok(event.runId === "writer-a" || event.runId === "writer-b");
		// Each line is whole: the run id and event type are never split.
		assert.equal(event.type, "update", "no corrupted or partial line");
		if (event.runId === "writer-a") seenA += 1;
		else seenB += 1;
	}
	assert.equal(seenA, perWriter);
	assert.equal(seenB, perWriter);
});

test("a clear record round-trips", () => {
	const path = logPath();
	const event = makeEvent({ type: "clear", status: "running", at: new Date(5).toISOString() });
	appendEvent(path, event);

	const events = readEvents(path);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.type, "clear");
	assert.deepEqual(events[0], event);
});

test("a toolCount round-trips on an end record", () => {
	const path = logPath();
	const event = makeEvent({ type: "end", status: "done", toolCount: 7 });
	appendEvent(path, event);

	const events = readEvents(path);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.toolCount, 7);
});
