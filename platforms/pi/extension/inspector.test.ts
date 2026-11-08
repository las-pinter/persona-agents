/**
 * Contract test for the inspector overlay.
 *
 * The TUI requires `invalidate()` on every mounted overlay and calls it with
 * no guard. The inspector must carry that member and render again after it.
 *
 * The overlay also shows the archived thinking fields, the body, and the
 * stderr line without printing any text twice.
 *
 * Run: npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { toInspectTask } from "./subagent.ts";
import { failureResult } from "./subagent-result.ts";
import { archiveRun, getRuns, registerInspectorCommands } from "./inspector.ts";
import { countOccurrences, makeSingle, zeroUsage } from "./subagent-render-fixtures.ts";

interface CapturedCommand {
	handler: (args: string, ctx: unknown) => unknown;
}

function captureCommands(): Map<string, CapturedCommand> {
	const commands = new Map<string, CapturedCommand>();
	const pi = {
		registerCommand: (name: string, def: CapturedCommand) => {
			commands.set(name, def);
		},
	};
	registerInspectorCommands(pi as unknown as ExtensionAPI);
	return commands;
}

/** Open one archived run in the inspector and flatten its lines. */
async function inspectDetail(arg: string): Promise<string> {
	const commands = captureCommands();
	let component: { render(width: number): string[] } | undefined;
	await commands.get("inspect")?.handler(arg, {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) => {
				component = factory({}, {}, {}, () => {}) as { render(width: number): string[] };
			},
		},
	});
	return component?.render(200).join("\n") ?? "";
}

test("the inspector overlay carries invalidate and re-renders after it", async () => {
	archiveRun({
		at: "2024-01-09T00:00:00.000Z",
		mode: "single",
		agentScope: "user",
		results: [{ agent: "implementer", status: "done", task: "build it", exitCode: 0, messages: [], stderr: "" }],
	});

	const commands = captureCommands();
	let mounted: Component | undefined;
	await commands.get("inspect")?.handler("last", {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) => {
				mounted = factory({}, {}, {}, () => {}) as Component;
			},
		},
	});

	assert.ok(mounted, "the inspect command mounts a component");
	mounted.invalidate();
	const lines = mounted.render(80);
	assert.match(lines[0], /SUBAGENT INSPECTOR — single/, lines[0]);
});

// --- archive carries the thinking fields ------------------------------------

test("archiveRun stores the thinking fields and /runs shows them", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 },
			reasoningTokens: 500,
		}),
	);
	archiveRun({ at: "2024-01-01T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });
	const last = getRuns().at(-1);
	assert.equal(last?.results[0].thinkingMs, 1_200);
	assert.equal(last?.results[0].reasoningTokens, 500);

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	assert.ok(notified.includes("🧠 1.2s"), notified);
	assert.ok(notified.includes("500 reasoning"), notified);
});

test("the inspector detail shows the thinking summary", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 3_400 },
			reasoningTokens: 25,
		}),
	);
	archiveRun({ at: "2024-01-02T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let component: { render(width: number): string[] } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) => {
				component = factory({}, {}, {}, () => {}) as { render(width: number): string[] };
			},
		},
	};
	await commands.get("inspect")?.handler("last", ctx);
	const lines = component?.render(200).join("\n") ?? "";
	assert.ok(lines.includes("🧠 3.4s"), lines);
	assert.ok(lines.includes("25 reasoning"), lines);
});

test("the inspector prints a refusal once, not as body and stderr", async () => {
	const refusal = failureResult("tester", "user", "do the thing", undefined, "Blocked: the tool refused");
	archiveRun({ at: "2024-01-11T00:00:00.000Z", mode: "single", agentScope: "user", results: [toInspectTask(refusal)] });

	const detail = await inspectDetail("last");
	assert.equal(countOccurrences(detail, "Blocked: the tool refused"), 1, "the refusal text shows once");
	assert.ok(!detail.includes("stderr:"), detail);
});

