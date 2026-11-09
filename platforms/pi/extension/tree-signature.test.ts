/**
 * Tree repaint signature tests.
 *
 * Runs under plain Node (type stripping):
 *   npm test -- platforms/pi/extension/tree-signature.test.ts
 *
 * Every case pins one value the key must see, so a dropped field fails here.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { SidebarSnapshot, StatusSnapshot } from "./sidebar-render.ts";
import { makeNode, makeSession, makeSnapshot, makeWorkspace } from "./sidebar-render-fixtures.ts";
import { treeSignature } from "./tree-signature.ts";

test("treeSignature changes for every field the panels paint", () => {
	const n = (overrides: Partial<Parameters<typeof makeNode>[0]>) =>
		makeSnapshot({ tree: [makeNode({ runId: "n1", ...overrides })] });
	const long = "t".repeat(80);
	const mcp = (connected: boolean, status: "connected" | "disconnected" | "unknown") =>
		makeSnapshot({ mcp: [{ name: "exa", configured: true, connected, status }] });
	const file = (added: number) =>
		makeSnapshot({
			workspace: makeWorkspace({ files: [{ path: "a.ts", added, removed: 0, untracked: false }] }),
		});
	const usage = (cost: number) => n({ usage: { input: 1, output: 2, cost, turns: 3 } });
	const status = (overrides: Partial<StatusSnapshot> = {}) =>
		makeSnapshot({
			status: {
				study: "study-a",
				stage: "full",
				briefs: ["01-a.md"],
				nextAction: "brief 01",
				head: "abc1234",
				askCounts: { bash: 1 },
				askTool: "bash",
				askAgeMs: 1000,
				...overrides,
			},
		});
	const askLog = (text: string) =>
		makeSnapshot({
			askLog: [{ kind: "ask", askId: "root#1", phase: "expiry", at: "2026-11-07T00:00:00.000Z", text }],
		});
	const cases: Array<[string, SidebarSnapshot, SidebarSnapshot]> = [
		["node status", n({ status: "running" }), n({ status: "done" })],
		["node depth", n({ depth: 0 }), n({ depth: 1 })],
		["task after char 64", n({ task: `${long}A` }), n({ task: `${long}B` })],
		["output preview after char 64", n({ outputPreview: `${long}A` }), n({ outputPreview: `${long}B` })],
		["node usage", usage(0.1), usage(0.2)],
		["tool count", n({ toolCount: 1 }), n({ toolCount: 2 })],
		["node round", n({ round: 1 }), n({ round: 2 })],
		["node resumed", n({ resumed: false }), n({ resumed: true })],
		["null error vs empty error", n({ error: null }), n({ error: "" })],
		[
			"session model",
			makeSnapshot({ session: makeSession({ model: "model-a" }) }),
			makeSnapshot({ session: makeSession({ model: "model-b" }) }),
		],
		[
			"session turns",
			makeSnapshot({ session: makeSession({ turns: 1 }) }),
			makeSnapshot({ session: makeSession({ turns: 2 }) }),
		],
		[
			"workspace branch",
			makeSnapshot({ workspace: makeWorkspace({ branch: "dev" }) }),
			makeSnapshot({ workspace: makeWorkspace({ branch: "main" }) }),
		],
		["workspace file stat", file(1), file(2)],
		["MCP connected", mcp(false, "disconnected"), mcp(true, "connected")],
		["MCP status only", mcp(false, "unknown"), mcp(false, "disconnected")],
		[
			"todo done flag",
			makeSnapshot({ todos: [{ id: "1", text: "a", done: false }] }),
			makeSnapshot({ todos: [{ id: "1", text: "a", done: true }] }),
		],
		[
			"todo text",
			makeSnapshot({ todos: [{ id: "1", text: "first", done: false }] }),
			makeSnapshot({ todos: [{ id: "1", text: "second", done: false }] }),
		],
		["todos turn marker", makeSnapshot({ todosTurnMarker: false }), makeSnapshot({ todosTurnMarker: true })],
		["status study", status(), status({ study: "study-b" })],
		["status stage", status(), status({ stage: "draft" })],
		["status briefs", status(), status({ briefs: ["01-a.md", "02-b.md"] })],
		["status next action", status(), status({ nextAction: "brief 02" })],
		["status head", status(), status({ head: "def5678" })],
		["status ask count", status(), status({ askCounts: { bash: 2 } })],
		["status ask tool", status(), status({ askTool: "edit" })],
		["status ask age", status(), status({ askAgeMs: 2000 })],
		["askLog row text", askLog("a"), askLog("b")],
		[
			"askLog row stamp",
			makeSnapshot({
				askLog: [{ kind: "log", askId: "", phase: "settle", at: "2026-11-07T00:00:00.000Z", text: "same" }],
			}),
			makeSnapshot({
				askLog: [{ kind: "log", askId: "", phase: "settle", at: "2026-11-07T00:00:01.000Z", text: "same" }],
			}),
		],
	];
	for (const [label, before, after] of cases) {
		assert.notEqual(treeSignature(before), treeSignature(after), label);
	}
});

test("treeSignature keys a repeated run id twice, as the painter draws it", () => {
	// `assembleTree` stores one node per run id, so a repeat reaches the key only
	// from a hand-built forest. The walk must keep both, or a drawn node is lost.
	const single = makeSnapshot({ tree: [makeNode({ runId: "dup" })] });
	const repeated = makeSnapshot({
		tree: [makeNode({ runId: "dup" }), makeNode({ runId: "dup", task: "second" })],
	});
	assert.notEqual(treeSignature(single), treeSignature(repeated), "the second node on one run id joins the key");
});
