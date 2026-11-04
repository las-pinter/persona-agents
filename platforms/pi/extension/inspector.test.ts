/**
 * Contract test for the inspector overlay.
 *
 * The TUI requires `invalidate()` on every mounted overlay and calls it with
 * no guard. The inspector must carry that member and render again after it.
 *
 * Run: npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { archiveRun, registerInspectorCommands } from "./inspector.ts";

interface CapturedCommand {
	handler: (args: string, ctx: unknown) => Promise<void>;
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
