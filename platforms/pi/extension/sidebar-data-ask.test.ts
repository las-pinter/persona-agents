/**
 * Sidebar fold tests for the ask record: the ring order, the repeat poll, the
 * clear, and a reload.
 *
 * Every case points `PI_AGENT_TREE_LOG` at its own temp file, so a record from
 * another test cannot paint.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data-ask.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { flushPendingLogEvents, recordAsk, recordLogLine } from "./ask-record.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { TREE_POLL_MS, createSidebarData } from "./sidebar-data.ts";

/** A fake pi: no git output, no MCP server, no tool list. */
function fakePi(): ExtensionAPI {
	const empty: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
	const pi = {
		exec: async (): Promise<ExecResult> => empty,
		on: () => () => {},
		events: { on: () => () => {}, emit: () => {} },
		getMcpServers: () => [],
		getAllTools: () => [],
	};
	return pi as unknown as ExtensionAPI;
}

/** A fake context with a fixed cwd and no session branch. */
function fakeCtx(): ExtensionContext {
	const ctx = {
		cwd: "/repo",
		model: { id: "test-model" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: null, contextWindow: null, percent: null }),
		sessionManager: { getBranch: () => [] },
	};
	return ctx as unknown as ExtensionContext;
}

/** Let the fire-and-forget git refresh finish. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A fresh log path inside its own temp dir. The caller removes the dir. */
function tempLog(): { dir: string; logPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "sidebar-ask-"));
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

/** One arrival and one expiry of the same ask, stamped one second apart. */
function appendAskPair(): void {
	recordAsk({
		tool: "bash",
		role: "implementer",
		verdict: "pending",
		runId: "child-a",
		depth: 1,
		at: "2026-01-01T00:00:00.000Z",
		askId: "ask-1",
		phase: "arrival",
		flags: "queued=1 shown=none parked=0 surface=yes",
	});
	recordAsk({
		tool: "bash",
		role: "implementer",
		verdict: "expired",
		runId: "child-a",
		depth: 1,
		at: "2026-01-01T00:00:01.000Z",
		askId: "ask-1",
		phase: "expiry",
		flags: "waiting=0 shown=none place=slot parked=1 surface=yes",
	});
}

test("the snapshot askLog is newest first and an expiry text names its place", async (t) => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	appendAskPair();
	const data = createSidebarData(fakePi());
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(fakeCtx());
		await flush();
		const rows = data.snapshot().askLog ?? [];
		assert.equal(rows.length, 2, "the ring keeps both stages of the ask");
		assert.equal(rows[0].phase, "expiry", "the newest event comes first");
		assert.equal(rows[0].askId, rows[1].askId, "both rows carry one ask id");
		assert.equal(
			rows[0].text,
			"00:00:01 implementer/bash waiting=0 shown=none place=slot parked=1 surface=yes",
			"the expiry row names where the request stood",
		);
		assert.match(
			rows[1].text,
			/^00:00:00 implementer\/bash queued=1 /,
			"the arrival row leads with its clock",
		);
		// The ring is rebuilt from the whole kept tail, so a poll must not append.
		t.mock.timers.tick(TREE_POLL_MS);
		t.mock.timers.tick(TREE_POLL_MS);
		assert.equal((data.snapshot().askLog ?? []).length, 2, "two polls keep both rows and add none");
		recordAsk({
			tool: "bash",
			role: "implementer",
			verdict: "pending",
			runId: "child-b",
			depth: 1,
			at: "2026-01-01T00:00:02.000Z",
			askId: "ask-2",
			phase: "arrival",
			flags: "queued=1 shown=none parked=0 surface=yes",
		});
		t.mock.timers.tick(TREE_POLL_MS);
		const three = data.snapshot().askLog ?? [];
		assert.equal(three.length, 3, "one new record adds one row to the two kept rows");
		assert.equal(three[0].askId, "ask-2", "the new record comes first");
		assert.equal(three[1].askId, "ask-1", "the older ask follows it");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a reload rebuilds the ring from the log", async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	appendAskPair();
	const first = createSidebarData(fakePi());
	const second = createSidebarData(fakePi());
	try {
		first.subscribe(fakeCtx());
		await flush();
		assert.equal(first.snapshot().askLog?.length, 2, "the first handle reads both rows");
		first.dispose();
		second.subscribe(fakeCtx());
		await flush();
		assert.equal(second.snapshot().askLog?.length, 2, "the new handle reads both rows again");
		assert.equal(second.snapshot().askLog?.[0].phase, "expiry", "the order survives the reload");
	} finally {
		first.dispose();
		second.dispose();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain line folds into the ring beside the ask rows and paints no node", async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	appendAskPair();
	recordLogLine({ text: "agent-stack: alwaysLoad entry resolves to no skill: ghost" });
	const data = createSidebarData(fakePi());
	try {
		data.subscribe(fakeCtx());
		await flush();
		const rows = data.snapshot().askLog ?? [];
		assert.equal(rows.length, 3, "both ask stages and the plain line are kept");
		assert.equal(rows[0].kind, "log", "the newest entry is the plain line");
		assert.equal(rows[0].text, "agent-stack: alwaysLoad entry resolves to no skill: ghost");
		assert.equal(rows[1].kind, "ask", "the ask rows keep their kind");
		assert.equal(
			rows[1].text,
			"00:00:01 implementer/bash waiting=0 shown=none place=slot parked=1 surface=yes",
			"the ask text is unchanged",
		);
		assert.deepEqual(data.snapshot().tree, [], "a plain line paints no tree node");
	} finally {
		data.dispose();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a line held before the log path exists paints on the first fold", async () => {
	const { dir, logPath } = tempLog();
	const previous = process.env[ENV_TREE_LOG];
	// No log path, so the writer holds the line and the ring alone carries it.
	delete process.env[ENV_TREE_LOG];
	const data = createSidebarData(fakePi());
	try {
		recordLogLine({ text: "agent-stack: forced paint failed: no host" });
		data.subscribe(fakeCtx());
		await flush();
		const rows = data.snapshot().askLog ?? [];
		assert.equal(rows.length, 1, "the held line paints with the first frame");
		assert.equal(rows[0].kind, "log");
		assert.equal(rows[0].text, "agent-stack: forced paint failed: no host");

		// The path lands the same line in the log, so a later paint reads it there.
		process.env[ENV_TREE_LOG] = logPath;
		flushPendingLogEvents();
		data.dispose();
		const again = createSidebarData(fakePi());
		again.subscribe(fakeCtx());
		await flush();
		assert.equal(again.snapshot().askLog?.length, 1, "the landed line appears once");
		again.dispose();
	} finally {
		data.dispose();
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
