/**
 * Offline regression harness for the shared append-only tree log.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   npm run test:permissions -- agent-stack/tree-log.test.ts
 *
 * Covers the plan's Task 19 tree-log cases: round-trip append/read, malformed
 * line skipping, byte-cap truncation, a missing file, and root path uniqueness.
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
	createRootLogPath,
	readEvents,
	type RunEvent,
} from "./tree-log.ts";
import { assembleTree, findNode } from "./tree-model.ts";

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
