/**
 * Tree repaint signature — pure.
 *
 * Builds the cache key that skips a repaint when no painted value changed. The
 * walk keeps every node, so a key never hides a node the painter draws. No fs,
 * no timer, no pi runtime import.
 */

import type { SidebarSnapshot } from "./sidebar-render.ts";
import type { TreeNode } from "./tree-model.ts";

/** Depth-first walk, parents before children, original sibling order. */
function walk(nodes: TreeNode[], out: TreeNode[]): void {
	for (const node of nodes) {
		out.push(node);
		walk(node.children, out);
	}
}

/**
 * Flatten a forest depth-first, keeping every node.
 *
 * The keep is defensive only: `assembleTree` stores one node per run id, so a
 * shipped snapshot never repeats one. `flattenTree` drops a repeat instead.
 */
function flatten(nodes: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	walk(nodes, out);
	return out;
}

/**
 * A signature that changes when any painted content changes.
 *
 * Serializes every field a panel or the node-detail view paints, with
 * `JSON.stringify`. `null` and `""` stay distinct, and no field is sliced.
 * Tasks are already capped at append time, so the full value is safe. Node
 * fields no view paints (`bytesIn`, `bytesOut`, `children`) stay out, so
 * they cannot trigger a needless repaint.
 */
export function treeSignature(snapshot: SidebarSnapshot): string {
	const tree = flatten(snapshot.tree ?? []).map((node) => ({
		runId: node.runId,
		status: node.status,
		orphan: node.orphan,
		agent: node.agent,
		depth: node.depth,
		task: node.task,
		toolCount: node.toolCount,
		round: node.round ?? null,
		resumed: node.resumed === true,
		outputPreview: node.outputPreview,
		usage: node.usage,
		exitCode: node.exitCode ?? null,
		error: node.error ?? null,
	}));

	const session = snapshot.session
		? {
				model: snapshot.session.model,
				thinkingLevel: snapshot.session.thinkingLevel,
				contextTokens: snapshot.session.contextTokens,
				contextWindow: snapshot.session.contextWindow,
				contextPercent: snapshot.session.contextPercent,
				cost: snapshot.session.cost,
				tps: snapshot.session.tps,
				tokensIn: snapshot.session.tokensIn,
				tokensOut: snapshot.session.tokensOut,
				turns: snapshot.session.turns,
				sessionStartMs: snapshot.session.sessionStartMs,
			}
		: null;

	const workspace = snapshot.workspace
		? {
				cwd: snapshot.workspace.cwd,
				branch: snapshot.workspace.branch,
				changed: snapshot.workspace.changed,
				changedCount: snapshot.workspace.changedCount,
				files: snapshot.workspace.files,
			}
		: null;

	const mcp = (snapshot.mcp ?? []).map((server) => ({
		name: server.name,
		configured: server.configured,
		connected: server.connected,
		status: server.status,
	}));

	const todos = (snapshot.todos ?? []).map((todo) => ({
		id: todo.id,
		text: todo.text ?? "",
		done: todo.done,
	}));

	const status = snapshot.status ?? null;

	// The stamp joins the key so two rows with one text still repaint; the
	// painters read the row text only.
	const askLog = (snapshot.askLog ?? []).map((row) => ({
		askId: row.askId,
		phase: row.phase,
		at: row.at,
		text: row.text,
	}));

	return JSON.stringify({
		cwd: snapshot.cwd,
		tree,
		status,
		askLog,
		session,
		workspace,
		mcp,
		mcpUsage: snapshot.mcpUsage ?? {},
		todos,
		todosTurnMarker: snapshot.todosTurnMarker === true,
		tps: snapshot.tps,
	});
}
