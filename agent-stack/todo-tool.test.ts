/**
 * Offline regression harness for the pure `todo` tool core.
 *
 * Runs under plain Node (type stripping) with no pi runtime:
 *   npm run test:permissions -- agent-stack/todo-tool.test.ts
 *
 * Covers the plan's Task 19 todo-tool cases: add, toggle, remove, clear, list,
 * session-entry reconstruction, error results (never throws), and the `details`
 * shape.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyTodoOperation,
	beginTurn,
	emptyTodoState,
	reconstructTodosFromEntries,
	registerTodoTool,
	TODOS_EVENT_CHANNEL,
	TODOS_TURN_ENTRY,
	type TodoSessionEntry,
	type TodoState,
} from "./todo-tool.ts";

/** Apply one operation and give back the next state and the result. */
function run(state: TodoState, input: Parameters<typeof applyTodoOperation>[1]) {
	return applyTodoOperation(state, input);
}

test("add appends an item and advances nextId", () => {
	const { state, result, mutated } = run(emptyTodoState(), { action: "add", text: "write the plan" });

	assert.equal(mutated, true);
	assert.deepEqual(state.todos, [{ id: "1", text: "write the plan", done: false }]);
	assert.equal(state.nextId, 2);
	assert.equal(result.isError, false);
	assert.equal(result.details.action, "add");
});

test("add twice gives incrementing ids", () => {
	const first = run(emptyTodoState(), { action: "add", text: "one" });
	const second = run(first.state, { action: "add", text: "two" });

	assert.deepEqual(
		second.state.todos.map((todo) => todo.id),
		["1", "2"],
	);
	assert.equal(second.state.nextId, 3);
});

test("toggle flips done and keeps nextId", () => {
	const added = run(emptyTodoState(), { action: "add", text: "one" });
	const toggled = run(added.state, { action: "toggle", id: "1" });

	assert.equal(toggled.state.todos[0]?.done, true);
	assert.equal(toggled.state.nextId, 2);
	assert.equal(toggled.result.isError, false);

	const back = run(toggled.state, { action: "toggle", id: "1" });
	assert.equal(back.state.todos[0]?.done, false);
});

test("remove drops the item and keeps nextId", () => {
	const first = run(emptyTodoState(), { action: "add", text: "one" });
	const second = run(first.state, { action: "add", text: "two" });
	const removed = run(second.state, { action: "remove", id: "1" });

	assert.deepEqual(
		removed.state.todos.map((todo) => todo.id),
		["2"],
	);
	assert.equal(removed.state.nextId, 3);
	assert.equal(removed.result.isError, false);
});

test("clear empties the list and resets nextId to 1", () => {
	const first = run(emptyTodoState(), { action: "add", text: "one" });
	const second = run(first.state, { action: "add", text: "two" });
	const cleared = run(second.state, { action: "clear" });

	assert.deepEqual(cleared.state.todos, []);
	assert.equal(cleared.state.nextId, 1);
	assert.equal(cleared.mutated, true);
});

test("clear keeps the turn and the turn marker", () => {
	const state: TodoState = {
		todos: [{ id: "1", text: "one", done: false }],
		nextId: 2,
		turn: 2,
		showTurnMarker: true,
	};
	const cleared = run(state, { action: "clear" });

	assert.deepEqual(cleared.state.todos, []);
	assert.equal(cleared.state.nextId, 1);
	assert.equal(cleared.state.turn, 2);
	assert.equal(cleared.state.showTurnMarker, true);
});

