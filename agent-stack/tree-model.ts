/**
 * Agent tree model — pure.
 *
 * Folds a flat list of `RunEvent` records into a forest of `TreeNode`s. The
 * result is order-independent: the same records in any order give the same tree.
 *
 * No fs, no timers, no pi import. `tree-model.test.ts` runs under plain Node.
 */

import type { RunEvent, RunUsage } from "./tree-log.ts";

/** A node status. `stale` is derived, never stored in the log. */
export type TreeNodeStatus = "running" | "done" | "failed" | "stale";

/** One node in the agent tree. */
export interface TreeNode {
	runId: string;
	parentRunId: string | null;
	depth: number;
	agent: string;
	persona: string | null;
	status: TreeNodeStatus;
	startedAt: string;
	endedAt: string | null;
	task: string;
	bytesIn: number;
	bytesOut: number;
	usage: RunUsage | undefined;
	exitCode: number | null;
	error: string | null;
	outputPreview: string;
	orphan: boolean;
	children: TreeNode[];
}

/** Type rank for a same-timestamp tie-break; a terminal record wins. */
function typeRank(event: RunEvent): number {
	if (event.type === "end") return 2;
	if (event.type === "update") return 1;
	return 0;
}

/** Order-independent record comparison: by timestamp, then by type rank. */
function compareRecords(a: RunEvent, b: RunEvent): number {
	const ta = Date.parse(a.at);
	const tb = Date.parse(b.at);
	const na = Number.isFinite(ta) ? ta : 0;
	const nb = Number.isFinite(tb) ? tb : 0;
	if (na !== nb) return na - nb;
	const ra = typeRank(a);
	const rb = typeRank(b);
	if (ra !== rb) return ra - rb;
	return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** Sort siblings by start time. The run id breaks ties for a stable order. */
function byStartedAt(a: TreeNode, b: TreeNode): number {
	const ta = Date.parse(a.startedAt);
	const tb = Date.parse(b.startedAt);
	const na = Number.isFinite(ta) ? ta : 0;
	const nb = Number.isFinite(tb) ? tb : 0;
	if (na !== nb) return na - nb;
	return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** A running run older than `staleMs` is stale. A terminal run is never stale. */
function resolveStatus(
	start: RunEvent | undefined,
	end: RunEvent | undefined,
	startedAt: string,
	now: number,
	staleMs: number,
): TreeNodeStatus {
	if (end) return end.status === "failed" ? "failed" : "done";
	if (!start) return "running";
	const started = Date.parse(startedAt);
	if (Number.isFinite(started) && now - started > staleMs) return "stale";
	return "running";
}

/** Fold the records of one run into a node. */
function buildNode(runId: string, records: RunEvent[], now: number, staleMs: number): TreeNode {
	const sorted = records.slice().sort(compareRecords);
	const first = sorted[0];
	const start = sorted.find((record) => record.type === "start");
	const end = [...sorted].reverse().find((record) => record.type === "end");
	const latest = sorted[sorted.length - 1];
	const primary = start ?? first;
	const startedAt = start?.at ?? first.at;

	return {
		runId,
		parentRunId: primary.parentRunId ?? null,
		depth: primary.depth ?? 0,
		agent: primary.agent ?? "unknown",
		persona: primary.persona ?? null,
		status: resolveStatus(start, end, startedAt, now, staleMs),
		startedAt,
		endedAt: end?.at ?? null,
		task: latest.task ?? start?.task ?? "",
		bytesIn: latest.bytesIn ?? 0,
		bytesOut: latest.bytesOut ?? 0,
		usage: latest.usage ?? start?.usage,
		exitCode: end?.exitCode ?? latest.exitCode ?? null,
		error: end?.error ?? latest.error ?? null,
		outputPreview: end?.outputPreview ?? latest.outputPreview ?? "",
		orphan: false,
		children: [],
	};
}

/**
 * True when following `runId`'s parent chain returns to a node already visited
 * (a self-parent or a longer cycle). A missing parent is not a cycle; the
 * normal orphan branch handles it.
 */
function hasParentCycle(runId: string, nodes: Map<string, TreeNode>): boolean {
	const seen = new Set<string>([runId]);
	let current = nodes.get(runId)?.parentRunId ?? null;
	while (current !== null) {
		if (seen.has(current)) return true;
		seen.add(current);
		const parent = nodes.get(current);
		if (!parent) return false;
		current = parent.parentRunId;
	}
	return false;
}

/**
 * Assemble a forest from the flat event log.
 *
 * - Fold `start`/`update`/`end` by `runId`.
 * - Link children by `parentRunId`.
 * - A record whose parent has no `start` is `orphan: true` and attached at top level.
 * - A `start` with no `end` older than `staleMs` gets status `stale`.
 * - The record with `parentRunId === null` is a root/top node.
 */
export function assembleTree(events: RunEvent[], now: number, staleMs: number): TreeNode[] {
	const groups = new Map<string, RunEvent[]>();
	for (const event of events) {
		if (!event || typeof event.runId !== "string") continue;
		const list = groups.get(event.runId);
		if (list) list.push(event);
		else groups.set(event.runId, [event]);
	}

	const hasStart = new Set<string>();
	for (const [runId, records] of groups) {
		if (records.some((record) => record.type === "start")) hasStart.add(runId);
	}

	const nodes = new Map<string, TreeNode>();
	for (const [runId, records] of groups) {
		nodes.set(runId, buildNode(runId, records, now, staleMs));
	}

	const roots: TreeNode[] = [];
	for (const node of nodes.values()) {
		const parentId = node.parentRunId;
		if (parentId === null) {
			roots.push(node);
			continue;
		}
		// A self-parent or any parent cycle is an orphan at top level. This keeps
		// every node reachable from a root and stops a cycle from hiding a run.
		if (hasParentCycle(node.runId, nodes)) {
			node.orphan = true;
			roots.push(node);
		} else if (hasStart.has(parentId) && nodes.has(parentId)) {
			nodes.get(parentId)?.children.push(node);
		} else {
			node.orphan = true;
			roots.push(node);
		}
	}

	for (const node of nodes.values()) node.children.sort(byStartedAt);
	roots.sort(byStartedAt);
	return roots;
}

/** Depth-first walk, parents before children. */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	const seen = new Set<string>();
	const visit = (list: TreeNode[]): void => {
		for (const node of list) {
			if (seen.has(node.runId)) continue;
			seen.add(node.runId);
			out.push(node);
			visit(node.children);
		}
	};
	visit(nodes);
	return out;
}

/** Find one node by run id in a forest. */
export function findNode(nodes: TreeNode[], runId: string): TreeNode | undefined {
	return flattenTree(nodes).find((node) => node.runId === runId);
}
