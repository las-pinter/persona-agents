/**
 * Child tool wrapper: the only gate a child tool call meets.
 *
 * A child session loads no extension, so no `tool_call` handler runs inside it.
 * Each loadout name is registered as a custom tool that asks the parent gate
 * with the child context, then runs the tool it wraps. The gate is the parent's
 * own handler, so the verdict order and the session allow memory are the ones
 * the root uses.
 *
 * An ask in a child is a denial at once (`permissions.ts` owns the reason). A
 * child has no UI, so no prompt can mount for it. The gate reads the child
 * session id from the passed context. A wrapper with no bound gate blocks, so
 * it never runs ungated.
 *
 * The wrapper list must equal the child loadout. A name outside the list has no
 * wrapper, so nothing would gate it. `assertWrapperListEquals` fails that build.
 *
 * A wildcard never reaches the build: the caller refuses the loadout. A
 * wildcard would switch on tools that carry no wrapper, so the gate never runs.
 *
 * The extension keeps every definition it registers, so a loadout name it owns
 * (for example `todo`) hands the wrapper a real tool. A gateable name that
 * neither the builtins nor the kept set supplies refuses the build.
 *
 * No pi runtime import beyond types: a test supplies the gate and the tools.
 */

import {
	type ExtensionAPI,
	type ExtensionToolContext,
	type SettingsManager,
	type ToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** One child tool definition. The wrapper keeps the inner parameters. */
export type ChildToolDefinition = ToolDefinition<any, any>;

/** The block reason when a child call finds no bound parent gate. */
export const NO_PARENT_GATE_REASON = "Blocked: no parent gate is bound for this child tool";

/** The refusal when a loadout names a tool this process cannot supply. */
export function missingChildToolReason(entries: readonly string[]): string {
	const named = entries.map((entry) => `"${entry}"`).join(", ");
	return `Refused: the tools loadout names a tool with no child implementation (${named})`;
}

/** The refusal a child gets when it tries to ask the user directly. */
export const CHILD_ASK_REFUSAL_REASON =
	"Blocked: a child cannot ask the user; return the questions for the caller to put";

/**
 * The child `ask_user_question` tool. A child session has no UI, and the
 * orchestrator is the only mouth, so the tool refuses and names the next step.
 */
export const CHILD_ASK_TOOL: ChildToolDefinition = {
	name: "ask_user_question",
	label: "Ask user",
	description: "Put questions to the user. A child returns them to its caller instead.",
	parameters: Type.Object({}),
	execute: async () => blockedResult(CHILD_ASK_REFUSAL_REASON),
};

/** Definitions the extension registered, kept for a child build. */
const keptTools = new Map<string, ChildToolDefinition>();

/** Keep one definition the extension registers, so a child loadout can name it. */
export function registerChildTool(definition: ChildToolDefinition): void {
	keptTools.set(definition.name, definition);
}

/** The kept definition for one name, or null. */
export function childToolImplementation(name: string): ChildToolDefinition | null {
	return keptTools.get(name) ?? null;
}

/** Drop the kept definitions, so one test cannot leak into the next. */
export function clearChildToolImplementations(): void {
	keptTools.clear();
}

/** The names a builtin definition covers. The set reads no settings. */
export const BUILTIN_CHILD_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/** True when this process can build an implementation for `name`. */
export function hasChildImplementation(name: string): boolean {
	return keptTools.has(name) || BUILTIN_CHILD_TOOL_NAMES.includes(name);
}

/** The gateable loadout names with no implementation in this process. */
export function missingChildTools(names: readonly string[]): string[] {
	return gateableChildTools(names).filter((name) => !hasChildImplementation(name));
}

/** The kept definitions a loadout names, in loadout order. */
export function childToolsFor(names: readonly string[]): ChildToolDefinition[] {
	const tools: ChildToolDefinition[] = [];
	for (const name of gateableChildTools(names)) {
		const definition = childToolImplementation(name);
		if (definition) tools.push(definition);
	}
	return tools;
}

/**
 * Wrap `pi` so every definition it registers is kept for a child build and
 * still reaches the runtime. A method keeps its own object as `this`.
 */
export function captureRegisteredTools(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ChildToolDefinition): void => {
					registerChildTool(definition);
					target.registerTool(definition);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * True for a name the gate leaves alone, as it does on the root path: an MCP
 * server or an extension namespace. Such a name is not a tool, so it gets no
 * wrapper and stays out of the equality check.
 */
export function isUngatedChildTool(name: string): boolean {
	return name.startsWith("mcp__") || name.includes(".");
}

/** The loadout names that need a wrapper: everything the gate would judge. */
export function gateableChildTools(names: readonly string[]): string[] {
	return names.filter((name) => !isUngatedChildTool(name));
}

/**
 * Loadout entries that carry a wildcard, so one name would switch on several
 * tools. An MCP wildcard stays ungated, as it does on the root path.
 */
export function wildcardChildTools(names: readonly string[]): string[] {
	return names.filter((name) => !name.startsWith("mcp__") && /[*?]/.test(name));
}

/** The failure result text for a loadout that names a wildcard. */
export function wildcardLoadoutReason(entries: readonly string[]): string {
	const named = entries.map((entry) => `"${entry}"`).join(", ");
	return `Refused: the tools loadout names a wildcard (${named}), which would run tools with no gate wrapper`;
}

/** The event one wrapper hands the parent gate. */
export interface ChildToolCallEvent {
	toolName: string;
	input?: Record<string, unknown>;
}

/** What the parent gate answers: a block with a reason, or no verdict. */
export type ChildToolVerdict = { block?: boolean; reason?: string } | undefined;

/** The parent gate handler the wrapper reuses. */
export type ParentGateHandler = (event: ChildToolCallEvent, ctx: ExtensionToolContext) => Promise<ChildToolVerdict>;

let parentGate: ParentGateHandler | null = null;

/** Bind the installed gate handler. A null handler makes every wrapper block. */
export function bindParentGate(handler: ParentGateHandler | null): void {
	parentGate = handler;
}

/** The bound gate handler, or null when no gate was installed in this process. */
export function parentGateHandler(): ParentGateHandler | null {
	return parentGate;
}

/** What one wrapper list is built from. */
export interface WrapChildToolsInput {
	/** The child loadout: the tool names the child may call. */
	names: readonly string[];
	/** In-process tools the loadout names, for example `todo`. */
	customTools?: readonly ChildToolDefinition[];
	/** Resolves a builtin tool definition for a name, or null. */
	resolveBuiltin?: (name: string) => ChildToolDefinition | null;
	/** Defaults to `parentGateHandler`, read on every call. */
	gate?: () => ParentGateHandler | null;
}

/** A blocked tool result. The reason travels as text, so the model reads it. */
function blockedResult(reason: string): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
	isError: boolean;
} {
	return { content: [{ type: "text", text: reason }], details: undefined, isError: true };
}

/**
 * Build one wrapper per loadout name. The gate answers first, so the wrapped
 * tool runs only when the gate returns no block. A name with no implementation
 * refuses the build, so nothing runs ungated.
 */
export function wrapChildTools(input: WrapChildToolsInput): ChildToolDefinition[] {
	const custom = input.customTools ?? [];
	return gateableChildTools(input.names).map((name) => {
		const inner =
			custom.find((tool) => tool.name === name) ??
			childToolImplementation(name) ??
			input.resolveBuiltin?.(name) ??
			null;
		if (!inner) throw new Error(missingChildToolReason([name]));
		const execute: ChildToolDefinition["execute"] = async (toolCallId, params, signal, onUpdate, ctx) => {
			// No verdict is an allow, so a missing gate is a separate check.
			const gate = (input.gate ?? parentGateHandler)();
			if (!gate) return blockedResult(NO_PARENT_GATE_REASON);
			const event: ChildToolCallEvent = { toolName: name, input: (params ?? {}) as Record<string, unknown> };
			const verdict = await gate(event, ctx);
			if (verdict && verdict.block !== false) return blockedResult(verdict.reason ?? NO_PARENT_GATE_REASON);
			return inner.execute(toolCallId, params, signal, onUpdate, ctx);
		};
		return { ...inner, name, execute };
	});
}

/**
 * Throw when the wrapper list and the loadout disagree. An unnamed tool would
 * run with no verdict, so the mismatch fails the build instead.
 */
export function assertWrapperListEquals(names: readonly string[], wrappers: readonly { name: string }[]): void {
	const expected = gateableChildTools(names).sort();
	const actual = wrappers.map((tool) => tool.name).sort();
	const same = expected.length === actual.length && expected.every((name, index) => name === actual[index]);
	if (!same) {
		throw new Error(
			`child tools: the wrapper list must equal the loadout (loadout ${expected.join(",")}; wrappers ${actual.join(",")})`,
		);
	}
}

/**
 * The builtin definition for one loadout name, built with the child cwd and the
 * session settings, so a wrapped call keeps the shell prefix and the image
 * resize the session itself would use.
 */
export function builtinChildTool(name: string, cwd: string, settings: SettingsManager): ChildToolDefinition | null {
	if (!BUILTIN_CHILD_TOOL_NAMES.includes(name)) return null;
	switch (name) {
		case "read":
			return createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() });
		case "bash":
			return createBashToolDefinition(cwd, {
				commandPrefix: settings.getShellCommandPrefix(),
				shellPath: settings.getShellPath(),
			});
		case "powershell":
			return createPowerShellToolDefinition(cwd);
		case "edit":
			return createEditToolDefinition(cwd);
		case "write":
			return createWriteToolDefinition(cwd);
		case "grep":
			return createGrepToolDefinition(cwd);
		case "find":
			return createFindToolDefinition(cwd);
		case "ls":
			return createLsToolDefinition(cwd);
		default:
			return null;
	}
}
