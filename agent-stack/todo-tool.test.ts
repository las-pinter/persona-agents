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
import {
	applyTodoOperation,
	emptyTodoState,
	reconstructTodosFromEntries,
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

test("list does not mutate and summarizes the list", () => {
	const added = run(emptyTodoState(), { action: "add", text: "one" });
	const before: TodoState = { todos: added.state.todos.map((todo) => ({ ...todo })), nextId: added.state.nextId };
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
