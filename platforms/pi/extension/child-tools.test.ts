/**
 * Child tool wrapper: the parent verdict on every loadout tool, the deny an ask
 * in a child becomes, and the loadout/wrapper equality.
 *
 * The gate handler is the real installed one over a fixture table, the root
 * prompt is a fake, and the child session is fake. The root record comes from
 * the real registry binding, so a child ask walks to a real root.
 *
 * Run: npm test
 */

import { after, afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentSession,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionAPI,
	ExtensionToolContext,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type BuiltChild, type ChildModel, buildChildSession } from "./child-session.ts";
import {
	CHILD_ASK_TOOL,
	NO_PARENT_GATE_REASON,
	type ChildToolDefinition,
	assertWrapperListEquals,
	bindParentGate,
	builtinChildTool,
	captureRegisteredTools,
	childToolImplementation,
	clearChildToolImplementations,
	gateableChildTools,
	missingChildToolReason,
	missingChildTools,
	parentGateHandler,
	registerChildTool,
	wildcardChildTools,
	wildcardLoadoutReason,
	wrapChildTools,
} from "./child-tools.ts";
import { CHILD_A, ROOT, RootPrompter, childContext, repoRoot, rootContext } from "./gate-fixture.ts";
import { loadDefaultRows } from "./permission-config.ts";
import { CHILD_ASK_DENIED_REASON, compileGateSource, type GateRuleSourceFactory, installToolCallGate } from "./permissions.ts";
import type { AgentConfig, AgentSource, PermissionClass, PermissionRule } from "./resolver.ts";
import { RunRegistry, bindRunRegistry, newRunRecord } from "./run-registry.ts";
import { getRunRegistry, registerRootSession } from "./subagent-run.ts";
import registerSubagentTool from "./subagent.ts";
import { registerTodoTool } from "./todo-tool.ts";

afterEach(() => {
	bindRunRegistry(null);
	clearChildToolImplementations();
});

after(() => {
	bindParentGate(null);
});

/** The worker role the gate compares against. */
const AGENT: AgentConfig = {
	name: "implementer",
	description: "child tool fixture",
	systemPrompt: "",
	source: "package",
	filePath: "",
	permissionClass: "worker",
};

/** The root role, which holds the history verbs a child must not get. */
const ORCHESTRATOR: AgentConfig = { ...AGENT, name: "orchestrator", permissionClass: "orchestrator" };

/** The settings a builtin definition reads. */
function fakeSettings(): SettingsManager {
	return {
		getImageAutoResize: () => true,
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
	} as unknown as SettingsManager;
}

/** The gate handler type the fake pi captures. */
type Gate = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

/** Install the real gate over one rule source and bind the child runtime. */
function installGateWith(agent: AgentConfig, source: GateRuleSourceFactory): Gate {
	bindRunRegistry(getRunRegistry());
	registerRootSession(ROOT, agent);
	let captured: Gate | null = null;
	const pi = {
		on(name: string, handler: Gate): void {
			if (name === "tool_call") captured = handler;
		},
	};
	installToolCallGate(pi as unknown as ExtensionAPI, () => agent, source, getRunRegistry());
	assert.ok(captured, "the gate must register a tool_call handler");
	return captured;
}

/** The fixture table: a commit denies, a push asks, and a status allows. */
function installGate(): Gate {
	const deny: PermissionRule[] = [{ tool: "bash", match: "^git\\s+commit\\b", reason: "history write" }];
	const ask: PermissionRule[] = [{ tool: "bash", match: "^git\\s+push\\b", reason: "publishing" }];
	const allow: PermissionRule[] = [
		{ tool: "bash", match: "^git\\s+status\\b" },
		// An in-process tool: the probe is the JSON of its input.
		{ tool: "todo", match: "list" },
	];
	const source: GateRuleSourceFactory = () => ({
		ruleSets: { globalDeny: [], agentDeny: deny, globalAsk: [], agentAsk: ask, agentAllow: allow },
		mode: "deny-by-default",
	});
	return installGateWith(AGENT, source);
}

/** The shipped table and role lookup: only the record puts a child in its class. */
function installRealGate(): Gate {
	return installGateWith(ORCHESTRATOR, compileGateSource(loadDefaultRows()));
}

