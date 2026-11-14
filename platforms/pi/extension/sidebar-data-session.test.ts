/**
 * Sidebar data tests for the session snapshot: the token and turn sums, the
 * session start, and the todo turn marker.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data-session.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSidebarData } from "./sidebar-data.ts";
import {
	makeCapturingPi,
	makeEventBusPi,
	makeFakeCtx,
	makeFakePi,
	markedBranch,
	readSession,
} from "./sidebar-data-fixtures.ts";
import { TODOS_EVENT_CHANNEL, TODOS_TURN_ENTRY } from "./todo-tool.ts";

// --- session usage sums ------------------------------------------------------

test("two assistant messages sum tokens and count turns", () => {
	const session = readSession([
		{ type: "meta", timestamp: "2026-01-01T00:00:00.000Z" },
		{
			type: "message",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.01 } } },
		},
		{
			type: "message",
			timestamp: "2026-01-01T00:00:10.000Z",
			message: { role: "assistant", usage: { input: 200, output: 40, cost: { total: 0.02 } } },
		},
	]);

	assert.equal(session.tokensIn, 300);
	assert.equal(session.tokensOut, 60);
	assert.equal(session.turns, 2);
	assert.equal(session.sessionStartMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("the earliest entry sets the session start even when it is not a message", () => {
	const session = readSession([
		{ type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
		{ type: "meta", timestamp: "2026-01-01T00:00:00.000Z" },
	]);

	assert.equal(session.sessionStartMs, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("a user message is not counted as an assistant turn", () => {
	const session = readSession([
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{
			type: "message",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0 } } },
		},
	]);

	assert.equal(session.turns, 1);
	assert.equal(session.tokensIn, 7);
	assert.equal(session.tokensOut, 3);
});

// --- todo turn marker plumbing -----------------------------------------------

test("a todo payload with showTurnMarker true sets the snapshot marker", () => {
	const { pi, handlers } = makeEventBusPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx());
		assert.equal(data.snapshot().todosTurnMarker, false, "the default is no marker");

		handlers.get(TODOS_EVENT_CHANNEL)?.({
			todos: [{ id: "1", text: "a", done: false }],
			nextId: 2,
			showTurnMarker: true,
		});
		assert.equal(data.snapshot().todosTurnMarker, true);

		handlers.get(TODOS_EVENT_CHANNEL)?.({ todos: [], nextId: 1 });
		assert.equal(data.snapshot().todosTurnMarker, false, "a payload without the flag clears it");
	} finally {
		data.dispose();
	}
});

test("refreshTodosFromEntries carries the reconstructed turn marker", () => {
	const branch = [
		{
			type: "custom",
			customType: TODOS_TURN_ENTRY,
			data: {
				todos: [{ id: "1", text: "a", done: false }],
				nextId: 2,
				turn: 3,
				showTurnMarker: true,
			},
		},
	];
	const data = createSidebarData(makeFakePi({}));
	try {
		data.subscribe(makeFakeCtx(branch));
		assert.equal(data.snapshot().todosTurnMarker, true);
		assert.deepEqual(data.snapshot().todos, [{ id: "1", text: "a", done: false }]);
	} finally {
		data.dispose();
	}
});

test("a failed todo refresh clears the todos and the turn marker", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx(markedBranch()));
		assert.equal(data.snapshot().todosTurnMarker, true, "the marker is set before the failure");

		const throwingCtx = {
			...makeFakeCtx([]),
			sessionManager: {
				getBranch: () => {
					throw new Error("branch-boom");
				},
			},
		} as unknown as ExtensionContext;
		piHandlers.get("session_start")?.({}, throwingCtx);

		assert.deepEqual(data.snapshot().todos, [], "the failed refresh clears the list");
		assert.equal(data.snapshot().todosTurnMarker, false, "the failed refresh clears the marker");
	} finally {
		data.dispose();
	}
});

test("agent_end does not clear the turn marker", () => {
	const { pi, piHandlers } = makeCapturingPi();
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx(markedBranch()));
		assert.equal(data.snapshot().todosTurnMarker, true);

		// An empty branch would clear the marker if agent_end refreshed the todos.
		piHandlers.get("agent_end")?.({}, makeFakeCtx([]));

		assert.equal(data.snapshot().todosTurnMarker, true, "the marker survives the end of the turn");
	} finally {
		data.dispose();
	}
});
