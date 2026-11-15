/**
 * Shared fixture for the suites that drive the extension factory: a fake pi
 * host, a run of its `before_agent_start` handlers, and its recorded commands.
 *
 * The fake records `on` handlers per event name, in call order, and
 * `registerCommand` commands by name. `on` returns a disposer. Every other
 * member is a no-op or an empty value, so the factory runs. A dropped member
 * throws when the factory runs.
 *
 * No side effect: the module calls no factory and sets no state. A case keeps
 * its own order of the agent and persona setters and the factory call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Handler = (event: unknown, ctx: unknown) => unknown;

export interface CommandOptions {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, CommandOptions>;
}

/** A fake pi that records `on` handlers and commands; every other member is a stub or an empty value. */
export function makePi(settings: unknown = {}): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions>();
	const noop = (): void => {};
	const pi: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, options: CommandOptions) => {
			commands.set(name, options);
		},
		registerTool: noop,
		registerFlag: noop,
		getFlag: () => undefined,
		getSettings: () => settings,
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	// SAFETY: the fake is a partial ExtensionAPI. The factory also calls
	// `registerShortcut`, which the fake lacks, and `registerKeyPair` catches that throw.
	return { pi: pi as unknown as ExtensionAPI, handlers, commands };
}

/** Run every `before_agent_start` handler and return the final prompt. */
export async function promptFor(harness: Harness, cwd: string): Promise<string> {
	let prompt = "BASE";
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		const result = (await handler({ systemPrompt: prompt }, { cwd })) as
			| { systemPrompt?: string }
			| undefined;
		if (result?.systemPrompt) prompt = result.systemPrompt;
	}
	return prompt;
}