test("list does not mutate and summarizes the list", () => {
	const added = run(emptyTodoState(), { action: "add", text: "one" });
	const before: TodoState = {
		todos: added.state.todos.map((todo) => ({ ...todo })),
		nextId: added.state.nextId,
		turn: added.state.turn,
		showTurnMarker: added.state.showTurnMarker,
	};
	const listed = run(added.state, { action: "list" });

	assert.equal(listed.mutated, false);
	assert.deepEqual(listed.state, before);
	assert.match(listed.result.content, /#1: one/);
});

test("missing text returns an error result, not a throw", () => {
	const state = emptyTodoState();
	let outcome: ReturnType<typeof applyTodoOperation> | undefined;
	assert.doesNotThrow(() => {
		outcome = run(state, { action: "add" });
	});

	assert.equal(outcome?.result.isError, true);
	assert.equal(outcome?.mutated, false);
	assert.equal(outcome?.result.details.error, "text required");
	assert.deepEqual(outcome?.state, state);
});

test("missing id returns an error result for toggle and remove", () => {
	for (const action of ["toggle", "remove"] as const) {
		const outcome = run(emptyTodoState(), { action });
		assert.equal(outcome.result.isError, true, `${action} must error without id`);
		assert.equal(outcome.result.details.error, "id required");
	}
});

test("unknown id returns an error result, not a throw", () => {
	for (const action of ["toggle", "remove"] as const) {
		let outcome: ReturnType<typeof applyTodoOperation> | undefined;
		assert.doesNotThrow(() => {
			outcome = run(emptyTodoState(), { action, id: "99" });
		});
		assert.equal(outcome?.result.isError, true);
		assert.equal(outcome?.result.details.error, "#99 not found");
	}
});

test("details shape is action, todos, nextId and optional error", () => {
	const added = run(emptyTodoState(), { action: "add", text: "one" });
	assert.deepEqual(Object.keys(added.result.details).sort(), ["action", "nextId", "todos"]);
	assert.deepEqual(added.result.details.todos, [{ id: "1", text: "one", done: false }]);
	assert.equal(typeof added.result.details.nextId, "number");
	assert.equal(added.result.details.action, "add");

	const failed = run(added.state, { action: "toggle", id: "42" });
	assert.deepEqual(Object.keys(failed.result.details).sort(), ["action", "error", "nextId", "todos"]);
	assert.equal(failed.result.details.action, "toggle");
	assert.equal(typeof failed.result.details.error, "string");
});

test("reconstruct restores the last todo state from session entries", () => {
	const first: TodoSessionEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { action: "add", todos: [{ id: "1", text: "one", done: false }], nextId: 2 },
		},
	};
	const second: TodoSessionEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: {
				action: "toggle",
				todos: [
					{ id: "1", text: "one", done: true },
					{ id: "2", text: "two", done: false },
				],
				nextId: 3,
			},
		},
	};

	const state = reconstructTodosFromEntries([first, second]);
	assert.deepEqual(state.todos, [
		{ id: "1", text: "one", done: true },
		{ id: "2", text: "two", done: false },
	]);
	assert.equal(state.nextId, 3);
});

test("reconstruct skips other tools and non-message entries", () => {
	const entries: TodoSessionEntry[] = [
		{ type: "thinking_level_change" },
		{ type: "message", message: { role: "assistant" } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: { todos: [{ id: "x" }] } } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { bogus: true } } },
	];

	assert.deepEqual(reconstructTodosFromEntries(entries), emptyTodoState());
});

test("reconstruct drops malformed todo items", () => {
	const entries: TodoSessionEntry[] = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "add",
					todos: [{ id: 1, text: "one", done: true }, null, { id: "2" }],
					nextId: 5,
				},
			},
		},
	];

	const state = reconstructTodosFromEntries(entries);
	assert.deepEqual(state.todos, [{ id: "1", text: "one", done: true }]);
	assert.equal(state.nextId, 5);
});

// --- turn prune --------------------------------------------------------------

test("beginTurn removes done, keeps undone, bumps turn, sets marker", () => {
	const state: TodoState = {
		todos: [
			{ id: "1", text: "done A", done: true },
			{ id: "2", text: "open B", done: false },
			{ id: "3", text: "done C", done: true },
		],
		nextId: 4,
		turn: 2,
		showTurnMarker: false,
	};

	const next = beginTurn(state);

	assert.deepEqual(next.todos, [{ id: "2", text: "open B", done: false }]);
	assert.equal(next.nextId, 4);
	assert.equal(next.turn, 3);
	assert.equal(next.showTurnMarker, true);
});

