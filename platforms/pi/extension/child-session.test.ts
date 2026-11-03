/**
 * Child session builder tests: the build fields, the parent loader identity,
 * the child guard, the dispose paths, the parent abort forward, and the
 * child-start cases that must leave the active agent unchanged.
 *
 * Run: npm test
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import type {
	AgentSession,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionAPI,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_ABORTED_ERROR_NAME,
	CHILD_ABORTED_REASON,
	CHILD_DEPTH_CAP_ERROR_NAME,
	CHILD_WILDCARD_ERROR_NAME,
	type BuildChildInput,
	type ChildLoadout,
	type ChildModel,
	type ChildParent,
	buildChildSession,
	inChildBuild,
	withChildBuild,
} from "./child-session.ts";
import extension from "./extension.ts";
import { DEPTH_CAP_REASON, ENV_PARENT_RUN_ID } from "./depth.ts";
import type { AgentConfig } from "./resolver.ts";
import { RunRegistry, type RunStart, newRunRecord } from "./run-registry.ts";
import { getActiveAgent, setActiveAgent, setActivePersona } from "./state.ts";

/** The nine build fields, sorted. */
const NINE = [
	"agentDir", "customTools", "cwd", "model", "resourceLoader",
	"sessionManager", "settingsManager", "thinkingLevel", "tools",
];

/** The five fields the build must leave absent. */
const ABSENT = ["modelRuntime", "scopedModels", "noTools", "excludeTools", "sessionStartEvent"];

const AGENT_DIR = "/tmp/child-session-agent-dir";

interface SetupOptions {
	cwd?: string;
	signal?: AbortSignal;
	fail?: Error;
	sessionId?: string;
	loader?: ResourceLoader;
	settingsManager?: SettingsManager;
}

interface Setup {
	input: BuildChildInput;
	seen: CreateAgentSessionOptions[];
	counters: { abort: number; dispose: number };
	loader: ResourceLoader;
	settingsManager: SettingsManager;
	sessionManager: SessionManager;
	loadout: ChildLoadout;
	registry: RunRegistry;
}

/** A build harness with a fake session, a fake factory, and one empty registry. */
function setup(options: SetupOptions = {}): Setup {
	const counters = { abort: 0, dispose: 0 };
	const session = {
		abort: async (): Promise<void> => {
			counters.abort += 1;
		},
		dispose: (): void => {
			counters.dispose += 1;
		},
	} as unknown as AgentSession;
	const loader = options.loader ?? ({} as ResourceLoader);
	const settingsManager = options.settingsManager ?? ({} as SettingsManager);
	const sessionManager = {} as SessionManager;
	const registry = new RunRegistry();
	const start: RunStart = {
		sessionId: options.sessionId ?? "child-one",
		role: "implementer",
		class: "worker",
		source: "package",
		skills: [],
		alwaysLoad: [],
		depth: 1,
		parentSessionId: "root-session",
		sessionFile: null,
		startedAt: 1000,
	};
	const loadout: ChildLoadout = {
		tools: ["read", "bash"],
		customTools: [],
		model: { id: "test-model" } as ChildModel,
		thinkingLevel: "medium",
	};
	const parent: ChildParent = {
		cwd: options.cwd ?? "/tmp/child-work",
		loader,
		settingsManager,
		signal: options.signal,
	};
	const seen: CreateAgentSessionOptions[] = [];
	const createSession = async (opts?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		if (options.fail) throw options.fail;
		seen.push(opts as CreateAgentSessionOptions);
		return { session, extensionsResult: {} } as unknown as CreateAgentSessionResult;
	};
	const input: BuildChildInput = {
		loadout,
		parent,
		start,
		sessionManager,
		registry,
		createSession,
		agentDir: AGENT_DIR,
	};
	return { input, seen, counters, loader, settingsManager, sessionManager, loadout, registry };
}

/** The record fields a caller chain shares. Only the id, depth, and parent change. */
const CHAIN_START: RunStart = {
	sessionId: "caller-0",
	role: "orchestrator",
	class: "orchestrator",
	source: "package",
	skills: [],
	alwaysLoad: [],
	depth: 0,
	parentSessionId: null,
	sessionFile: null,
	startedAt: 1000,
};

/**
 * Register a caller chain in `registry`: a root at depth 0 and `callerId` at
 * `callerDepth`. A later record walks to the root, so the walk answers the depth.
 */
