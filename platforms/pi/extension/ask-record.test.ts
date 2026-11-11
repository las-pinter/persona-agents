/**
 * Ask record tests: the record line, the best-effort writer, the ring, the
 * tree skip, and the three write sites.
 *
 * The write-site cases drive the real queue and the real gate through the
 * shared fixture. Every case points `PI_AGENT_TREE_LOG` at its own temp file.
 *
 * Run: npm test -- platforms/pi/extension/ask-record.test.ts
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ASK_HISTORY_MAX,
	ASK_ROOT_RUN_ID,
	createAskLog,
	flushPendingLogEvents,
	logLineEvent,
	logRowOf,
	mintAskId,
	recordAsk,
	recordAskLine,
	recordLogLine,
	type AskLogEvent,
} from "./ask-record.ts";
import { unbindChildAsk } from "./child-ask.ts";
import { newRequest } from "./child-ask-state.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { CHILD_A, ROOT, captureRoot, childAsk, rootAsk, setup } from "./gate-child-ask-fixture.ts";
import type { PromptModel } from "./permission-prompt.ts";
import { appendEvent, readAllEvents, type RunEvent } from "./tree-log.ts";
import { assembleTree } from "./tree-model.ts";

afterEach(() => {
	unbindChildAsk();
});

/** A fresh log path inside its own temp dir. The caller removes the dir. */
function tempLog(): { dir: string; logPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "ask-record-"));
	return { dir, logPath: join(dir, "tree.ndjson") };
}

/** Point the tree-log env at one path. Returns the restore function. */
function useLog(logPath: string): () => void {
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	return () => {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
	};
}

/** The `ask` records in one log, in file order. */
function askEvents(logPath: string): RunEvent[] {
	return readAllEvents(logPath).filter((event) => event.type === "ask");
}

const AT = "2026-01-01T00:00:00.000Z";

/** The flags one arrival and one expiry line carry in these cases. */
const FLAGS = "queued=1 shown=none parked=0 surface=yes";

/** The prompt model of the one request the counter case mints. Plain data only. */
const ASK_MODEL: PromptModel = {
	title: "Child ask",
	toolName: "bash",
	kind: "shell-segment",
	target: "ls",
	lines: [],
	highlight: null,
	remember: "a test rule",
	options: [],
};

test("recordAskLine builds one ask event with the documented fields", () => {
	const event = recordAskLine({
		tool: "bash",
		role: "implementer",
		verdict: "pending",
		runId: CHILD_A,
		depth: 1,
		at: AT,
		askId: `${CHILD_A}#${AT}`,
		phase: "arrival",
		flags: FLAGS,
	});
	assert.equal(event.v, 1);
	assert.equal(event.type, "ask");
	assert.equal(event.runId, CHILD_A);
	assert.equal(event.parentRunId, null);
	assert.equal(event.depth, 1);
	assert.equal(event.agent, "implementer");
	assert.equal(event.persona, null);
	assert.equal(event.status, "idle");
	assert.equal(event.at, AT);
	assert.deepEqual(event.ask, {
		tool: "bash",
		role: "implementer",
		verdict: "pending",
		askId: `${CHILD_A}#${AT}`,
		phase: "arrival",
		flags: FLAGS,
	});
});

