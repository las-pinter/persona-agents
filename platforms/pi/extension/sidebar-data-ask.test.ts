/**
 * Sidebar fold tests for the ask record: the STATUS row, the repeat poll, the
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
import { recordAsk } from "./ask-record.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { TREE_POLL_MS, createSidebarData } from "./sidebar-data.ts";
import { renderStatusPanel } from "./sidebar-render.ts";
import { theme } from "./sidebar-render-fixtures.ts";
import { appendEvent } from "./tree-log.ts";

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

/** One `clear` record, stamped after the ask record. */
function appendClear(logPath: string): void {
	appendEvent(logPath, {
		v: 1,
		type: "clear",
		runId: "root",
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running",
		at: new Date(Date.now() + 1000).toISOString(),
	});
}

test("the STATUS row prints the ask tool, count, and a fresh age", async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: "child-a", depth: 1 });
	const data = createSidebarData(fakePi());
	try {
		data.subscribe(fakeCtx());
		await flush();
		const status = data.snapshot().status;
		assert.equal(status?.askTool, "bash");
		assert.deepEqual(status?.askCounts, { bash: 1 });
		assert.ok((status?.askAgeMs ?? -1) >= 0, "the age is measured");
		assert.ok((status?.askAgeMs ?? 60_000) < 60_000, "the age is under one minute");
		const lines = renderStatusPanel(status, 80, theme).map((line) => line.trimEnd());
		assert.match(lines[3], /^- · ask bash x1 \d+s$/);
		assert.deepEqual(data.snapshot().tree, [], "an ask record paints no tree node");
	} finally {
		data.dispose();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two polls raise the count to x2 and a clear does not lower it", (t) => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: "child-a", depth: 1 });
	const data = createSidebarData(fakePi());
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		data.subscribe(fakeCtx());
		assert.deepEqual(data.snapshot().status?.askCounts, { bash: 1 }, "the first read counts once");
		// A second record lands after the first read, so a tally rebuilt on every
		// poll from scratch reads x1 here and only a folded tally reads x2.
		recordAsk({ tool: "bash", role: "implementer", verdict: "deny", runId: "child-b", depth: 1 });
		t.mock.timers.tick(TREE_POLL_MS);
		assert.deepEqual(data.snapshot().status?.askCounts, { bash: 2 }, "the second poll folds the new record");
		t.mock.timers.tick(TREE_POLL_MS);
		assert.deepEqual(data.snapshot().status?.askCounts, { bash: 2 }, "a further poll keeps x2");
		appendClear(logPath);
		t.mock.timers.tick(TREE_POLL_MS);
		assert.deepEqual(data.snapshot().status?.askCounts, { bash: 2 }, "a clear keeps the count");
		assert.equal(data.snapshot().status?.askTool, "bash", "a clear keeps the newest tool");
		assert.deepEqual(data.snapshot().tree, [], "the clear leaves no node");
	} finally {
		data.dispose();
		t.mock.timers.reset();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a reload keeps the count from the log", async () => {
	const { dir, logPath } = tempLog();
	const restore = useLog(logPath);
	recordAsk({ tool: "bash", role: "implementer", verdict: "allow", runId: "child-a", depth: 1 });
	const first = createSidebarData(fakePi());
	const second = createSidebarData(fakePi());
	try {
		first.subscribe(fakeCtx());
		await flush();
		assert.deepEqual(first.snapshot().status?.askCounts, { bash: 1 }, "the first handle counts");
		first.dispose();
		second.subscribe(fakeCtx());
		await flush();
		assert.deepEqual(second.snapshot().status?.askCounts, { bash: 1 }, "the new handle reads the log");
		assert.equal(second.snapshot().status?.askTool, "bash");
	} finally {
		first.dispose();
		second.dispose();
		restore();
		rmSync(dir, { recursive: true, force: true });
	}
});