function registerCallerChain(registry: RunRegistry, callerId: string, callerDepth: number): void {
	let parentSessionId: string | null = null;
	for (let depth = 0; depth <= callerDepth; depth += 1) {
		const id = depth === callerDepth ? callerId : `caller-${depth}`;
		registry.register(newRunRecord({ ...CHAIN_START, sessionId: id, depth, parentSessionId }));
		parentSessionId = id;
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	pi: ExtensionAPI;
	calls: string[];
	handlers: Map<string, Handler[]>;
}

/** A fake pi that records every registration the factory makes. */
function recordingPi(flags: Record<string, string> = {}): FakePi {
	const calls: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			calls.push(`on:${event}`);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: () => {
			calls.push("command");
		},
		registerTool: () => {
			calls.push("tool");
		},
		registerFlag: (name: string) => {
			calls.push(`flag:${name}`);
		},
		getFlag: (name: string) => flags[name],
		getSettings: () => ({}),
		appendEntry: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: () => {} },
	};
	return { pi: pi as unknown as ExtensionAPI, calls, handlers };
}

interface StartContext {
	cwd: string;
	sessionManager?: { getSessionId?: () => string };
}

/** A start context that names one session id. */
function startCtx(sessionId: string): StartContext {
	return { cwd: "/tmp/child-work", sessionManager: { getSessionId: () => sessionId } };
}

/** Fire every `session_start` handler the factory installed with one context. */
async function fireSessionStart(fake: FakePi, ctx: StartContext): Promise<void> {
	for (const handler of fake.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, ctx);
	}
}

/** Fire one start through a fresh factory, and return the active agent after it. */
async function activeAfterStart(ctx: StartContext): Promise<AgentConfig | null> {
	const fake = recordingPi({ agent: "off" });
	extension(fake.pi);
	setActiveAgent(namedAgent());
	await offRootTree(() => fireSessionStart(fake, ctx));
	return getActiveAgent();
}

/** The active agent a case starts from, before the defaults can change it. */
function namedAgent(): AgentConfig {
	return { name: "implementer" } as unknown as AgentConfig;
}

/** Run `body` with a parent run id set, so a start takes the child tree path. */
async function offRootTree(body: () => Promise<void>): Promise<void> {
	const saved = process.env[ENV_PARENT_RUN_ID];
	process.env[ENV_PARENT_RUN_ID] = "root-session";
	try {
		await body();
	} finally {
		if (saved === undefined) delete process.env[ENV_PARENT_RUN_ID];
		else process.env[ENV_PARENT_RUN_ID] = saved;
	}
}

after(() => {
	setActivePersona(null);
	setActiveAgent(null);
});

test("build: passes the nine fields and leaves the five absent", async () => {
	const s = setup();
	await buildChildSession(s.input);

	assert.equal(s.seen.length, 1, "the factory is called once");
	const options = s.seen[0] as CreateAgentSessionOptions;
	assert.deepEqual(Object.keys(options).sort(), NINE);
	for (const absent of ABSENT) {
		assert.ok(!(absent in options), `${absent} must stay absent`);
	}
	assert.equal(options.cwd, "/tmp/child-work");
	assert.equal(options.agentDir, AGENT_DIR);
	assert.equal(options.model, s.loadout.model);
	assert.equal(options.thinkingLevel, "medium");
	assert.deepEqual(options.tools, s.loadout.tools);
	assert.equal(options.customTools, s.loadout.customTools);
	assert.equal(options.resourceLoader, s.loader);
	assert.equal(options.sessionManager, s.sessionManager);
	assert.equal(options.settingsManager, s.settingsManager);
});

test("build: registers the record before the factory runs", async () => {
	const s = setup();
	let registeredDuringBuild = false;
	const input: BuildChildInput = {
		...s.input,
		createSession: async (): Promise<CreateAgentSessionResult> => {
			registeredDuringBuild = s.registry.get("child-one")?.status === "running";
			return { session: {} as AgentSession, extensionsResult: {} } as unknown as CreateAgentSessionResult;
		},
	};
	await buildChildSession(input);
	assert.ok(registeredDuringBuild, "the gate must resolve the child from its first call");
});

test("loader: two builds from one parent receive that same parent loader", async () => {
	const loader = {} as ResourceLoader;
	const s = setup({ loader });
	await buildChildSession(s.input);
	await buildChildSession({ ...s.input, start: { ...s.input.start, sessionId: "child-b" } });

	assert.equal(s.seen[0]?.resourceLoader, loader, "the first build takes the parent loader");
	assert.equal(s.seen[1]?.resourceLoader, loader, "a copy would be a second gate");
});

