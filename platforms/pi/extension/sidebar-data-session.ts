/**
 * Sidebar data: the session fields, the TPS window, and the TODOS list.
 *
 * The session read is the only writer of the session snapshot, the TPS window,
 * and the TODOS list. The TODOS list comes from the event payload or from the
 * session entries.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InternalState } from "./sidebar-data.ts";
import { applyWorkspace } from "./sidebar-data-git.ts";
import { reconstructTodosFromEntries } from "./todo-tool.ts";

/** TPS sliding window. */
const TPS_WINDOW_MS = 2000;

/** Sum assistant `usage` over a session branch and find the branch start. */
function sumBranchUsage(ctx: ExtensionContext): {
	cost: number;
	tokensIn: number;
	tokensOut: number;
	turns: number;
	sessionStartMs: number | null;
} {
	try {
		const entries = ctx.sessionManager.getBranch();
		let cost = 0;
		let tokensIn = 0;
		let tokensOut = 0;
		let turns = 0;
		let sessionStartMs: number | null = null;
		for (const entry of entries) {
			const parsed = Date.parse(entry.timestamp);
			if (Number.isFinite(parsed) && (sessionStartMs === null || parsed < sessionStartMs)) {
				sessionStartMs = parsed;
			}
			if (entry.type !== "message") continue;
			const message = entry.message as {
				role?: string;
				usage?: {
					input?: number;
					output?: number;
					cost?: { total?: number };
				};
			};
			if (message?.role !== "assistant") continue;
			turns += 1;
			const total = message.usage?.cost?.total;
			if (typeof total === "number" && Number.isFinite(total)) cost += total;
			const input = message.usage?.input;
			if (typeof input === "number" && Number.isFinite(input)) tokensIn += input;
			const output = message.usage?.output;
			if (typeof output === "number" && Number.isFinite(output)) tokensOut += output;
		}
		return { cost, tokensIn, tokensOut, turns, sessionStartMs };
	} catch {
		return { cost: 0, tokensIn: 0, tokensOut: 0, turns: 0, sessionStartMs: null };
	}
}

/** Recompute the TPS sliding window and write it into the snapshot. */
function updateTps(state: InternalState, now: number): void {
	const cutoff = now - TPS_WINDOW_MS;
	state.tpsSamples = state.tpsSamples.filter((sample) => sample.at >= cutoff);
	let tps = 0;
	if (state.tpsSamples.length > 0) {
		const total = state.tpsSamples.reduce((sum, sample) => sum + sample.tokens, 0);
		const oldest = state.tpsSamples[0].at;
		const seconds = Math.max(1, (now - oldest) / 1000);
		tps = total / seconds;
	}
	state.snapshot.tps = tps;
	state.snapshot.session.tps = tps;
}

/** Read one context into the session snapshot. */
export function refreshSession(state: InternalState, ctx: ExtensionContext): void {
	const session = { ...state.snapshot.session };
	try {
		session.model = ctx.model?.id ?? null;
	} catch {
		session.model = null;
	}
	session.thinkingLevel = ctx.thinkingLevel ?? null;

	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	try {
		usage = ctx.getContextUsage();
	} catch {
		usage = undefined;
	}
	session.contextTokens = usage?.tokens ?? null;
	session.contextWindow = usage?.contextWindow ?? null;
	session.contextPercent = usage?.percent ?? null;
	const branchUsage = sumBranchUsage(ctx);
	session.cost = branchUsage.cost;
	session.tokensIn = branchUsage.tokensIn;
	session.tokensOut = branchUsage.tokensOut;
	session.turns = branchUsage.turns;
	session.sessionStartMs = branchUsage.sessionStartMs;

	state.snapshot.session = session;
	const cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
	// A new directory invalidates the old branch name; the next poll reads it.
	if (cwd !== state.snapshot.workspace.cwd) state.branch = null;
	state.snapshot.cwd = cwd;
	state.snapshot.workspace.cwd = cwd;
	updateTps(state, Date.now());
	applyWorkspace(state);
}

/** Zero the output-token counter, so the next message starts a fresh delta. */
export function resetOutputTokens(state: InternalState): void {
	state.lastOutputTokens = 0;
}

/** Apply one `persona-agents/todos/v1` payload. Bad data is ignored. */
export function applyTodoPayload(state: InternalState, data: unknown): void {
	if (typeof data !== "object" || data === null) return;
	const payload = data as { todos?: unknown; nextId?: unknown; showTurnMarker?: unknown };
	if (!Array.isArray(payload.todos)) return;
	const todos: Array<{ id: string; text: string; done: boolean }> = [];
	for (const item of payload.todos) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as { id?: unknown; text?: unknown; done?: unknown };
		if (candidate.id === undefined || candidate.text === undefined) continue;
		todos.push({
			id: String(candidate.id),
			text: String(candidate.text),
			done: candidate.done === true,
		});
	}
	state.snapshot.todos = todos;
	state.snapshot.todosTurnMarker = payload.showTurnMarker === true;
	if (typeof payload.nextId === "number" && Number.isFinite(payload.nextId)) {
		state.todosNextId = payload.nextId;
	}
}

/** Rebuild TODOS from session entries, for `/reload` and resume. */
export function refreshTodosFromEntries(state: InternalState, ctx: ExtensionContext): void {
	try {
		const reconstructed = reconstructTodosFromEntries(ctx.sessionManager.getBranch());
		state.snapshot.todos = reconstructed.todos.map((todo) => ({
			id: todo.id,
			text: todo.text,
			done: todo.done,
		}));
		state.snapshot.todosTurnMarker = reconstructed.showTurnMarker;
		state.todosNextId = reconstructed.nextId;
	} catch {
		state.snapshot.todos = [];
		state.snapshot.todosTurnMarker = false;
	}
}

/** Feed one `message_update` into the TPS window. */
export function feedTps(state: InternalState, event: { assistantMessageEvent?: unknown }): void {
	const evt = event?.assistantMessageEvent as
		| { type?: string; delta?: unknown; partial?: { usage?: { output?: unknown } } }
		| undefined;
	let deltaTokens = 0;
	const output = evt?.partial?.usage?.output;
	if (typeof output === "number" && Number.isFinite(output)) {
		const diff = output - state.lastOutputTokens;
		if (diff > 0) {
			deltaTokens = diff;
			state.lastOutputTokens = output;
		}
	}
	if (deltaTokens === 0) {
		// Char/4 fallback when usage is absent or not yet streaming.
		if (
			(evt?.type === "text_delta" ||
				evt?.type === "thinking_delta" ||
				evt?.type === "toolcall_delta") &&
			typeof evt.delta === "string"
		) {
			deltaTokens = evt.delta.length / 4;
		}
	}
	if (deltaTokens > 0) {
		state.tpsSamples.push({ at: Date.now(), tokens: deltaTokens });
	}
	updateTps(state, Date.now());
}