/** A recorded delegate: one tool that records its calls and answers with text. */
function delegate(name: string): { definition: ChildToolDefinition; calls: Array<Record<string, unknown>> } {
	const calls: Array<Record<string, unknown>> = [];
	const definition: ChildToolDefinition = {
		name,
		label: name,
		description: `fixture ${name}`,
		parameters: { type: "object" } as never,
		execute: async (_toolCallId, params) => {
			calls.push((params ?? {}) as Record<string, unknown>);
			return { content: [{ type: "text", text: `${name} ran` }], details: undefined };
		},
	};
	return { definition, calls };
}

/** Build one child through the real builder, and keep the options it passed. */
async function buildChild(
	names: string[],
	wrappers: ChildToolDefinition[],
): Promise<{ options: CreateAgentSessionOptions; built: BuiltChild }> {
	const seen: CreateAgentSessionOptions[] = [];
	const session = {
		subscribe: () => () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose: () => {},
	} as unknown as AgentSession;
	const sessionManager = {
		getSessionId: () => CHILD_A,
		getSessionFile: () => null,
	} as unknown as SessionManager;
	const built = await buildChildSession({
		loadout: { tools: names, customTools: wrappers, model: {} as ChildModel },
		parent: { cwd: repoRoot, loader: {} as ResourceLoader, settingsManager: fakeSettings() },
		start: {
			sessionId: CHILD_A,
			role: AGENT.name,
			class: "worker",
			source: "package",
			skills: [],
			alwaysLoad: [],
			depth: 1,
			parentSessionId: ROOT,
			sessionFile: null,
			startedAt: 0,
		},
		sessionManager,
		registry: getRunRegistry(),
		createSession: async (options): Promise<CreateAgentSessionResult> => {
			seen.push(options as CreateAgentSessionOptions);
			return { session, extensionsResult: {} } as unknown as CreateAgentSessionResult;
		},
	});
	assert.equal(seen.length, 1, "the builder ran once");
	return { options: seen[0], built };
}

/** Run one wrapper tool the way the child model would, in the child context. */
async function callTool(
	wrapper: ChildToolDefinition,
	args: Record<string, unknown>,
	prompter: RootPrompter,
): Promise<{ text: string; isError: boolean }> {
	const ctx = childContext(CHILD_A, prompter) as unknown as ExtensionToolContext;
	const result = await wrapper.execute("call-1", args, undefined, undefined, ctx);
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { text, isError: result.isError === true };
}

/** One root call that the gate allows, which binds the root prompt surface. */
async function captureRoot(handler: Gate, prompter: RootPrompter): Promise<void> {
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, rootContext(prompter));
	assert.equal(result, undefined, "the root setup call must run");
}

/** Register one child record under the root, so a case can vary one identity field. */
function registerChild(fields: {
	role: string;
	cls: PermissionClass;
	source: AgentSource;
	skills?: string[];
	alwaysLoad?: string[];
}): void {
	getRunRegistry().register(
		newRunRecord({
			sessionId: CHILD_A,
			role: fields.role,
			class: fields.cls,
			source: fields.source,
			skills: fields.skills ?? [],
			alwaysLoad: fields.alwaysLoad ?? [],
			depth: 1,
			parentSessionId: ROOT,
			sessionFile: null,
			startedAt: 0,
		}),
	);
}

/** One gated call in the child context: the block flag and its reason. */
async function childVerdict(
	handler: Gate,
	toolName: string,
	input: Record<string, unknown>,
	prompter: RootPrompter,
): Promise<{ blocked: boolean; reason?: string }> {
	const ctx = childContext(CHILD_A, prompter) as unknown as ExtensionToolContext;
	const result = (await handler({ toolName, input }, ctx as never)) as { block?: boolean; reason?: string } | undefined;
	return { blocked: result?.block === true, reason: result?.reason };
}
/** A prompter that answers with the given choices in order. */
function prompterOf(answers: string[]): RootPrompter {
	const prompter = new RootPrompter();
	prompter.answers = answers;
	return prompter;
}
// --- one verdict per call ----------------------------------------------------

test("class: a child is judged by its own role, not the root role", async () => {
	const handler = installRealGate();
	registerRootSession(ROOT, ORCHESTRATOR);
	const prompter = prompterOf(["Allow once"]);
	await captureRoot(handler, prompter);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });
	const { built } = await buildChild(["bash"], [wrapper]);

	const out = await callTool(wrapper, { command: "git add platforms" }, prompter);
	built.dispose("done");

	assert.equal(out.isError, true, "the implementer child denies a history verb");
	assert.match(out.text, /History verbs are denied/);
	assert.equal(bash.calls.length, 0, "the denied tool never runs");
});