test("beginTurn on an empty list keeps nextId and raises the marker", () => {
	const start: TodoState = { todos: [], nextId: 7, turn: 0, showTurnMarker: false };

	const next = beginTurn(start);

	assert.deepEqual(next.todos, []);
	assert.equal(next.nextId, 7);
	assert.equal(next.turn, 1);
	assert.equal(next.showTurnMarker, true);
});

test("beginTurn on an all-done list empties it and raises the marker", () => {
	const state: TodoState = {
		todos: [
			{ id: "1", text: "done A", done: true },
			{ id: "2", text: "done B", done: true },
		],
		nextId: 3,
		turn: 2,
		showTurnMarker: false,
	};

	const next = beginTurn(state);

	assert.deepEqual(next.todos, []);
	assert.equal(next.nextId, 3);
	assert.equal(next.turn, 3);
	assert.equal(next.showTurnMarker, true, "the marker must show on the emptied list");
});

test("beginTurn does not mutate the input state", () => {
	const state: TodoState = {
		todos: [
			{ id: "1", text: "done", done: true },
			{ id: "2", text: "open", done: false },
		],
		nextId: 3,
		turn: 1,
		showTurnMarker: false,
	};
	const copy: TodoState = {
		todos: state.todos.map((todo) => ({ ...todo })),
		nextId: state.nextId,
		turn: state.turn,
		showTurnMarker: state.showTurnMarker,
	};

	beginTurn(state);

	assert.deepEqual(state, copy);
});

// --- turn boundary persistence ----------------------------------------------

test("a turn boundary entry restores todos, nextId, turn, and marker", () => {
	const entry: TodoSessionEntry = {
		type: "custom",
		customType: TODOS_TURN_ENTRY,
		data: {
			todos: [{ id: "2", text: "open", done: false }],
			nextId: 4,
			turn: 5,
			showTurnMarker: true,
		},
	};

	const state = reconstructTodosFromEntries([entry]);

	assert.deepEqual(state.todos, [{ id: "2", text: "open", done: false }]);
	assert.equal(state.nextId, 4);
	assert.equal(state.turn, 5);
	assert.equal(state.showTurnMarker, true);
});

test("a tool result after a boundary keeps the boundary turn and marker", () => {
	const boundary: TodoSessionEntry = {
		type: "custom",
		customType: TODOS_TURN_ENTRY,
		data: { todos: [{ id: "2", text: "open", done: false }], nextId: 3, turn: 5, showTurnMarker: true },
	};
	const result: TodoSessionEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: {
				action: "toggle",
				todos: [{ id: "2", text: "open", done: true }],
				nextId: 3,
			},
		},
	};

	const state = reconstructTodosFromEntries([boundary, result]);

	assert.deepEqual(state.todos, [{ id: "2", text: "open", done: true }]);
	assert.equal(state.nextId, 3);
	assert.equal(state.turn, 5);
	assert.equal(state.showTurnMarker, true);
});

test("a boundary entry without a turn keeps the running turn", () => {
	const first: TodoSessionEntry = {
		type: "custom",
		customType: TODOS_TURN_ENTRY,
		data: { todos: [], nextId: 1, turn: 5, showTurnMarker: true },
	};
	const second: TodoSessionEntry = {
		type: "custom",
		customType: TODOS_TURN_ENTRY,
		data: { todos: [], nextId: 1, showTurnMarker: true },
	};

	const state = reconstructTodosFromEntries([first, second]);

	assert.equal(state.turn, 5, "a reset would give 0");
	assert.equal(state.showTurnMarker, true);
});

