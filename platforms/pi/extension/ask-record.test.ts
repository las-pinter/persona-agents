/**
 * Ask record tests: the record line, the best-effort writer, the tally fold,
 * the tree skip, and the three write sites.
 *
 * The write-site cases drive the real queue and the real gate through the
 * shared fixture. Every case points `PI_AGENT_TREE_LOG` at its own temp file.
 *
 * Run: npm test -- platforms/pi/extension/ask-record.test.ts
 */

import { after, afterEach, before, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ASK_HISTORY_MAX,
	ASK_ROOT_RUN_ID,
	createAskLog,
	createAskTally,
	recordAsk,
	recordAskLine,
} from "./ask-record.ts";
import { unbindChildAsk } from "./child-ask.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { CHILD_A, ROOT, captureRoot, childAsk, rootAsk, setup } from "./gate-child-ask-fixture.ts";
import { appendEvent, readAllEvents, type RunEvent } from "./tree-log.ts";
import { assembleTree } from "./tree-model.ts";

const realError = console.error;

// Every ask case logs a warning line, so one stub for the file lives here.
before(() => {
	console.error = (): void => {};
});

after(() => {
	console.error = realError;
});

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
		assert.deepEqual(event.ask, {
			tool: "bash",
			role: "orchestrator",
			verdict: "deny",
			askId: `${ASK_ROOT_RUN_ID}#${event.at}`,
			phase: "settle",
			flags: "",
		});
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

test("the tally counts one record twice as x1 and two records as x2", () => {
	const first = recordAskLine({
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
	const second = recordAskLine({
		tool: "bash",
		role: "implementer",
		verdict: "deny",
		runId: CHILD_A,
		depth: 1,
		at: "2026-01-01T00:00:01.000Z",
		askId: "ask-2",
		phase: "settle",
		flags: "",
	});
	const tally = createAskTally();
	assert.equal(tally.latest(), null, "no record before the first observe");
	tally.observe(first);
	tally.observe(first);
	assert.deepEqual(tally.usage(), { bash: 1 }, "one record twice counts once");
	assert.deepEqual(tally.latest(), { tool: "bash", at: AT });
	tally.observe(second);
	assert.deepEqual(tally.usage(), { bash: 2 }, "two records count twice");
	assert.deepEqual(tally.latest(), { tool: "bash", at: "2026-01-01T00:00:01.000Z" });
});

test("the tally counts an arrival and an expiry of one ask once", () => {
	const arrival = recordAskLine({
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
	const expiry = recordAskLine({
		tool: "bash",
		role: "implementer",
		verdict: "expired",
		runId: CHILD_A,
		depth: 1,
		at: "2026-01-01T00:00:02.000Z",
		askId: "ask-1",
		phase: "expiry",
		flags: "waiting=0 shown=none place=queue parked=0 surface=yes",
	});
	const tally = createAskTally();
	tally.observe(arrival);
	tally.observe(expiry);
	assert.deepEqual(tally.usage(), { bash: 1 }, "one ask counts once over its two stages");
	assert.deepEqual(
		tally.latest(),
		{ tool: "bash", at: "2026-01-01T00:00:02.000Z" },
		"the newest stamp is the expiry, not the arrival",
	);
	tally.observe({ ...arrival, at: "2026-01-01T00:00:03.000Z", ask: { ...arrival.ask!, askId: "ask-2" } });
	assert.deepEqual(tally.usage(), { bash: 2 }, "a second ask counts twice");
});

test("the tally counts a record with no ask id once", () => {
	// An older log line carries no id, so the fold falls back to its own fields.
	const legacy = {
		v: 1,
		type: "ask",
		runId: CHILD_A,
		parentRunId: null,
		depth: 1,
		agent: "implementer",
		persona: null,
		status: "idle",
		at: AT,
		ask: {
			tool: "bash",
			role: "implementer",
			verdict: "allow",
			phase: "settle",
			flags: "",
		},
	} as unknown as RunEvent;
	const tally = createAskTally();
	tally.observe(legacy);
	tally.observe(legacy);
	assert.deepEqual(tally.usage(), { bash: 1 }, "one record with no id folds once");
	assert.deepEqual(tally.latest(), { tool: "bash", at: AT }, "the fallback record stamps the newest");
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

test("the tally ignores a record of another type", () => {
	const start: RunEvent = {
		v: 1,
		type: "start",
		runId: ROOT,
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "idle",
		at: AT,
	};
	const tally = createAskTally();
	tally.observe(start);
	assert.deepEqual(tally.usage(), {});
	assert.equal(tally.latest(), null);
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
		assert.match(asks[0].ask?.flags ?? "", /^queued=1 shown=none /, "the arrival carries its flags");
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
			/^waiting=0 shown=(none|this|other) place=(queue|slot) /,
			"the expiry names where it stood",
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
