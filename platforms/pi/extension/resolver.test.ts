/**
 * Resolver permission-class cases.
 *
 * Runs under plain Node (type stripping):
 *   node --experimental-strip-types --test platforms/pi/extension/resolver.test.ts
 *
 * Covers the class each package role names, the loud failure on a missing or
 * unknown class, the clamp of a user or project claim above `reader`, and the
 * gate install that survives a malformed agent file.
 */

import { after, test, type TestContext } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";
import { ENV_RUN_ID, ENV_TREE_LOG } from "./depth.ts";
import { readAllEvents } from "./tree-log.ts";
import { loadAgentsFromDir, loadTemplateAgents, type AgentConfig, type PersonaConfig } from "./resolver.ts";
import { loadPersonasFromDir } from "./persona-loader.ts";
import type { PermissionClass } from "./permission-class.ts";

const ROLE_CLASS: Record<string, PermissionClass> = {
	orchestrator: "orchestrator",
	implementer: "worker",
	tester: "worker",
	planner: "reader",
	researcher: "reader",
	reviewer: "reader",
	mascot: "reader",
};

// --- the seven package roles -------------------------------------------------

test("every package role resolves to its permission class", () => {
	const agents = loadTemplateAgents();
	const byName = new Map(agents.map((agent) => [agent.name, agent]));

	for (const [role, expected] of Object.entries(ROLE_CLASS)) {
		const agent = byName.get(role);
		assert.ok(agent, `no package agent resolved for ${role}`);
		assert.equal(agent.permissionClass, expected, `${role} resolved the wrong class`);
	}

	assert.equal(agents.length, Object.keys(ROLE_CLASS).length, "a package agent has no expected role");
});

test("every package agent carries a permission class", () => {
	for (const agent of loadTemplateAgents()) {
		assert.ok(agent.permissionClass, `${agent.filePath} resolved no permission class`);
	}
});

// --- loud failure ------------------------------------------------------------

/** A temp package root with one frontmatter and its profession body. */
function fixtureRoot(t: TestContext, yaml: string): { root: string; template: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-class-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "platforms", "pi", "frontmatters"), { recursive: true });
	fs.mkdirSync(path.join(root, "content", "professions"), { recursive: true });
	fs.writeFileSync(path.join(root, "content", "professions", "goblin.md"), "# Goblin\n");
	const template = path.join(root, "platforms", "pi", "frontmatters", "goblin.yaml");
	fs.writeFileSync(template, yaml);
	return { root, template };
}

/** The message a call throws, or a failure when the call returns. */
function thrownMessage(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof Error, "a non-Error value was thrown");
		return error.message;
	}
	return assert.fail("the loader did not throw");
}

test("a missing permission class fails with the file name and the value", (t) => {
	const { root, template } = fixtureRoot(t, "name: goblin\ndescription: test agent\n");

	const message = thrownMessage(() => loadTemplateAgents(root));
	assert.ok(message.includes(template), `error does not name ${template}: ${message}`);
	assert.match(message, /permissionClass missing/);
});

test("an unknown permission class fails with the file name and the value", (t) => {
	const { root, template } = fixtureRoot(t, "name: goblin\ndescription: test agent\npermissionClass: admin\n");

	const message = thrownMessage(() => loadTemplateAgents(root));
	assert.ok(message.includes(template), `error does not name ${template}: ${message}`);
	assert.match(message, /permissionClass "admin"/);
});

// --- user and project agent files --------------------------------------------

/** A log path no other case reads, so one case never sees another's lines. */
let caseCounter = 0;
function caseLogPath(): string {
	caseCounter += 1;
	return path.join(os.tmpdir(), `resolver-log-${process.pid}-${caseCounter}-${Date.now()}.ndjson`);
}

/** Every `log` line in one log file. */
function logLines(logPath: string): string[] {
	return readAllEvents(logPath)
		.filter((event) => event.type === "log" && typeof event.text === "string")
		.map((event) => event.text ?? "")
		.filter((text) => text.length > 0);
}

/** Collect the log lines a call writes, then return them. */
function captureWarnings(run: () => void): string[] {
	const previous = process.env[ENV_TREE_LOG];
	const logPath = caseLogPath();
	process.env[ENV_TREE_LOG] = logPath;
	try {
		run();
		return logLines(logPath);
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		fs.rmSync(logPath, { force: true });
	}
}

/** A temp `.pi/agents` directory holding one agent file. */
function userAgentDir(t: TestContext, frontmatter: string): { dir: string; file: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-user-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const dir = path.join(root, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "goblin.md");
	fs.writeFileSync(file, `---\n${frontmatter}\n---\n\nGOBLIN BODY\n`);
	return { dir, file };
}