test("a boundary entry with a malformed turn keeps the running turn", () => {
	const first: TodoSessionEntry = {
		type: "custom",
		customType: TODOS_TURN_ENTRY,
		data: { todos: [], nextId: 1, turn: 5, showTurnMarker: true },
	};
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "7" as unknown as number]) {
		const second: TodoSessionEntry = {
			type: "custom",
			customType: TODOS_TURN_ENTRY,
			data: { todos: [], nextId: 1, turn: bad, showTurnMarker: true },
		};
		const state = reconstructTodosFromEntries([first, second]);
		assert.equal(state.turn, 5, `turn ${String(bad)} must not replace a running turn`);
	}
});

test("old tool-result entries reconstruct to turn 0 and no marker", () => {
	const entry: TodoSessionEntry = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { action: "add", todos: [{ id: "1", text: "one", done: true }], nextId: 2 },
		},
	};

	const state = reconstructTodosFromEntries([entry]);

	assert.equal(state.turn, 0);
	assert.equal(state.showTurnMarker, false);
});

test("reconstruction applies multiple boundaries and tool results in order", () => {
	const entries: TodoSessionEntry[] = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "add",
					todos: [
						{ id: "1", text: "done A", done: true },
						{ id: "2", text: "open B", done: false },
					],
					nextId: 3,
				},
			},
		},
		{
			type: "custom",
			customType: TODOS_TURN_ENTRY,
			data: { todos: [{ id: "2", text: "open B", done: false }], nextId: 3, turn: 1, showTurnMarker: true },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "toggle", todos: [{ id: "2", text: "open B", done: true }], nextId: 3 },
			},
		},
		{
			type: "custom",
			customType: TODOS_TURN_ENTRY,
			data: { todos: [], nextId: 4, turn: 2, showTurnMarker: true },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "add", todos: [{ id: "3", text: "open C", done: false }], nextId: 4 },
			},
		},
	];

	const state = reconstructTodosFromEntries(entries);

	assert.deepEqual(state.todos, [{ id: "3", text: "open C", done: false }]);
	assert.equal(state.nextId, 4);
	assert.equal(state.turn, 2);
	assert.equal(state.showTurnMarker, true);
});

test("reconstruct skips a malformed turn boundary payload", () => {
	const entries: TodoSessionEntry[] = [
		{ type: "custom", customType: TODOS_TURN_ENTRY, data: null },
		{ type: "custom", customType: TODOS_TURN_ENTRY, data: { nextId: 1 } },
		{ type: "custom", customType: TODOS_TURN_ENTRY, data: { todos: [], nextId: Number.NaN } },
		{ type: "custom", customType: TODOS_TURN_ENTRY, data: { todos: [], nextId: Number.POSITIVE_INFINITY } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "add", todos: [{ id: "1", text: "one", done: false }], nextId: 2 },
			},
		},
	];

	const state = reconstructTodosFromEntries(entries);

	assert.deepEqual(state.todos, [{ id: "1", text: "one", done: false }]);
	assert.equal(state.nextId, 2);
	assert.equal(state.turn, 0, "a rejected boundary must not advance the turn");
	assert.equal(state.showTurnMarker, false, "a rejected boundary must not raise the marker");
});

// --- before_agent_start wiring ----------------------------------------------

/** One captured `before_agent_start` handler and the writes it caused. */
interface TodoPiHarness {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	appended: Array<{ customType: string; data: unknown }>;
	emitted: Array<{ channel: string; payload: unknown }>;
}

/** A fake pi that records handler registration, appends, and emits. */
function makeTodoPi(): TodoPiHarness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const pi: Record<string, unknown> = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerTool: () => {},
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
		events: {
			on: () => () => {},
			emit: (channel: string, payload: unknown) => {
				emitted.push({ channel, payload });
			},
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, appended, emitted };
}

/** A fake context whose session branch is fixed. */
function makeSessionCtx(branch: unknown[]): ExtensionContext {
	return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

/** A branch with one done todo and one open todo. */
function doneAndOpenBranch(): unknown[] {
	return [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "add",
					todos: [
						{ id: "1", text: "done A", done: true },
						{ id: "2", text: "open B", done: false },
					],
					nextId: 3,
				},
			},
		},
	];
}