test("guard: the factory returns before defaults when the guard is set", async () => {
	assert.equal(inChildBuild(), false, "the guard is clear outside a build");
	const trap = new Proxy(
		{},
		{
			get: () => {
				throw new Error("the guarded factory touched pi");
			},
		},
	);
	await withChildBuild(async () => {
		assert.equal(inChildBuild(), true, "the guard is set inside the build");
		assert.doesNotThrow(() => extension(trap as unknown as ExtensionAPI));
	});
	assert.equal(inChildBuild(), false, "the guard clears with its async branch");
});

test("guard: a clear guard installs the gate, the flags, and the start handler", () => {
	const fake = recordingPi();
	extension(fake.pi);

	assert.ok(fake.calls.includes("flag:agent"), "the defaults path registers the agent flag");
	assert.ok(fake.calls.includes("flag:persona"), "the defaults path registers the persona flag");
	assert.ok(fake.calls.includes("on:tool_call"), "the gate is installed");
	assert.ok(fake.calls.includes("on:session_start"), "session start is watched");
});

test("depth: a caller at the cap is refused and no record or session is made", async () => {
	const s = setup();
	registerCallerChain(s.registry, "root-session", 2);
	const before = s.registry.size;

	await assert.rejects(buildChildSession(s.input), (error: unknown) => {
		assert.equal((error as Error).name, CHILD_DEPTH_CAP_ERROR_NAME, "the name tells a refusal from a failure");
		assert.equal((error as Error).message, DEPTH_CAP_REASON, "the caller sees the cap text");
		return true;
	});

	assert.equal(s.seen.length, 0, "the factory is never called");
	assert.equal(s.registry.size, before, "the registry gains no record");
	assert.equal(s.registry.get("child-one"), undefined, "the child id holds no record");
});

test("depth: a caller below the cap builds a child with no spawn tool", async () => {
	const s = setup();
	registerCallerChain(s.registry, "root-session", 1);
	const input: BuildChildInput = {
		...s.input,
		loadout: { ...s.loadout, tools: ["read", "subagent"] },
	};

	await buildChildSession(input);

	assert.deepEqual(s.seen[0]?.tools, ["read"], "the child at the cap cannot spawn");
});

test("depth: the caller depth comes from the record walk, not the start depth", async () => {
	const s = setup();
	// The start record claims depth 0, but the registry puts the caller at the cap.
	registerCallerChain(s.registry, "root-session", 2);
	const input: BuildChildInput = { ...s.input, start: { ...s.input.start, depth: 0 } };

	await assert.rejects(buildChildSession(input), (error: unknown) => {
		assert.equal((error as Error).message, DEPTH_CAP_REASON, "the walk wins over the start depth");
		return true;
	});

	assert.equal(s.seen.length, 0, "a wrong start depth cannot force a build");
	assert.equal(s.registry.get("child-one"), undefined, "the refused build leaves no record");
});

test("depth: a walk that cannot resolve the parent strips the spawn tool", async () => {
	// No caller record exists, so the walk fails and the fallback must stay closed.
	const s = setup({ sessionId: "child-walk" });
	const input: BuildChildInput = {
		...s.input,
		loadout: { ...s.loadout, tools: ["read", "subagent"] },
	};

	const built = await buildChildSession(input);

	assert.deepEqual(s.seen[0]?.tools, ["read"], "a broken chain still strips the spawn tool");
	built.dispose("done");
});

test("wildcard: a loadout that names a wildcard is refused before the build", async () => {
	const s = setup({ sessionId: "child-wild" });
	const input: BuildChildInput = {
		...s.input,
		loadout: { ...s.loadout, tools: ["read", "read*"] },
	};

	await assert.rejects(buildChildSession(input), (error: unknown) => {
		assert.equal((error as Error).name, CHILD_WILDCARD_ERROR_NAME, "the name tells a refusal from a failure");

		return /names a wildcard/.test((error as Error).message);
	});

	assert.equal(s.seen.length, 0, "a wildcard loadout builds no session");
	assert.equal(s.registry.get("child-wild"), undefined, "the refusal writes no record");
});