test("verdict: an allow runs the wrapped tool and shows no prompt", async () => {
	const handler = installGate();
	const prompter = prompterOf(["Allow once"]);
	await captureRoot(handler, prompter);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });
	const { built } = await buildChild(["bash"], [wrapper]);

	const out = await callTool(wrapper, { command: "git status" }, prompter);
	built.dispose("done");

	assert.equal(out.isError, false, out.text);
	assert.equal(bash.calls.length, 1, "the wrapped tool ran once");
	assert.equal(prompter.titles.length, 0, "an allow asks nothing");
});

test("verdict: a deny blocks the wrapped tool before it runs", async () => {
	const handler = installGate();
	const prompter = prompterOf(["Allow once"]);
	await captureRoot(handler, prompter);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });
	const { built } = await buildChild(["bash"], [wrapper]);

	const out = await callTool(wrapper, { command: "git commit -m x" }, prompter);
	built.dispose("done");

	assert.equal(out.isError, true, "a deny is a blocked tool result");
	assert.match(out.text, /history write/);
	assert.equal(bash.calls.length, 0, "a denied tool never runs");
});

test("verdict: a child ask is denied at once, with the child reason", async () => {
	const handler = installGate();
	const prompter = prompterOf(["Allow once"]);
	await captureRoot(handler, prompter);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });
	const { built } = await buildChild(["bash"], [wrapper]);

	const out = await callTool(wrapper, { command: "git push origin main" }, prompter);
	built.dispose("done");

	assert.equal(out.isError, true, "a child ask is a blocked tool result");
	assert.equal(out.text, CHILD_ASK_DENIED_REASON, "the wrapper returns the child reason");
	assert.equal(prompter.titles.length, 0, "a child ask renders no prompt");
	assert.equal(bash.calls.length, 0, "the wrapped tool never runs on an ask");
});

test("gate: no bound gate blocks every wrapper", async () => {
	bindParentGate(null);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });

	const out = await callTool(wrapper, { command: "git status" }, prompterOf([]));

	assert.equal(out.isError, true, "a call with no gate fails closed");
	assert.equal(out.text, NO_PARENT_GATE_REASON);
	assert.equal(bash.calls.length, 0);
});

// --- the root record and the child deny --------------------------------------

test("root: a child record walks to the root, and its ask is denied below the root", async () => {
	const handler = installGate();
	const walk = getRunRegistry().walk(ROOT);
	assert.equal(walk.ok, true, "the root record is registered");
	assert.equal(walk.ok ? walk.depth : -1, 0, "the root sits at depth 0");

	const prompter = prompterOf(["Deny"]);
	await captureRoot(handler, prompter);
	const bash = delegate("bash");
	const [wrapper] = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });
	const { built } = await buildChild(["bash"], [wrapper]);

	const childWalk = getRunRegistry().walk(CHILD_A);
	assert.equal(childWalk.ok, true, "the child walks to a root");
	assert.equal(childWalk.ok ? childWalk.depth : -1, 1, "the child sits one hop below the root");
	assert.equal(childWalk.ok ? childWalk.rootSessionId : "", ROOT, "the walk ends at the registered root");

	const out = await callTool(wrapper, { command: "git push" }, prompter);
	built.dispose("done");

	assert.equal(out.isError, true, "a child ask is a blocked tool result");
	assert.equal(out.text, CHILD_ASK_DENIED_REASON, "the deny names the fix, not the root denial");
	assert.equal(prompter.titles.length, 0, "the child ask reaches no root prompt");
	assert.equal(bash.calls.length, 0);
});

// --- the wrapper list and the loadout ---------------------------------------

test("loadout: the wrapper list equals the child loadout", async () => {
	const todo = delegate("todo");
	const bash = delegate("bash");
	const loadout = ["bash", "todo"];
	const wrappers = wrapChildTools({ names: loadout, customTools: [bash.definition, todo.definition] });

	assert.deepEqual(
		wrappers.map((tool) => tool.name),
		loadout,
		"one wrapper per loadout name, in loadout order",
	);
	assertWrapperListEquals(loadout, wrappers);

	const { options } = await buildChild(loadout, wrappers);
	assert.deepEqual(options.tools, loadout, "the allowlist is the loadout");
	assert.deepEqual(
		options.customTools?.map((tool) => tool.name),
		loadout,
		"the child registers the wrappers and nothing else",
	);
});

