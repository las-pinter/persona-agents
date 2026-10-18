/**
 * Footer dim-token tests for the agent and persona status text.
 *
 * Proves the status helper wraps text in the `dim` token in TUI mode, falls
 * back to plain text otherwise, and is used by the extension and commands.
 *
 * Run: npm test
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";
import { registerCommands } from "./commands.ts";
import { dimText } from "./status-text.ts";
import type { AgentConfig, PersonaConfig } from "./resolver.ts";
import { setActiveAgent, setActivePersona } from "./state.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface CommandOptions {
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, CommandOptions>;
}

/** A fake pi that records handlers and commands; every other method is a no-op. */
function makePi(): Harness {
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
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands };
}

/** A fake theme that marks the token it received. */
function markingTheme(): { fg: (token: string, text: string) => string } {
	return { fg: (token, text) => `<${token}>${text}</${token}>` };
}

/** A theme that emits a real ANSI dim escape, to prove it is not used. */
function ansiTheme(): { fg: (token: string, text: string) => string } {
	return { fg: (_token, text) => `\u001b[2m${text}\u001b[0m` };
}

interface StatusCall {
	key: string;
	text: string | undefined;
}

/** A `setStatus` recorder that appends every call. */
function recorder(calls: StatusCall[]): (key: string, text: string | undefined) => void {
	return (key, text) => calls.push({ key, text });
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "status-test-agent",
		description: "status test agent",
		systemPrompt: "STATUS TEST BODY",
		source: "package",
		filePath: "",
		...overrides,
	};
}

function makePersona(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
	return {
		name: "status-test-persona",
		theme: "status-test-theme",
		body: "STATUS TEST PERSONA BODY",
		filePath: "",
		fileNameStem: "status-test-persona",
		...overrides,
	};
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "status-dim-"));

after(() => {
	setActiveAgent(null);
	setActivePersona(null);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("dimText wraps text in the dim token in tui mode", () => {
	const text = dimText(
		{ theme: { fg: (token, value) => `<${token}>${value}</${token}>` } },
		"agent: x",
		"tui",
	);
	assert.equal(text, "<dim>agent: x</dim>");
});

test("dimText returns undefined for undefined text even with a theme present", () => {
	assert.equal(dimText({ theme: markingTheme() }, undefined, "tui"), undefined);
});

test("dimText returns plain text outside tui mode", () => {
	assert.equal(dimText({ theme: markingTheme() }, "agent: x", "rpc"), "agent: x");
	assert.equal(dimText({ theme: markingTheme() }, "agent: x", "json"), "agent: x");
	assert.equal(dimText({ theme: markingTheme() }, "agent: x"), "agent: x");
});

test("dimText falls back to plain text when the mode is tui but no theme is present", () => {
	assert.equal(dimText(undefined, "agent: x", "tui"), "agent: x");
	assert.equal(dimText({}, "agent: x", "tui"), "agent: x");
});

test("extension: agent and persona footer text carry the dim token", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActiveAgent(makeAgent());
	setActivePersona(makePersona());

	const calls: StatusCall[] = [];
	const ctx = {
		cwd: tmpRoot,
		mode: "tui",
		ui: { setStatus: recorder(calls), theme: markingTheme() },
	};
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		await handler({ systemPrompt: "BASE" }, ctx);
	}

	assert.deepEqual(calls, [
		{ key: "agent", text: "<dim>agent: status-test-agent</dim>" },
		{ key: "persona", text: "<dim>persona: status-test-theme/status-test-persona</dim>" },
	]);
});

test("extension: agent and persona footer text is plain without a theme", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActiveAgent(makeAgent());
	setActivePersona(makePersona());

	const calls: StatusCall[] = [];
	const ctx = { cwd: tmpRoot, mode: "tui", ui: { setStatus: recorder(calls) } };
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		await handler({ systemPrompt: "BASE" }, ctx);
	}

	assert.deepEqual(calls, [
		{ key: "agent", text: "agent: status-test-agent" },
		{ key: "persona", text: "persona: status-test-theme/status-test-persona" },
	]);
});

