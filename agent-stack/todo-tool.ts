/**
 * `todo` tool — state, registration, and event emit.
 *
 * pi core has no todo tool. This module adds one so the TODOS sidebar panel has
 * real data. Session entries are the source of truth; an in-memory cache is the
 * fast path. The pure core (`applyTodoOperation`, `reconstructTodosFromEntries`)
 * has no pi import, so `todo-tool.test.ts` runs without a pi runtime.
 *
 * No filesystem access, no shell, no process spawn.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** One todo item. `id` is a string so it can feed the pure renderer directly. */
export interface Todo {
	id: string;
	text: string;
	done: boolean;
}

/** Todo tool actions. Operations, not a replace-list. */
export type TodoAction = "list" | "add" | "toggle" | "remove" | "clear";

/** The tool result `details` payload. */
export interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	error?: string;
}

/** The full todo state. */
export interface TodoState {
	todos: Todo[];
	nextId: number;
}

/** Input for one pure operation. */
export interface TodoOperationInput {
	action: TodoAction;
	text?: string;
	id?: string;
}

/** A model-facing result of one pure operation. */
export interface TodoOperationResult {
	content: string;
	details: TodoDetails;
	isError: boolean;
}

/** Outcome of one pure operation: the next state, the result, and whether the list changed. */
export interface TodoOperationOutcome {
	state: TodoState;
	result: TodoOperationResult;
	mutated: boolean;
}

/**
 * Minimal structural shape of a session entry. A real pi `SessionEntry[]` is
 * assignable, so callers pass `ctx.sessionManager.getBranch()` directly.
 */
export interface TodoSessionEntry {
	type?: string;
	message?:
		| {
				role?: string;
				toolName?: string;
				details?: unknown;
		  }
		| undefined;
}

/** pi.events channel that publishes the todo snapshot. */
export const TODOS_EVENT_CHANNEL = "persona-agents/todos/v1";

/** TypeBox schema for the `todo` tool input. */
export const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.String({ description: "Todo id (for toggle and remove)" })),
});

/** A fresh empty state. */
export function emptyTodoState(): TodoState {
	return { todos: [], nextId: 1 };
}

/** Copy a state so callers cannot mutate the input through the result. */
function cloneState(state: TodoState): TodoState {
	return { todos: state.todos.map((todo) => ({ ...todo })), nextId: state.nextId };
}

/** A one-line-per-todo summary for the model. */
function describeTodos(todos: readonly Todo[]): string {
	if (todos.length === 0) return "No todos";
	return todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n");
}

function success(state: TodoState, action: TodoAction, content: string): TodoOperationOutcome {
	return {
		state,
		mutated: action !== "list",
		result: {
			content,
			details: { action, todos: state.todos.map((todo) => ({ ...todo })), nextId: state.nextId },
			isError: false,
		},
	};
}

function failure(
	state: TodoState,
	action: TodoAction,
	content: string,
	error: string,
): TodoOperationOutcome {
	return {
		state,
		mutated: false,
		result: {
			content,
			details: {
				action,
				todos: state.todos.map((todo) => ({ ...todo })),
				nextId: state.nextId,
				error,
			},
			isError: true,
		},
	};
}

/** Apply one action to a state. Pure: never mutates `state` and never throws. */
export function applyTodoOperation(state: TodoState, input: TodoOperationInput): TodoOperationOutcome {
	const current = cloneState(state);

	switch (input.action) {
		case "list":
			return success(current, "list", describeTodos(current.todos));

		case "add": {
			const text = input.text?.trim();
			if (!text) {
				return failure(current, "add", "Error: text required for add", "text required");
			}
			const todo: Todo = { id: String(current.nextId), text, done: false };
			current.todos.push(todo);
			current.nextId += 1;
			return success(current, "add", `Added todo #${todo.id}: ${todo.text}`);
		}

		case "toggle": {
			const idError = requireId(input.id);
			if (idError) return failure(current, "toggle", `Error: ${idError}`, idError);
			const todo = current.todos.find((item) => item.id === input.id);
			if (!todo) {
				return failure(current, "toggle", `Todo #${input.id} not found`, `#${input.id} not found`);
			}
			todo.done = !todo.done;
			return success(current, "toggle", `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`);
		}

		case "remove": {
			const idError = requireId(input.id);
			if (idError) return failure(current, "remove", `Error: ${idError}`, idError);
			const index = current.todos.findIndex((item) => item.id === input.id);
			if (index === -1) {
				return failure(current, "remove", `Todo #${input.id} not found`, `#${input.id} not found`);
			}
			const [removed] = current.todos.splice(index, 1);
			return success(current, "remove", `Removed todo #${removed.id}: ${removed.text}`);
		}

		case "clear": {
			const count = current.todos.length;
			current.todos = [];
			current.nextId = 1;
			return success(current, "clear", `Cleared ${count} todos`);
		}

		default:
			return failure(
				current,
				"list",
				`Unknown action: ${String(input.action)}`,
				`unknown action: ${String(input.action)}`,
			);
	}
}

/** Missing or empty id gives a message; a present id gives null. */
function requireId(id: string | undefined): string | null {
	if (id === undefined || id.trim() === "") return "id required";
	return null;
}

/** Type guard for a stored `details` payload. */
function isTodoDetails(value: unknown): value is TodoDetails {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { todos?: unknown; nextId?: unknown };
	return Array.isArray(candidate.todos) && typeof candidate.nextId === "number" && Number.isFinite(candidate.nextId);
}

/** Copy stored todos and drop malformed items. */
function cloneStoredTodos(todos: readonly unknown[]): Todo[] {
	const result: Todo[] = [];
	for (const item of todos) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as { id?: unknown; text?: unknown; done?: unknown };
		if (candidate.id === undefined || candidate.text === undefined) continue;
		result.push({ id: String(candidate.id), text: String(candidate.text), done: candidate.done === true });
	}
	return result;
}

/**
 * Rebuild state from a session branch. Scans for this tool's result `details`
 * in order; the last valid payload wins. Pure, so a synthetic entry list works.
 */
export function reconstructTodosFromEntries(entries: readonly TodoSessionEntry[]): TodoState {
	let state = emptyTodoState();
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "toolResult" || message.toolName !== "todo") continue;
		if (!isTodoDetails(message.details)) continue;
		state = { todos: cloneStoredTodos(message.details.todos), nextId: message.details.nextId };
	}
	return state;
}

/** Emit the snapshot. A missing subscriber must never break a tool call. */
function emitTodos(pi: ExtensionAPI, state: TodoState): void {
	try {
		pi.events.emit(TODOS_EVENT_CHANNEL, {
			todos: state.todos.map((todo) => ({ ...todo })),
			nextId: state.nextId,
			at: new Date().toISOString(),
		});
	} catch {
		/* best-effort publish; the panel reconstructs from session entries instead */
	}
}

/** Register the `todo` tool and its session-entry reconstruction hooks. */
export function registerTodoTool(pi: ExtensionAPI): void {
	let state = emptyTodoState();

	const reconstruct = (ctx: ExtensionContext): void => {
		try {
			state = reconstructTodosFromEntries(ctx.sessionManager.getBranch());
		} catch {
			/* keep the in-memory cache when a branch is unavailable */
		}
	};

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list for the current task. Actions: list, add (text), toggle (id), remove (id), clear.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const outcome = applyTodoOperation(state, params);
			state = outcome.state;
			if (outcome.mutated) emitTodos(pi, state);
			return {
				content: [{ type: "text" as const, text: outcome.result.content }],
				details: outcome.result.details,
				isError: outcome.result.isError,
			};
		},
	});
}