test("loadout: an MCP name stays out of the wrapper list, as on the root path", async () => {
	const loadout = ["read", "mcp__exa__*", "server.tool"];
	const read = delegate("read");
	const wrappers = wrapChildTools({ names: loadout, customTools: [read.definition] });

	assert.deepEqual(gateableChildTools(loadout), ["read"], "only the gateable name is wrapped");
	assert.deepEqual(wrappers.map((tool) => tool.name), ["read"], "no wrapper carries an MCP name");
	assertWrapperListEquals(loadout, wrappers);
});

test("loadout: a name outside the wrapper list has no path to run", async () => {
	const bash = delegate("bash");
	const wrappers = wrapChildTools({ names: ["bash"], customTools: [bash.definition] });

	assert.equal(
		wrappers.find((tool) => tool.name === "read"),
		undefined,
		"an unnamed tool has no wrapper",
	);
	assert.throws(
		() => assertWrapperListEquals(["bash", "read"], wrappers),
		/the wrapper list must equal the loadout/,
		"a loadout the wrappers do not cover fails the build",
	);
});

test("loadout: a custom tool in the loadout runs and is gated the same way", async () => {
	const handler = installGate();
	const prompter = prompterOf(["Allow once"]);
	await captureRoot(handler, prompter);
	const todo = delegate("todo");
	const seen: string[] = [];
	const askedGate = parentGateHandler() as unknown;
	const [wrapper] = wrapChildTools({
		names: ["todo"],
		customTools: [todo.definition],
		gate: () => {
			seen.push("asked");
			return askedGate as never;
		},
	});
	const { built } = await buildChild(["todo"], [wrapper]);

	const out = await callTool(wrapper, { action: "list" }, prompter);
	built.dispose("done");

	assert.equal(seen.length, 1, "the wrapper asked the parent gate");
	assert.equal(out.isError, false, out.text);
	assert.equal(todo.calls.length, 1, "the in-process tool ran after the verdict");
});

test("loadout: a name with no implementation is refused and named", () => {
	assert.deepEqual(missingChildTools(["read", "unknown_tool"]), ["unknown_tool"], "only the unknown name is missing");
	assert.match(missingChildToolReason(["unknown_tool"]), /"unknown_tool"/, "the refusal names the entry");
	assert.throws(
		() => wrapChildTools({ names: ["unknown_tool"], gate: () => async () => undefined }),
		/"unknown_tool"/,
		"no wrapper stands in for a missing implementation",
	);
});

test("loadout: a kept definition runs when the caller passes no custom tool", async () => {
	const todo = delegate("todo");
	registerChildTool(todo.definition);
	const [wrapper] = wrapChildTools({ names: ["todo"], gate: () => async () => undefined });
	const { built } = await buildChild(["todo"], [wrapper]);

	const out = await callTool(wrapper, { action: "list" }, prompterOf([]));
	built.dispose("done");

	assert.equal(childToolImplementation("todo")?.name, "todo", "the definition is kept for a child");
	assert.equal(out.isError, false, out.text);
	assert.equal(todo.calls.length, 1, "the kept definition ran");
});

/** Every shipped pi frontmatter loadout, read from its `tools:` line. */
function shippedLoadouts(): Array<{ file: string; names: string[] }> {
	const dir = path.join(repoRoot, "platforms/pi/frontmatters");
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".yaml"))
		.map((file) => {
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			const line = text.split("\n").find((entry) => entry.startsWith("tools:"));
			assert.ok(line, `${file} carries a tools loadout`);
			const inside = line.slice(line.indexOf("[") + 1, line.lastIndexOf("]"));
			const names = inside
				.split(",")
				.map((name) => name.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			return { file, names };
		});
}

test("loadout: every name in every shipped frontmatter loadout has an implementation", () => {
	const fakePi = { registerTool: () => {}, on: () => {} } as unknown as ExtensionAPI;
	// The real registrations run through the capture proxy, as the factory does.
	const toolPi = captureRegisteredTools(fakePi);
	registerSubagentTool(toolPi);
	registerTodoTool(toolPi);
	registerChildTool(CHILD_ASK_TOOL);

	const loadouts = shippedLoadouts();
	assert.ok(loadouts.length >= 7, "the shipped frontmatter set is read");
	const names = loadouts.flatMap((loadout) => loadout.names);
	for (const name of ["todo", "subagent", "ask_user_question"]) {
		assert.ok(names.includes(name), `a shipped loadout names ${name}`);
	}
	assert.deepEqual(missingChildTools(names), [], "every shipped loadout name resolves an implementation");
});