test("the inspector keeps the stderr line when it differs from the body", async () => {
	const refusal = failureResult("tester", "user", "do the thing", undefined, "the tool said no");
	refusal.errorMessage = "boom";
	archiveRun({ at: "2024-01-12T00:00:00.000Z", mode: "single", agentScope: "user", results: [toInspectTask(refusal)] });

	const detail = await inspectDetail("last");
	assert.ok(detail.includes("stderr: the tool said no"), detail);
});

test("the inspector prints an aborted run's abort text once and no partial text", async () => {
	const abortedTask = toInspectTask(
		makeSingle({
			exitCode: 1,
			stopReason: "aborted",
			errorMessage: "Subagent was aborted",
			messages: [{ role: "assistant", content: [{ type: "text", text: "half a turn of output" }] }],
			usage: { ...zeroUsage(), input: 10, output: 5, turns: 8 },
		}),
	);
	archiveRun({ at: "2024-01-10T00:00:00.000Z", mode: "single", agentScope: "user", results: [abortedTask] });

	const lines = await inspectDetail("last");
	assert.equal(countOccurrences(lines, "Subagent was aborted"), 1, "the inspector prints the abort text once");
	// A failed run's body is its error text, so no partial output text can appear.
	assert.ok(!lines.includes("half a turn of output"), lines);
	assert.ok(!lines.includes("capped"), lines);
	assert.ok(!lines.includes("partial output follows"), lines);
	// The body holds the body slot, so it prints before the usage summary.
	const bodyAt = lines.indexOf("Subagent was aborted");
	const usageAt = lines.indexOf("↑10");
	assert.ok(bodyAt >= 0, lines);
	assert.ok(usageAt > bodyAt, `the body prints before the usage line:\n${lines}`);
});

test("the inspector formats reasoning tokens like the inline block", async () => {
	const task = toInspectTask(
		makeSingle({
			thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 },
			reasoningTokens: 1_500,
		}),
	);
	archiveRun({ at: "2024-01-03T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	assert.ok(notified.includes("1.5k reasoning"), notified);
});

test("the inspector omits reasoning when the count is zero", async () => {
	const task = toInspectTask(
		makeSingle({ thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 1_200 } }),
	);
	archiveRun({ at: "2024-01-05T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	const line = notified.split("\n").find((candidate) => candidate.includes("2024-01-05")) ?? "";
	assert.ok(line.includes("🧠 1.2s"), notified);
	assert.ok(!line.includes("reasoning"), line);
});

test("an old archive record without thinking fields renders without them", async () => {
	// A record written before the thinking fields existed must not crash.
	const oldTask = {
		agent: "tester",
		status: "done" as const,
		task: "old run",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
	};
	archiveRun({ at: "2024-01-06T00:00:00.000Z", mode: "single", agentScope: "user", results: [oldTask] });

	const commands = captureCommands();
	let notified = "";
	await commands.get("runs")?.handler("", {
		ui: {
			notify: (msg: string) => {
				notified = msg;
			},
		},
		mode: "text",
	});
	const line = notified.split("\n").find((candidate) => candidate.includes("2024-01-06")) ?? "";
	assert.ok(line.includes("tester"), notified);
	assert.ok(!line.includes("🧠"), line);
});

test("a narrow inspector leads the nav line with the whole page counter", async () => {
	const task = toInspectTask(makeSingle({ task: "do the thing" }));
	archiveRun({ at: "2024-01-13T00:00:00.000Z", mode: "single", agentScope: "user", results: [task] });

	const commands = captureCommands();
	let component: { render(width: number): string[] } | undefined;
	await commands.get("inspect")?.handler("last", {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => unknown,
			) => {
				component = factory({}, {}, {}, () => {}) as { render(width: number): string[] };
			},
		},
	});

	const lines = component?.render(24) ?? [];
	const nav = (lines.at(-1) ?? "").trimEnd();
	assert.match(nav, /^\(line 1\/\d+\)/, `the counter leads at width 24: ${JSON.stringify(nav)}`);
	assert.ok(!nav.includes("q/Esc close"), "the narrow frame cut a key hint, not the counter");
});
