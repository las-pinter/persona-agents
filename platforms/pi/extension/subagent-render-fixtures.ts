/**
 * Shared fixtures for the subagent render tests.
 *
 * Registers the extension against a fake pi, drives `renderResult`, and builds
 * the run fixtures the render path reads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentExtension, { type SingleResult } from "./subagent.ts";

interface Renderable {
	render(width: number): string[];
}

interface FakeTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface CapturedTool {
	renderResult: (
		result: unknown,
		options: { expanded: boolean },
		theme: FakeTheme,
		context: unknown,
	) => Renderable;
}

const THEME: FakeTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Register the extension against a fake pi and return the captured tool. */
export function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool: (tool: CapturedTool) => {
			captured = tool;
		},
	};
	// SAFETY: the extension calls only `registerTool` on the fake pi at registration, and this fake provides it.
	subagentExtension(pi as unknown as ExtensionAPI);
	if (!captured) throw new Error("subagent extension did not register a tool");
	return captured;
}

/** Drive `renderResult` and flatten the component to plain text lines. */
export function render(tool: CapturedTool, result: unknown, expanded: boolean, context: unknown = {}): string {
	return tool
		.renderResult(result, { expanded }, THEME, context)
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

export function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

export function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** The fields a fixture can override. `messages` stays loose, because a test
 * builds only the parts the render path reads, not a full provider message. */
type FixtureOverrides = Partial<Omit<SingleResult, "messages">> & { messages?: unknown[] };

/**
 * One run fixture, typed once. Every call site takes it directly, so no test
 * casts a fixture to reach a renderer or the shared text rule.
 */
export function makeSingle(overrides: FixtureOverrides = {}): SingleResult {
	return {
		agent: "tester",
		agentSource: "user" as const,
		task: "do the thing",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		session: null,
		resumed: false,
		round: 1,
		...overrides,
	} as SingleResult;
}

export function makeDetails(mode: "single" | "chain" | "parallel", results: unknown[]) {
	return { mode, agentScope: "user", projectAgentsDir: null, results };
}

export function makeResult(details: unknown, text = "done") {
	return { content: [{ type: "text", text }], details };
}

export function toolCallMessage(id: string, name: string, args: Record<string, unknown>) {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}

export function toolResultMessage(toolCallId: string, durationMs?: number) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [],
		isError: false,
		timestamp: 0,
		...(durationMs === undefined ? {} : { durationMs }),
	};
}