test("loadout: a wildcard entry stays in the wrapper list and is named", () => {
	assert.deepEqual(wildcardChildTools(["read", "read*", "*", "mcp__exa__*"]), ["read*", "*"], "only a non-MCP wildcard is named");
	assert.deepEqual(gateableChildTools(["*"]), ["*"], "a wildcard is gateable, so the filter cannot drop it");
	assert.throws(
		() => assertWrapperListEquals(["*", "read"], []),
		/the wrapper list must equal the loadout/,
		"a wildcard loadout with no wrapper is a mismatch",
	);
	assert.match(wildcardLoadoutReason(["read*"]), /"read\*"/, "the refusal names the entry");
});

// --- the child identity the gate reads ---------------------------------------

test("identity: a project child keeps its own source, so no notes zone binds", async () => {
	const rootAgent: AgentConfig = { ...ORCHESTRATOR };
	const handler = installGateWith(rootAgent, compileGateSource(loadDefaultRows()));
	const prompter = prompterOf(["Allow once"]);
	const notesPath = path.join(os.homedir(), "agent-notes", "implementer", "note.md");

	registerChild({ role: "implementer", cls: "worker", source: "package" });
	const packaged = await childVerdict(handler, "write", { path: notesPath }, prompter);
	registerChild({ role: "implementer", cls: "worker", source: "project" });
	const project = await childVerdict(handler, "write", { path: notesPath }, prompter);

	assert.equal(packaged.blocked, false, "a package child keeps the role notes zone");
	assert.equal(project.blocked, true, "a project child binds no notes zone, so the write falls to deny");
});

test("identity: a child gets only the skills its record names", async () => {
	const rootAgent: AgentConfig = { ...ORCHESTRATOR, skills: ["common/journal-management-generic"] };
	const handler = installGateWith(rootAgent, compileGateSource(loadDefaultRows()));
	const prompter = prompterOf(["Allow once"]);
	const script = path.join(repoRoot, "content/skills/common/journal-management-generic/scripts/journal-write.sh");

	registerChild({ role: "implementer", cls: "worker", source: "package", skills: ["common/journal-management-generic"] });
	const named = await childVerdict(handler, "bash", { command: `bash ${script}` }, prompter);
	registerChild({ role: "implementer", cls: "worker", source: "package" });
	const unnamed = await childVerdict(handler, "bash", { command: `bash ${script}` }, prompter);

	assert.equal(named.blocked, false, "the recorded skill makes its script dir reachable");
	assert.equal(unnamed.blocked, true, "the root's skills do not reach the child");
});

test("identity: a child gets only the always-load patterns its record names", async () => {
	const rootAgent: AgentConfig = { ...ORCHESTRATOR, alwaysLoad: ["common/journal-management-generic"] };
	const handler = installGateWith(rootAgent, compileGateSource(loadDefaultRows()));
	const prompter = prompterOf(["Allow once"]);
	const script = path.join(repoRoot, "content/skills/common/journal-management-generic/scripts/journal-write.sh");

	registerChild({
		role: "implementer",
		cls: "worker",
		source: "package",
		alwaysLoad: ["common/journal-management-generic"],
	});
	const named = await childVerdict(handler, "bash", { command: `bash ${script}` }, prompter);
	registerChild({ role: "implementer", cls: "worker", source: "package" });
	const unnamed = await childVerdict(handler, "bash", { command: `bash ${script}` }, prompter);

	assert.equal(named.blocked, false, "the recorded pattern makes its script dir reachable");
	assert.equal(unnamed.blocked, true, "the root's patterns do not reach the child");
});

// --- the builtin delegates --------------------------------------------------

test("builtin: every builtin loadout name resolves and an unknown name does not", () => {
	const settings = fakeSettings();
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]) {
		const definition = builtinChildTool(name, repoRoot, settings);
		assert.equal(definition?.name, name, `${name} resolves a builtin definition`);
	}
	assert.equal(builtinChildTool("todo", repoRoot, settings), null, "an in-process name is not a builtin");
});

/** The registry is process-wide: one instance holds the root and every child. */
test("registry: one run registry serves the process", () => {
	assert.equal(getRunRegistry(), getRunRegistry(), "a second call returns the same registry");
	assert.ok(getRunRegistry() instanceof RunRegistry, "the registry is the real map");
});