/** Run `body` with the parent run id absent, then restore the old value. */
function asRoot(body: () => void): void {
	const original = process.env.PI_AGENT_PARENT_RUN_ID;
	delete process.env.PI_AGENT_PARENT_RUN_ID;
	try {
		body();
	} finally {
		if (original === undefined) delete process.env.PI_AGENT_PARENT_RUN_ID;
		else process.env.PI_AGENT_PARENT_RUN_ID = original;
	}
}

test("before_agent_start prunes done todos and records the boundary", () => {
	asRoot(() => {
		const harness = makeTodoPi();
		registerTodoTool(harness.pi);
		const ctx = makeSessionCtx(doneAndOpenBranch());
		harness.handlers.get("session_start")?.({}, ctx);
		harness.handlers.get("before_agent_start")?.({}, ctx);

		assert.equal(harness.appended.length, 1);
		assert.equal(harness.appended[0]?.customType, TODOS_TURN_ENTRY);
		assert.deepEqual(harness.appended[0]?.data, {
			todos: [{ id: "2", text: "open B", done: false }],
			nextId: 3,
			turn: 1,
			showTurnMarker: true,
		});

		assert.equal(harness.emitted.length, 1);
		assert.equal(harness.emitted[0]?.channel, TODOS_EVENT_CHANNEL);
		const payload = harness.emitted[0]?.payload as {
			todos: unknown[];
			nextId: number;
			turn: number;
			showTurnMarker: boolean;
			at: string;
		};
		assert.deepEqual(payload.todos, [{ id: "2", text: "open B", done: false }]);
		assert.equal(payload.nextId, 3);
		assert.equal(payload.turn, 1);
		assert.equal(payload.showTurnMarker, true);
		assert.equal(typeof payload.at, "string");
	});
});

test("before_agent_start on an all-done list emits the marker with no todos", () => {
	asRoot(() => {
		const harness = makeTodoPi();
		registerTodoTool(harness.pi);
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						action: "toggle",
						todos: [{ id: "1", text: "done A", done: true }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = makeSessionCtx(branch);
		harness.handlers.get("session_start")?.({}, ctx);
		harness.handlers.get("before_agent_start")?.({}, ctx);

		assert.deepEqual(harness.appended[0]?.data, {
			todos: [],
			nextId: 2,
			turn: 1,
			showTurnMarker: true,
		});
		const payload = harness.emitted[0]?.payload as {
			todos: unknown[];
			showTurnMarker: boolean;
		};
		assert.deepEqual(payload.todos, [], "the emptied list carries no done todos");
		assert.equal(payload.showTurnMarker, true, "the marker must show on the emptied list");
	});
});

test("before_agent_start does nothing in a child process", () => {
	const original = process.env.PI_AGENT_PARENT_RUN_ID;
	process.env.PI_AGENT_PARENT_RUN_ID = "parent";
	try {
		const harness = makeTodoPi();
		registerTodoTool(harness.pi);
		const ctx = makeSessionCtx(doneAndOpenBranch());
		harness.handlers.get("session_start")?.({}, ctx);
		harness.handlers.get("before_agent_start")?.({}, ctx);

		assert.equal(harness.appended.length, 0, "no boundary is written");
		assert.equal(harness.emitted.length, 0, "no snapshot is published");

		// A later root call must prune once, not twice.
		delete process.env.PI_AGENT_PARENT_RUN_ID;
		harness.handlers.get("before_agent_start")?.({}, ctx);
		const payload = harness.emitted[0]?.payload as { turn: number };
		assert.equal(payload.turn, 1);
	} finally {
		if (original === undefined) delete process.env.PI_AGENT_PARENT_RUN_ID;
		else process.env.PI_AGENT_PARENT_RUN_ID = original;
	}
});