test("dispose: a successful build disposes once and a second dispose does nothing", async () => {
	const s = setup();
	const built = await buildChildSession(s.input);
	built.dispose("done");
	built.dispose("done");

	assert.equal(s.counters.dispose, 1);
	assert.equal(s.registry.get("child-one")?.status, "done");
	assert.notEqual(s.registry.get("child-one")?.endedAt, null);
});

test("dispose: an error exit runs the same single dispose path", async () => {
	const s = setup({ sessionId: "child-error" });
	const built = await buildChildSession(s.input);
	built.dispose("failed");
	built.dispose("failed");

	assert.equal(s.counters.dispose, 1);
	assert.equal(s.registry.get("child-error")?.status, "failed");
});

test("dispose: a failed build disposes nothing and marks the record failed", async () => {
	const s = setup({ fail: new Error("factory refused") });
	await assert.rejects(buildChildSession(s.input), /factory refused/);

	assert.equal(s.counters.dispose, 0, "no session exists, so nothing is disposed");
	assert.equal(s.registry.get("child-one")?.status, "failed");
	assert.equal(inChildBuild(), false, "the guard clears after a throw");
});

test("dispose: a parent signal that already fired aborts, disposes once, and raises", async () => {
	const controller = new AbortController();
	controller.abort();
	const s = setup({ signal: controller.signal, sessionId: "child-aborted" });
	await assert.rejects(buildChildSession(s.input), (error: unknown) => {
		const thrown = error as Error;
		assert.equal(thrown.name, CHILD_ABORTED_ERROR_NAME, "the name tells abort from failure");
		assert.equal(thrown.message, CHILD_ABORTED_REASON);
		return true;
	});

	assert.equal(s.counters.abort, 1);
	assert.equal(s.counters.dispose, 1);
	assert.equal(s.registry.get("child-aborted")?.status, "failed");
});

test("abort: a fired parent signal aborts the child once", async () => {
	// The fake keeps the listener after a fire, so only the aborted flag stops the second call.
	const listeners: Array<() => void> = [];
	const signal = {
		aborted: false,
		addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
	} as unknown as AbortSignal;
	const s = setup({ signal, sessionId: "child-live" });
	await buildChildSession(s.input);
	for (const listener of listeners) listener();
	for (const listener of listeners) listener();

	assert.equal(s.counters.abort, 1, "the aborted flag stops the second abort");
});

test("abort: a disposed child refuses a second abort", async () => {
	const controller = new AbortController();
	const s = setup({ signal: controller.signal, sessionId: "child-closed" });
	const built = await buildChildSession(s.input);
	built.dispose("done");
	controller.abort();

	assert.equal(s.counters.abort, 0, "a closed child takes no abort");
	assert.equal(s.counters.dispose, 1);
});

test("session_start: a known child id leaves the active agent unchanged", async () => {
	const s = setup({ sessionId: "child-start" });
	await buildChildSession(s.input);

	const active = await activeAfterStart(startCtx("child-start"));

	assert.equal(active?.name, "implementer", "a child start must not take the defaults");
});

test("session_start: a start with no session manager leaves the active agent unchanged", async () => {
	const active = await activeAfterStart({ cwd: "/tmp/child-work" });

	assert.equal(active?.name, "implementer", "a missing id is not trusted as the root start");
});

test("session_start: a session manager that throws leaves the active agent unchanged", async () => {
	const active = await activeAfterStart({
		cwd: "/tmp/child-work",
		sessionManager: { getSessionId: (): string => { throw new Error("no id"); } },
	});

	assert.equal(active?.name, "implementer", "an unreadable id is not trusted as the root start");
});

test("session_start: a disposed child id takes the defaults on a later start", async () => {
	const s = setup({ sessionId: "child-reused" });
	const built = await buildChildSession(s.input);
	built.dispose("done");

	const active = await activeAfterStart(startCtx("child-reused"));

	assert.equal(active, null, "a released id is no longer a child");
});

test("session_start: an id from a failed build takes the defaults", async () => {
	const s = setup({ fail: new Error("factory refused") });
	await assert.rejects(buildChildSession(s.input), /factory refused/);
	const active = await activeAfterStart(startCtx("child-one"));
	assert.equal(active, null, "a failed build leaves no child behind");
});

test("session_start: an unknown id still applies the defaults", async () => {
	const active = await activeAfterStart(startCtx("root-session"));

	assert.equal(active, null, "an unknown id takes the defaults");
});
