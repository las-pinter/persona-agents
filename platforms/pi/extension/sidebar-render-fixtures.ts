/**
 * Shared fixtures for the sidebar renderer tests.
 *
 * Builds tree nodes and workspace, session, and sidebar snapshots, and checks
 * that rendered lines fit a width.
 */

import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AskPhase } from "./ask-record.ts";
import type { SidebarTheme } from "./sidebar-render.ts";
import type {
	AskLogRow,
	SessionSnapshot,
	SidebarSnapshot,
	WorkspaceSnapshot,
} from "./sidebar-types.ts";
import type { TreeNode, TreeNodeStatus } from "./tree-model.ts";

export const theme: SidebarTheme = {
	bold: (text) => text,
	dim: (text) => text,
	fg: (_color, text) => text,
};

export function makeNode(overrides: Partial<TreeNode> & Pick<TreeNode, "runId">): TreeNode {
	return {
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: "running" as TreeNodeStatus,
		startedAt: "2026-10-07T00:00:00.000Z",
		endedAt: null,
		task: "",
		bytesIn: 0,
		bytesOut: 0,
		usage: undefined,
		toolCount: 0,
		exitCode: null,
		error: null,
		outputPreview: "",
		orphan: false,
		children: [],
		...overrides,
	};
}

export function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		model: "test-model",
		thinkingLevel: "medium",
		contextTokens: 1000,
		contextWindow: 2000,
		contextPercent: null,
		cost: 0.1234,
		tps: 12.34,
		tokensIn: 0,
		tokensOut: 0,
		turns: 0,
		sessionStartMs: null,
		...overrides,
	};
}

export function makeWorkspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return {
		cwd: "/home/dev/persona-agents",
		branch: "dev",
		changed: [],
		changedCount: 0,
		files: [],
		...overrides,
	};
}

export function makeSnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		cwd: "/home/dev/persona-agents",
		tree: [],
		session: makeSession(),
		workspace: makeWorkspace(),
		mcp: [],
		todos: [],
		tps: 0,
		...overrides,
	};
}

/**
 * Four ask rows, newest first, as `sidebar-data.ts` writes them: the clock, the
 * role and tool, and the flag text of the child ask warning line. One row is
 * longer than width 45, so the panel wraps it.
 */
export function makeAskLogRows(): AskLogRow[] {
	const rows: Array<{ role: string; phase: AskPhase; flags: string }> = [
		{ role: "implementer/bash", phase: "expiry", flags: "waiting=0 shown=none place=slot parked=0 surface=yes" },
		{ role: "tester/bash", phase: "arrival", flags: "waiting=0 shown=this place=slot parked=1 surface=yes" },
		{ role: "reviewer/edit", phase: "expiry", flags: "waiting=1 shown=none place=queue parked=0 surface=yes" },
		{ role: "planner/write", phase: "arrival", flags: "waiting=0 shown=none place=slot parked=0 surface=no" },
	];
	return rows.map((row, index) => {
		const clock = `10:00:0${4 - index}`;
		return {
			kind: "ask" as const,
			askId: `root#${clock}`,
			phase: row.phase,
			at: `2026-11-07T${clock}.000Z`,
			text: `${clock} ${row.role} ${row.flags}`,
		};
	});
}

/**
 * The reference data the panel tests name: 3 tree nodes, 2 changed files with
 * stats, 2 MCP servers, 4 todos, and a full LOG ring. Every panel row count in
 * the composition tests follows from these values.
 */
export function makeFullSnapshot(): SidebarSnapshot {
	const child = makeNode({ runId: "child", parentRunId: "root", depth: 1, agent: "implementer" });
	const sibling = makeNode({ runId: "sibling", parentRunId: "root", depth: 1, agent: "tester" });
	return makeSnapshot({
		tree: [makeNode({ runId: "root", agent: "orchestrator", task: "work", children: [child, sibling] })],
		askLog: makeAskLogRows(),
		workspace: makeWorkspace({
			changed: ["a.ts", "b.md"],
			changedCount: 2,
			files: [
				{ path: "a.ts", added: 40, removed: 2, untracked: false },
				{ path: "b.md", added: 3, removed: 1, untracked: false },
			],
		}),
		mcp: [
			{ name: "context7", configured: true, connected: true, status: "connected" },
			{ name: "exa", configured: true, connected: false, status: "disconnected" },
		],
		todos: Array.from({ length: 4 }, (_value, index) => ({
			id: String(index),
			text: `todo ${index}`,
			done: false,
		})),
	});
}

export function assertFits(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
	}
}