test("recordAsk appends one line and fills the defaults", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		recordAsk({ tool: "bash", role: "orchestrator", verdict: "deny" });
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1, "one write appends one line");
		const event = JSON.parse(lines[0]) as RunEvent;
		assert.equal(event.type, "ask");
		assert.equal(event.runId, ASK_ROOT_RUN_ID);
		assert.equal(event.depth, 0);
		const askId = event.ask?.askId ?? "";
		assert.match(
			askId,
			new RegExp(`^${ASK_ROOT_RUN_ID}#[^#]+#\\d+$`),
			"the default id carries the scope, the stamp, and the counter",
		);
		assert.deepEqual(event.ask, {
			tool: "bash",
			role: "orchestrator",
			verdict: "deny",
			askId,
			phase: "settle",
			flags: "",
		});
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("one mint gives an arrival and a default settle one shape and one fold", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		// The arrival id the child queue mints.
		const arrivalId = mintAskId(CHILD_A, AT);
		recordAsk({
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			runId: CHILD_A,
			at: AT,
			askId: arrivalId,
			phase: "arrival",
			flags: FLAGS,
		});
		// The settle that carries the arrival id is the pair a fold joins.
		recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: CHILD_A, at: AT, askId: arrivalId });
		// No id: the writer mints one from the same scope, in the same shape.
		recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: CHILD_A, at: AT });

		const [arrival, joined, minted] = askEvents(logPath);
		const arrivalFields = (arrival?.ask?.askId ?? "").split("#");
		const settleFields = (minted?.ask?.askId ?? "").split("#");
		assert.equal(arrivalFields.length, 3, "the queue mint carries three fields");
		assert.equal(settleFields.length, 3, "the default mint carries the same three fields");
		assert.equal(arrivalFields[0], CHILD_A, "the queue mint leads with the session");
		assert.equal(settleFields[0], CHILD_A, "an arrival and a default settle carry one scope word");
		assert.equal(settleFields[1], arrivalFields[1], "two mints at one stamp share the stamp field");
		assert.notEqual(settleFields[2], arrivalFields[2], "the counter field tells the two mints apart");
		assert.equal(joined?.ask?.askId, arrivalId, "a settle keeps the id its arrival carried");

		// The fold: one row per ask id.
		const rows = new Map<string, RunEvent[]>();
		for (const event of askEvents(logPath)) {
			const id = event.ask?.askId ?? "";
			rows.set(id, [...(rows.get(id) ?? []), event]);
		}
		assert.deepEqual(
			rows.get(arrivalId)?.map((event) => event.ask?.phase),
			["arrival", "settle"],
			"the arrival and its settle fold to one ask",
		);
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a recordAsk mint and a request mint share one counter", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		// The record mint runs first, so its counter value is the one to match.
		recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: CHILD_A });
		const recorded = askEvents(logPath)[0]?.ask?.askId ?? "";
		const recordedSeq = Number(recorded.split("#")[2]);
		const request = newRequest(
			{
				sessionId: CHILD_A,
				role: "implementer",
				toolName: "bash",
				key: "bash:ls",
				model: ASK_MODEL,
				remember: () => {},
			},
			() => {},
		);
		const nextSeq = Number((request.askId ?? "").split("#")[2]);
		assert.ok(recordedSeq >= 1, "the record mint counts from one");
		assert.equal(nextSeq, recordedSeq + 1, "one counter map owns both mints");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recordAsk writes nothing with no log path", () => {
	const previous = process.env[ENV_TREE_LOG];
	delete process.env[ENV_TREE_LOG];
	try {
		assert.doesNotThrow(() => recordAsk({ tool: "bash", role: "orchestrator", verdict: "allow" }));
	} finally {
		if (previous !== undefined) process.env[ENV_TREE_LOG] = previous;
	}
});