test("extension: footer text stays plain with no escape codes in rpc and json modes", async () => {
	for (const mode of ["rpc", "json"]) {
		const harness = makePi();
		extension(harness.pi);
		setActiveAgent(makeAgent());
		setActivePersona(makePersona());

		const calls: StatusCall[] = [];
		const ctx = {
			cwd: tmpRoot,
			mode,
			ui: { setStatus: recorder(calls), theme: ansiTheme() },
		};
		for (const handler of harness.handlers.get("before_agent_start") ?? []) {
			await handler({ systemPrompt: "BASE" }, ctx);
		}

		assert.deepEqual(calls, [
			{ key: "agent", text: "agent: status-test-agent" },
			{ key: "persona", text: "persona: status-test-theme/status-test-persona" },
		]);
		assert.ok(calls.every((call) => !String(call.text).includes("\u001b")), `${mode} has no escape codes`);
	}
});

test("extension: a cleared agent status stays cleared on the next agent run", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActiveAgent(makeAgent());
	setActivePersona(makePersona());

	const calls: StatusCall[] = [];
	const ctx = {
		cwd: tmpRoot,
		mode: "tui",
		ui: { setStatus: recorder(calls), theme: markingTheme(), notify: () => {} },
	};
	await harness.commands.get("agents")!.handler("off", ctx);

	calls.length = 0;
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		await handler({ systemPrompt: "BASE" }, ctx);
	}

	assert.deepEqual(calls, [
		{ key: "agent", text: undefined },
		{ key: "persona", text: "<dim>persona: status-test-theme/status-test-persona</dim>" },
	]);
});

test("commands: /agents writes dim-wrapped status text", async () => {
	const harness = makePi();
	registerCommands(harness.pi);

	// Hermetic fixtures: one agent and one persona under <cwd>/.pi.
	const project = path.join(tmpRoot, "project");
	const agentsDir = path.join(project, CONFIG_DIR_NAME, "agents");
	const personasDir = path.join(project, CONFIG_DIR_NAME, "personas", "status-test-theme");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.mkdirSync(personasDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "status-test-agent.md"),
		"---\nname: status-test-agent\ndescription: status test agent\n---\n\nAGENT BODY\n",
	);
	fs.writeFileSync(
		path.join(personasDir, "status-test-persona.md"),
		"---\nname: status-test-persona\n---\n\nPERSONA BODY\n",
	);

	const calls: StatusCall[] = [];
	const ctx = {
		cwd: project,
		mode: "tui",
		ui: { setStatus: recorder(calls), theme: markingTheme(), notify: () => {} },
	};
	await harness.commands
		.get("agents")!
		.handler("status-test-agent -persona status-test-theme/status-test-persona", ctx);

	assert.deepEqual(calls, [
		{ key: "agent", text: "<dim>agent: status-test-agent</dim>" },
		{ key: "persona", text: "<dim>persona: status-test-theme/status-test-persona</dim>" },
	]);
});

test("commands: /agents off clears the agent status", async () => {
	const harness = makePi();
	registerCommands(harness.pi);
	setActiveAgent(makeAgent());

	const calls: StatusCall[] = [];
	const ctx = {
		cwd: tmpRoot,
		mode: "tui",
		ui: { setStatus: recorder(calls), theme: markingTheme(), notify: () => {} },
	};
	await harness.commands.get("agents")!.handler("off", ctx);

	assert.deepEqual(calls, [{ key: "agent", text: undefined }]);
});

test("commands: /persona activates then clears the persona status", async () => {
	const harness = makePi();
	registerCommands(harness.pi);

	const project = path.join(tmpRoot, "persona-project");
	const personasDir = path.join(project, CONFIG_DIR_NAME, "personas", "status-test-theme");
	fs.mkdirSync(personasDir, { recursive: true });
	fs.writeFileSync(
		path.join(personasDir, "status-test-persona.md"),
		"---\nname: status-test-persona\n---\n\nPERSONA BODY\n",
	);

	const calls: StatusCall[] = [];
	const ctx = {
		cwd: project,
		mode: "tui",
		ui: { setStatus: recorder(calls), theme: markingTheme(), notify: () => {} },
	};
	await harness.commands.get("persona")!.handler("status-test-theme/status-test-persona", ctx);
	assert.deepEqual(calls, [
		{ key: "persona", text: "<dim>persona: status-test-theme/status-test-persona</dim>" },
	]);

	calls.length = 0;
	await harness.commands.get("persona")!.handler("off", ctx);
	assert.deepEqual(calls, [{ key: "persona", text: undefined }]);
});
