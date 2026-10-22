/**
 * Shared fixtures for the sidebar renderer tests.
 *
 * Builds tree nodes and workspace, session, and sidebar snapshots, and checks
 * that rendered lines fit a width.
 */

import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionSnapshot, SidebarSnapshot, SidebarTheme, WorkspaceSnapshot } from "./sidebar-render.ts";
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

export function assertFits(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
	}
}

/** Lines are right-padded to the column width; trim for content checks. */
export function content(lines: string[]): string[] {
	return lines.map((line) => line.trimEnd());
}