test("a user agent file with no permission class loads as reader with one warning", (t) => {
	const { dir, file } = userAgentDir(t, "name: goblin\ndescription: test agent");

	let agents: AgentConfig[] = [];
	const warnings = captureWarnings(() => {
		agents = loadAgentsFromDir(dir, "user");
		// A second discovery run must not repeat the warning for the same file.
		loadAgentsFromDir(dir, "user");
	});

	assert.equal(agents.length, 1, "the user file was not loaded");
	assert.equal(agents[0].permissionClass, "reader", "a missing class must load as reader");
	assert.equal(warnings.length, 1, `expected one warning, got: ${warnings.join(" | ")}`);
	assert.ok(warnings[0].includes(file), `warning does not name ${file}: ${warnings[0]}`);
	assert.match(warnings[0], /reader/);
});

test("a user agent file with an unknown permission class throws", (t) => {
	const { dir, file } = userAgentDir(t, "name: goblin\ndescription: test agent\npermissionClass: admin");

	let message = "";
	const warnings = captureWarnings(() => {
		message = thrownMessage(() => loadAgentsFromDir(dir, "user"));
	});

	assert.ok(message.includes(file), `error does not name ${file}: ${message}`);
	assert.match(message, /permissionClass "admin"/);
	assert.equal(warnings.length, 0, "an unknown class must throw, not default to reader");
});

test("a package template with no permission class throws", (t) => {
	const { root, template } = fixtureRoot(t, "name: goblin\ndescription: test agent\n");

	let message = "";
	const warnings = captureWarnings(() => {
		message = thrownMessage(() => loadTemplateAgents(root));
	});

	assert.ok(message.includes(template), `error does not name ${template}: ${message}`);
	assert.match(message, /permissionClass missing/);
	assert.equal(warnings.length, 0, "a package template must not default to reader");
});

test("a user agent file that claims orchestrator loads as reader with one warning", (t) => {
	const { dir, file } = userAgentDir(t, "name: goblin\ndescription: test agent\npermissionClass: orchestrator");

	let agents: AgentConfig[] = [];
	const warnings = captureWarnings(() => {
		agents = loadAgentsFromDir(dir, "user");
		loadAgentsFromDir(dir, "user");
	});

	assert.equal(agents.length, 1, "the user file was not loaded");
	assert.equal(agents[0].permissionClass, "reader", "a claim above reader must be clamped to reader");
	assert.equal(warnings.length, 1, `expected one warning, got: ${warnings.join(" | ")}`);
	assert.ok(warnings[0].includes(file), `warning does not name ${file}: ${warnings[0]}`);
	assert.match(warnings[0], /orchestrator/, "the warning must name the requested class");
	assert.match(warnings[0], /reader/, "the warning must name the class applied");
});

test("a user agent file that claims worker loads as reader with one warning", (t) => {
	const { dir, file } = userAgentDir(t, "name: goblin\ndescription: test agent\npermissionClass: worker");

	let agents: AgentConfig[] = [];
	const warnings = captureWarnings(() => {
		agents = loadAgentsFromDir(dir, "user");
		loadAgentsFromDir(dir, "user");
	});

	assert.equal(agents.length, 1, "the user file was not loaded");
	assert.equal(agents[0].permissionClass, "reader", "a claim above reader must be clamped to reader");
	assert.equal(warnings.length, 1, `expected one warning, got: ${warnings.join(" | ")}`);
	assert.ok(warnings[0].includes(file), `warning does not name ${file}: ${warnings[0]}`);
	assert.match(warnings[0], /worker/, "the warning must name the requested class");
	assert.match(warnings[0], /reader/, "the warning must name the class applied");
});

test("a user agent file that names reader stays reader and warns nothing", (t) => {
	const { dir } = userAgentDir(t, "name: goblin\ndescription: test agent\npermissionClass: reader");

	let agents: AgentConfig[] = [];
	const warnings = captureWarnings(() => {
		agents = loadAgentsFromDir(dir, "user");
		loadAgentsFromDir(dir, "user");
	});

	assert.equal(agents.length, 1, "the user file was not loaded");
	assert.equal(agents[0].permissionClass, "reader", "a named reader class must be kept");
	assert.equal(warnings.length, 0, `a named reader class must not warn, got: ${warnings.join(" | ")}`);
});

test("a user agent file with a blank permission class loads as reader with one warning", (t) => {
	const { dir, file } = userAgentDir(t, "name: goblin\ndescription: test agent\npermissionClass:");

	let agents: AgentConfig[] = [];
	const warnings = captureWarnings(() => {
		agents = loadAgentsFromDir(dir, "user");
	});

	assert.equal(agents.length, 1, "the user file was not loaded");
	assert.equal(agents[0].permissionClass, "reader", "a blank class must load as reader");
	assert.equal(warnings.length, 1, `expected one warning, got: ${warnings.join(" | ")}`);
	assert.ok(warnings[0].includes(file), `warning does not name ${file}: ${warnings[0]}`);
});