test("the ask log keeps the newest 50 events and ignores a settle", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		for (let index = 0; index < 60; index += 1) {
			const at = `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
			recordAsk({
				tool: "bash",
				role: "implementer",
				verdict: "pending",
				runId: CHILD_A,
				depth: 1,
				at,
				askId: `ask-${index}`,
				phase: "arrival",
				flags: FLAGS,
			});
		}
		// A settle record is a verdict, not a queue event, so the ring skips it.
		recordAsk({ tool: "bash", role: "implementer", verdict: "allow", askId: "ask-settle" });
		const ring = createAskLog();
		for (const event of askEvents(logPath)) ring.observe(event);
		const rows = ring.rows();
		assert.equal(rows.length, ASK_HISTORY_MAX, "the ring stops at the cap");
		assert.equal(rows[0].askId, "ask-10", "the oldest ten events dropped");
		assert.equal(rows[rows.length - 1].askId, "ask-59", "the newest event stays last");
		assert.match(rows[0].text, /^\d{2}:\d{2}:\d{2} implementer\/bash queued=1 /, "the text leads with the clock");
		assert.equal(
			rows.filter((row) => row.askId === "ask-settle").length,
			0,
			"the settle record is not a ring event",
		);
		ring.reset();
		assert.deepEqual(ring.rows(), [], "a reset empties the ring");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the ring keeps no row for an event that is not an ask", () => {
	// The record carries a full ask payload, so only the type check drops it.
	const ask = recordAskLine({
		tool: "bash",
		role: "implementer",
		verdict: "pending",
		runId: CHILD_A,
		depth: 1,
		at: AT,
		askId: "ask-1",
		phase: "arrival",
		flags: FLAGS,
	});
	const ring = createAskLog();
	ring.observe({ ...ask, type: "start" } as RunEvent);
	assert.deepEqual(ring.rows(), [], "a start event is not a ring entry");
});

test("the ring keeps no row for an ask with an empty id", () => {
	const ring = createAskLog();
	ring.observe(
		recordAskLine({
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			runId: CHILD_A,
			depth: 1,
			at: AT,
			askId: "",
			phase: "arrival",
			flags: FLAGS,
		}),
	);
	assert.deepEqual(ring.rows(), [], "an ask with no id is not a ring entry");
});

test("assembleTree returns the same forest with and without an ask record", () => {
	const start: RunEvent = {
		v: 1,
		type: "start",
		runId: ROOT,
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running",
		at: AT,
	};
	const ask = recordAskLine({
		tool: "bash",
		role: "implementer",
		verdict: "allow",
		runId: CHILD_A,
		depth: 1,
		at: AT,
		askId: "ask-1",
		phase: "settle",
		flags: "",
	});
	const now = Date.parse(AT);
	const without = assembleTree([start], now, 60_000);
	const withAsk = assembleTree([start, ask], now, 60_000);
	assert.equal(JSON.stringify(withAsk), JSON.stringify(without), "an ask record changes no node");
	assert.equal(withAsk.length, 1, "the ask record is not a root");
	assert.deepEqual(withAsk[0].children, [], "the ask record is not a child");
});

test("one allow-once child ask appends an arrival and a settle record", { timeout: 4000 }, async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	const s = setup({ answers: ["Allow once"] });
	try {
		await captureRoot(s);
		const result = await childAsk(s, CHILD_A);
		assert.equal(result, undefined, "the owner allowed the child ask");
		const asks = askEvents(logPath);
		assert.equal(asks.length, 2, "one answered ask writes an arrival and a settle");
		assert.deepEqual(
			asks.map((event) => event.ask?.phase),
			["arrival", "settle"],
		);
		assert.deepEqual(
			asks.map((event) => event.ask?.verdict),
			["pending", "allow"],
		);
		assert.equal(asks[0].ask?.askId, asks[1].ask?.askId, "the pair shares one ask id");
		assert.equal(asks[0].runId, CHILD_A);
		assert.equal(asks[0].depth, 1);
		assert.equal(asks[0].agent, "implementer");
		assert.match(
			asks[0].ask?.flags ?? "",
			/^root=\S+ phase=arrival queued=1 shown=none /,
			"the arrival carries the root, the stage, and its queue flags",
		);
		assert.equal(asks[1].ask?.flags, "", "a settle carries no flags");
	} finally {
		unbindChildAsk();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("one denied root ask appends one ask record with the root role", { timeout: 4000 }, async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	const s = setup({ answers: ["Deny"] });
	try {
		await captureRoot(s);
		const result = await rootAsk(s);
		assert.deepEqual(result, { block: true, reason: "Denied by user" });
		const asks = askEvents(logPath);
		assert.equal(asks.length, 1, "a root ask queues nothing, so it writes one record");
		assert.equal(asks[0].ask?.phase, "settle");
		assert.equal(asks[0].ask?.verdict, "deny");
		assert.equal(asks[0].ask?.role, "orchestrator");
		assert.match(asks[0].ask?.askId ?? "", /^root-session#/, "a root settle mints its own id");
		assert.equal(asks[0].runId, ROOT);
		assert.equal(asks[0].depth, 0);
	} finally {
		unbindChildAsk();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an always-allow root ask appends one record with the allow verdict", { timeout: 4000 }, async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	const s = setup({ answers: ["Always allow this rule (session)"] });
	try {
		await captureRoot(s);
		const result = await rootAsk(s);
		assert.equal(result, undefined, "the owner allowed the root rule");
		const asks = askEvents(logPath);
		assert.equal(asks.length, 1, "a root ask queues nothing, so it writes one record");
		assert.equal(asks[0].ask?.verdict, "allow");
		assert.equal(asks[0].ask?.role, "orchestrator");
		assert.equal(asks[0].runId, ROOT);
		assert.equal(asks[0].depth, 0);
	} finally {
		unbindChildAsk();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a child ask that reaches the deadline writes an arrival and an expiry", { timeout: 4000 }, async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	const s = setup({ never: true, timeoutMs: 10 });
	try {
		await captureRoot(s);
		const result = await childAsk(s, CHILD_A);
		assert.equal((result as { block?: boolean }).block, true, "the deadline blocks the child");
		const asks = askEvents(logPath);
		assert.equal(asks.length, 2, "the deadline writes an arrival and an expiry, and the late answer none");
		assert.deepEqual(
			asks.map((event) => event.ask?.phase),
			["arrival", "expiry"],
		);
		assert.deepEqual(
			asks.map((event) => event.ask?.verdict),
			["pending", "expired"],
		);
		assert.equal(asks[0].ask?.askId, asks[1].ask?.askId, "the pair shares one ask id");
		assert.equal(new Set(asks.map((event) => event.ask?.askId)).size, 1, "one ask, one id");
		assert.equal(asks[0].runId, CHILD_A);
		assert.match(
			asks[1].ask?.flags ?? "",
			/^root=\S+ phase=expiry waiting=0 shown=(none|this|other) place=(queue|slot) /,
			"the expiry names the root, the stage, and where it stood",
		);
	} finally {
		unbindChildAsk();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second child ask in the same session appends a second pair", { timeout: 4000 }, async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	const s = setup({ answers: ["Allow once", "Deny"] });
	try {
		await captureRoot(s);
		await childAsk(s, CHILD_A);
		await childAsk(s, CHILD_A);
		const asks = askEvents(logPath);
		assert.equal(asks.length, 4, "each answered ask writes its own arrival and settle");
		assert.deepEqual(
			asks.map((event) => event.ask?.verdict),
			["pending", "allow", "pending", "deny"],
		);
		assert.equal(new Set(asks.map((event) => event.ask?.askId)).size, 2, "two asks, two ids");
	} finally {
		unbindChildAsk();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an ask record beside a run record keeps the run node", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: ROOT,
			parentRunId: null,
			depth: 0,
			agent: "orchestrator",
			persona: null,
			status: "running",
			at: AT,
		});
		recordAsk({ tool: "bash", role: "orchestrator", verdict: "allow", at: AT });
		const events = readAllEvents(logPath);
		const nodes = assembleTree(events, Date.parse(AT), 60_000);
		assert.equal(nodes.length, 1, "the run stays the only root");
		assert.equal(nodes[0].runId, ROOT);
		assert.equal(nodes[0].orphan, false, "the ask record creates no orphan");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain line writes one log record and lands in the ring beside an ask", () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	try {
		recordAsk({
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			runId: CHILD_A,
			depth: 1,
			at: AT,
			askId: "ask-1",
			phase: "arrival",
			flags: FLAGS,
		});
		recordLogLine({ text: "agent-stack: forced paint failed: the host refused", at: AT });

		const events = readAllEvents(logPath);
		assert.deepEqual(events.map((event) => event.type), ["ask", "log"], "one write each, in call order");
		assert.equal(events[1].text, "agent-stack: forced paint failed: the host refused");
		assert.equal(events[1].runId, ASK_ROOT_RUN_ID, "a plain line belongs to the root run");

		const ring = createAskLog();
		for (const event of events) ring.observe(event);
		const rows = ring.rows();
		assert.deepEqual(rows.map((row) => row.kind), ["ask", "log"], "one ring holds both kinds in one order");
		assert.equal(
			rows[0].text,
			`00:00:00 implementer/bash ${FLAGS}`,
			"the ask text is unchanged by the widening",
		);
		assert.equal(rows[1].text, events[1].text, "the plain line carries its own text");
		assert.deepEqual(assembleTree(events, Date.parse(AT), 60_000), [], "neither kind paints a tree node");
	} finally {
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the ring caps a mix of kinds at one cap and keeps one order", () => {
	const ring = createAskLog();
	for (let index = 0; index < 30; index += 1) {
		ring.observe(
			recordAskLine({
				tool: "bash",
				role: "implementer",
				verdict: "pending",
				runId: CHILD_A,
				depth: 1,
				at: AT,
				askId: `ask-${index}`,
				phase: "arrival",
				flags: FLAGS,
			}),
		);
		ring.observe(logLineEvent({ text: `line ${index}`, at: AT }));
	}
	const rows = ring.rows();
	assert.equal(rows.length, ASK_HISTORY_MAX, "the cap counts both kinds together");
	assert.equal(rows[0].askId, "ask-5", "the oldest ten entries drop, whatever their kind");
	assert.equal(rows[rows.length - 1].text, "line 29", "the newest plain line stays last");
	assert.equal(rows.filter((row) => row.kind === "ask").length, 25, "half the ring is ask events");
	assert.equal(rows.filter((row) => row.kind === "log").length, 25, "half the ring is plain lines");
});

test("a line written before the log path exists lands when the path appears", () => {
	const { dir, logPath } = tempLog();
	const previous = process.env[ENV_TREE_LOG];
	try {
		// Start from an empty held buffer, so an earlier case cannot leak in.
		process.env[ENV_TREE_LOG] = logPath;
		flushPendingLogEvents();
		delete process.env[ENV_TREE_LOG];

		recordLogLine({ text: "agent-stack: agent discovery failed; the gate stays installed", at: AT });
		assert.equal(readAllEvents(logPath).length, 0, "no path writes no file");

		// The panel reads the held lines, so the first paint shows them. The path
		// then lands them in the log, oldest first, exactly once.
		process.env[ENV_TREE_LOG] = logPath;
		flushPendingLogEvents();
		const events = readAllEvents(logPath);
		assert.equal(events.length, 1, "the held line lands once");
		assert.equal(events[0].type, "log");
		assert.equal(events[0].at, AT, "the held stamp is kept");
		assert.equal(events[0].text, "agent-stack: agent discovery failed; the gate stays installed");
	} finally {
		process.env[ENV_TREE_LOG] = logPath;
		flushPendingLogEvents();
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every row a reader receives carries its kind", () => {
	const ring = createAskLog();
	ring.observe(
		recordAskLine({
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			runId: CHILD_A,
			depth: 1,
			at: AT,
			askId: "ask-1",
			phase: "arrival",
			flags: FLAGS,
		}),
	);
	ring.observe(logLineEvent({ text: "agent-stack: forced paint failed", at: AT }));
	assert.deepEqual(
		ring.rows().map((row) => row.kind),
		["ask", "log"],
		"a reader tells an ask row from a plain line without guessing",
	);
});

test("a record with no kind reads as an ask at the one read boundary", () => {
	// The read boundary supplies the kind, so a record that carries no kind
	// reads as an ask and never as a plain line.
	const legacy = { askId: "ask-1", phase: "arrival", at: AT, text: "00:00:00 implementer/bash" };
	assert.equal(logRowOf(legacy as AskLogEvent).kind, "ask", "a missing kind reads as an ask");
	assert.equal(logRowOf({ ...legacy, kind: "log" } as AskLogEvent).kind, "log", "a named kind is kept");
});