// --- persona discovery: one read path for both layouts -----------------------

/** A temp persona root with one bare file and one theme file holding the same body. */
function personaRoot(t: TestContext, body: string): { dir: string; filePath: string; themePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-persona-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const themeDir = path.join(dir, "goblin");
	fs.mkdirSync(themeDir, { recursive: true });
	const filePath = path.join(dir, "grubnik.md");
	const themePath = path.join(themeDir, "grubnik.md");
	fs.writeFileSync(filePath, body);
	fs.writeFileSync(themePath, body);
	return { dir, filePath, themePath };
}

test("a file persona and a theme persona with the same body yield the same config", (t) => {
	const body = "# Grubnik the Tinkerer\n\nA practical goblin.\n";
	const { dir, filePath, themePath } = personaRoot(t, body);

	const personas = loadPersonasFromDir(dir);
	assert.equal(personas.length, 2, `expected two personas, got: ${personas.length}`);

	const filePersona = personas.find((p) => p.filePath === filePath);
	const themePersona = personas.find((p) => p.filePath === themePath);
	assert.ok(filePersona, "the bare file persona was not loaded");
	assert.ok(themePersona, "the theme persona was not loaded");

	/** The fields both layouts must read the same way. */
	const shared = (p: PersonaConfig) => ({
		name: p.name,
		description: p.description,
		body: p.body,
		fileNameStem: p.fileNameStem,
	});
	assert.deepEqual(shared(themePersona), shared(filePersona), "the two layouts read different configs");
	assert.equal(themePersona.theme, "goblin", "the theme persona lost its theme");
	assert.equal(filePersona.theme, undefined, "a bare persona must carry no theme");
	assert.equal(filePersona.name, "grubnik", "a persona with no name must fall back to the file stem");
	assert.equal(filePersona.fileNameStem, "grubnik", "the file stem must be the bare file name");
	assert.equal(
		filePersona.description,
		"Grubnik the Tinkerer",
		"a persona with no description must use its heading",
	);
});

// --- the gate survives a malformed agent file --------------------------------

// An isolated (empty) global permissions file so the live repo file cannot
// interfere. It holds one deny rule, so the installed gate has a visible verdict.
const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "resolver-gate-global-")),
	"permissions.json",
);
fs.writeFileSync(
	isolatedGlobalFile,
	JSON.stringify({ deny: [{ tool: "bash", match: "^resolver-probe$", reason: "fixture deny" }], ask: [] }),
);
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;
after(() => fs.rmSync(path.dirname(isolatedGlobalFile), { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A fake pi that records `on` handlers; every other method is a no-op. */
function makePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
	const handlers = new Map<string, Handler[]>();
	const noop = (): void => {};
	const pi: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: noop,
		registerTool: noop,
		registerFlag: noop,
		getFlag: () => undefined,
		getSettings: () => ({}),
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

test("a malformed agent file does not stop the gate from installing", async (t) => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-gate-project-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const agentsDir = path.join(project, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "bad.md"),
		"---\nname: bad\ndescription: malformed agent\npermissionClass: admin\n---\n\nBAD BODY\n",
	);

	const saved = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string | undefined): void => {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	setEnv(ENV_RUN_ID, "resolver-gate-root");
	const gateLog = path.join(project, "tree-log.ndjson");
	setEnv(ENV_TREE_LOG, gateLog);

	try {
		const { pi, handlers } = makePi();
		assert.doesNotThrow(() => extension(pi), "a malformed agent file must not reach the factory");
		for (const handler of handlers.get("session_start") ?? []) {
			await handler(
				{ type: "session_start" },
				{ cwd: project, sessionManager: { getSessionId: () => "resolver-gate-session" } },
			);
		}
		const warnings = logLines(gateLog);

		assert.ok(
			warnings.some((line) => line.includes("agent discovery failed")),
			`discovery failure must log one line, got: ${warnings.join(" | ")}`,
		);
		const gate = handlers.get("tool_call") ?? [];
		assert.equal(gate.length, 1, "the gate must be installed");
		const verdict = (await gate[0](
			{ toolName: "bash", input: { command: "resolver-probe" } },
			{ cwd: project, hasUI: false, mode: "rpc", ui: {} },
		)) as { block?: boolean } | undefined;
		assert.equal(verdict?.block, true, "the installed gate must still deny its probe");
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
