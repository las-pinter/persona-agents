/**
 * Dispatch tests: the three modes over the in-process child builder.
 *
 * Proves the shared result field set, the chain handoff and its 24 KiB cap,
 * and one dispose per child when the parent cancels. Every child is fake, so
 * no model call and no session file is needed.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import type {
	AgentSession,
	AgentSessionEvent,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildModel } from "./child-session.ts";
import { inChildBuild } from "./child-session.ts";
import { bindParentGate, clearChildToolImplementations, registerChildTool } from "./child-tools.ts";
import type { AgentConfig } from "./resolver.ts";
import { RUN_RETENTION_MS, RunRegistry, newRunRecord } from "./run-registry.ts";
import type { SingleResult, SubagentDetails } from "./subagent-result.ts";
import { type DispatchDeps, type PreparedChildRuntime, finishRootSession, prepareChildRuntime } from "./subagent-run.ts";
import { type ModeRun, runChainMode, runParallelMode, runSingleMode } from "./subagent.ts";

/** The result fields every mode must return. The chain adds no field of its own. */
const RESULT_FIELDS = [
	"agent", "agentSource", "exitCode", "messages", "model", "reasoningTokens", "runStartedAt",
	"step", "stopReason", "stderr", "task", "thinking", "usage",
].sort();

const AGENT = {
	name: "tester",
	source: "user",
	tools: ["read", "write"],
	permissionClass: "worker",
	spawnable: true,
} as unknown as AgentConfig;

afterEach(() => {
	bindParentGate(null);
	clearChildToolImplementations();
});

/** One fake child: the build options, the prompts it took, and its exit counters. */
interface Child {
	options: CreateAgentSessionOptions;
	session: AgentSession;
	prompts: string[];
	disposed: number;
	aborted: number;
}

interface HarnessOptions {
	/** The reply text per built child, in build order. */
	replies?: string[];
	/** Fires inside `prompt`, so a case can cancel the parent signal. */
	onPrompt?: (index: number, text: string) => void;
	/** Holds a prompt open, so parallel children overlap. */
	beforeReply?: () => Promise<void>;
	/** Returns an error message, and that build throws instead of building. */
	failBuild?: (build: number) => string | null;
	signal?: AbortSignal;
	agent?: AgentConfig;
	/** The parent session id. A null value models a manager that cannot answer. */
	parentSessionId?: string | null;
}

interface Harness {
	deps: DispatchDeps;
	children: Child[];
	registry: RunRegistry;
	mode: ModeRun;
}

/** The assistant message a fake child answers with. */
function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 }, totalTokens: 11, reasoning: 3 },
		stopReason: "end",
		model: "fake/model",
	} as unknown as Message;
}

/** The settings a builtin child tool reads. A fake must answer them. */
function fakeSettings(): SettingsManager {
	return {
		getImageAutoResize: () => true,
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
	} as unknown as SettingsManager;
}

/**
 * A harness with one registry, one fake agent, and a fake session per build.
 * The prepared session id is `child-<index>`, so a case can read its record.
 */
function harness(options: HarnessOptions = {}): Harness {
	const agent = options.agent ?? AGENT;
	const children: Child[] = [];
	const registry = new RunRegistry();
	let nextId = 0;
	let builds = 0;
	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope: "user",
			projectAgentsDir: null,
			results,
		});

	const prepare = async (): Promise<PreparedChildRuntime> => {
		// A dedicated counter keeps two parallel builds on two ids.
		const id = `child-${nextId++}`;
		const sessionManager = {
			getSessionId: () => id,
			getSessionFile: () => undefined,
		} as unknown as SessionManager;
		return { sessionManager, loader: {} as ResourceLoader, settingsManager: fakeSettings() };
	};

	const createSession = async (buildOptions?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		// A failed build must not shift the child index, so it counts separately.
		const failure = options.failBuild?.(builds++);
		if (failure) throw new Error(failure);
		const index = children.length;
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const child = {
			options: buildOptions ?? {},
			prompts: [] as string[],
			disposed: 0,
			aborted: 0,
			session: null as unknown as AgentSession,
		};
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async (text: string) => {
				child.prompts.push(text);
				options.onPrompt?.(index, text);
				await options.beforeReply?.();
				const message = assistantMessage(options.replies?.[index] ?? "reply");
				for (const listener of listeners) listener({ type: "message_end", message });
			},
			abort: async () => {
				child.aborted += 1;
			},
			dispose: () => {
				child.disposed += 1;
			},
		};
		child.session = session as unknown as AgentSession;
		children.push(child);
		return { session: child.session, extensionsResult: {} } as unknown as CreateAgentSessionResult;
	};

	const deps: DispatchDeps = {
		defaultCwd: "/tmp/subagent-work",
		defaults: {
			model: "fake/model",
			modelObject: { id: "fake-model" } as ChildModel,
			thinkingLevel: "medium",
		},
		agents: [agent],
		resolveTarget: (name: string) => (name === agent.name ? { agent } : null),
		resolveSpawnPersona: () => null,
		runtime: {
			registry,
			parentSessionId: options.parentSessionId === undefined ? "root-session" : options.parentSessionId,
			createSession,
			prepare,
		},
	};

	const mode: ModeRun = { deps, signal: options.signal, onUpdate: undefined, makeDetails };
	return { deps, children, registry, mode };
}

/** The keys of one result, sorted, so a missing field cannot pass. */
function fieldKeys(result: SingleResult | undefined): string[] {
	assert.ok(result, "the mode returned a result");
	return Object.keys(result).sort();
}

/** Assert that every named record is closed, so no session leaks as running. */
function assertClosed(registry: RunRegistry, ids: string[]): void {
	for (const id of ids) {
		const record = registry.get(id);
		assert.equal(record?.status, "failed", `${id} is marked failed`);
		assert.notEqual(record?.endedAt, null, `${id} carries an exit time`);
	}
}

/** Wait, bounded, until the expected children have disposed. A hang is never a proof. */
async function waitForDispose(children: Child[], expected: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (children.length === expected && children.every((child) => child.disposed === 1)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("a child was never built, or never disposed");
}

test("single: the result carries the shared field set", async () => {
	const h = harness({ replies: ["alpha"] });
	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.deepEqual(fieldKeys(out.details?.results[0]), RESULT_FIELDS);
	assert.equal(out.content[0].type, "text");
	assert.match(h.children[0].prompts[0], /## Profession: tester/, "the child prompt carries its role");
});

test("parallel: the result carries the shared field set", async () => {
	const h = harness({ replies: ["alpha", "beta"] });
	const out = await runParallelMode(
		[
			{ agent: "tester", task: "one" },
			{ agent: "tester", task: "two" },
		],
		h.mode,
	);

	assert.equal(out.details?.results.length, 2);
	for (const result of out.details?.results ?? []) {
		assert.deepEqual(fieldKeys(result), RESULT_FIELDS);
	}
});

test("chain: the result carries the shared field set", async () => {
	const h = harness({ replies: ["alpha", "beta"] });
	const out = await runChainMode(
		[
			{ agent: "tester", task: "one" },
			{ agent: "tester", task: "two" },
		],
		h.mode,
	);

	assert.equal(out.details?.results.length, 2);
	for (const result of out.details?.results ?? []) {
		assert.deepEqual(fieldKeys(result), RESULT_FIELDS);
	}
});

test("chain: the previous reply reaches the next child", async () => {
	const h = harness({ replies: ["ALPHA-OUT", "beta"] });
	await runChainMode(
		[
			{ agent: "tester", task: "first" },
			{ agent: "tester", task: "use {previous} now" },
		],
		h.mode,
	);

	assert.equal(h.children.length, 2);
	assert.match(h.children[1].prompts[0], /ALPHA-OUT/, "the handoff text is in the next prompt");
});

test("chain: a reply past the 24 KiB cap reaches the next child cut at the cap", async () => {
	const big = "x".repeat(30 * 1024);
	const h = harness({ replies: [big, "beta"] });
	await runChainMode(
		[
			{ agent: "tester", task: "first" },
			{ agent: "tester", task: "{previous}" },
		],
		h.mode,
	);

	const prompt = h.children[1].prompts[0];
	const taskAt = prompt.indexOf("Task: ") + "Task: ".length;
	const head = prompt.slice(taskAt, taskAt + 64);
	assert.equal(head, "x".repeat(64), "the head of the reply survives");
	assert.ok(prompt.includes("[Previous output truncated"), "the cut is marked");
	assert.ok(
		Buffer.byteLength(prompt) <= 24 * 1024 + 1024,
		`the prompt is cut near the cap, not ${Buffer.byteLength(prompt)} bytes`,
	);
});

test("cancel: single mode disposes its child", async () => {
	const controller = new AbortController();
	const h = harness({ signal: controller.signal, onPrompt: () => controller.abort() });

	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.equal(out.isError, true, "a cancel is a result, not a rejection");
	assert.equal(out.details?.results[0]?.stopReason, "aborted");
	assert.equal(h.children.length, 1);
	assert.equal(h.children[0].disposed, 1, "one dispose for one child");
	assert.equal(h.children[0].aborted, 1, "the parent signal aborts the child");
	assertClosed(h.registry, ["child-0"]);
});

test("cancel: parallel mode disposes every child", async () => {
	const controller = new AbortController();
	let started = 0;
	let release = (): void => {};
	const allStarted = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness({
		signal: controller.signal,
		beforeReply: () => allStarted,
		onPrompt: () => {
			started += 1;
			if (started === 2) {
				controller.abort();
				release();
			}
		},
	});

	const out = await runParallelMode(
		[
			{ agent: "tester", task: "one" },
			{ agent: "tester", task: "two" },
		],
		h.mode,
	);
	await waitForDispose(h.children, 2);

	assert.equal(out.details?.results.length, 2, "both siblings keep their result");
	for (const result of out.details?.results ?? []) {
		assert.equal(result.stopReason, "aborted", "each child reports the cancel");
	}
	assert.equal(h.children.length, 2);
	for (const child of h.children) assert.equal(child.disposed, 1, "one dispose per child");
	assertClosed(h.registry, ["child-0", "child-1"]);
});

test("cancel: chain mode disposes the child it built", async () => {
	const controller = new AbortController();
	const h = harness({ signal: controller.signal, onPrompt: () => controller.abort() });

	const out = await runChainMode(
		[
			{ agent: "tester", task: "one" },
			{ agent: "tester", task: "two" },
		],
		h.mode,
	);

	assert.equal(out.isError, true, "the chain reports the cancelled step");
	assert.equal(out.details?.results.length, 1, "the chain stops at the cancelled step");
	assert.equal(h.children.length, 1);
	assert.equal(h.children[0].disposed, 1);
	assertClosed(h.registry, ["child-0"]);
});

test("build: a build throw returns a failure result in single mode", async () => {
	const h = harness({ failBuild: () => "factory refused" });
	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.equal(out.isError, true, "the throw becomes a result, not a rejection");
	const result = out.details?.results[0];
	assert.equal(result?.exitCode, 1);
	assert.match(result?.errorMessage ?? "", /factory refused/);
	assert.equal(h.children.length, 0, "no session exists");
	assertClosed(h.registry, ["child-0"]);
});

test("build: a parallel call keeps its sibling results when one build throws", async () => {
	const h = harness({ replies: ["beta"], failBuild: (build) => (build === 0 ? "factory refused" : null) });
	const out = await runParallelMode(
		[
			{ agent: "tester", task: "one" },
			{ agent: "tester", task: "two" },
		],
		h.mode,
	);

	const results = out.details?.results ?? [];
	assert.equal(results.length, 2, "the sibling result survives the throw");
	const failed = results.filter((result) => result.exitCode === 1).length;
	assert.deepEqual([failed, results.length - failed], [1, 1], "one build failed and one sibling completed");
	assert.match(out.content[0]?.type === "text" ? out.content[0].text : "", /1\/2 succeeded/);
});

test("guard: the loader preparation runs inside the child guard", async () => {
	const seen: boolean[] = [];
	const loader = {
		reload: async () => {
			// The reload runs the extension factory, so the guard must be set here.
			seen.push(inChildBuild());
		},
	} as unknown as ResourceLoader;

	await prepareChildRuntime("/tmp", () => loader);

	assert.deepEqual(seen, [true], "the loader reload sees the child guard");
	assert.equal(inChildBuild(), false, "the guard clears after the preparation");
});

test("single: a non-spawnable agent never builds a session", async () => {
	const h = harness({ agent: { ...AGENT, spawnable: false } as unknown as AgentConfig });
	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.equal(h.children.length, 0, "no child is built");
	assert.equal(out.isError, true);
	assert.equal(h.registry.size, 0, "no record is written");
});

test("single: an early refusal carries the run field set", async () => {
	const h = harness();
	const out = await runSingleMode("missing-agent", "do it", undefined, h.mode);
	const result = out.details?.results[0];

	assert.deepEqual(
		fieldKeys(result),
		RESULT_FIELDS.filter((key) => key !== "reasoningTokens"),
		"a refusal carries every field a run carries, except the provider-reported reasoning count",
	);
	assert.equal(result?.stopReason, "error", "a refusal reports an error stop, not a missing one");
	assert.equal(typeof result?.runStartedAt, "number", "a refusal carries a run start time");
	assert.deepEqual(result?.thinking, { thinking: false, thinkingStartedAt: null, thinkingMs: 0 });
});

test("dispatch: every active child tool carries a wrapper", async () => {
	const h = harness({ replies: ["alpha"] });
	await runSingleMode("tester", "do it", undefined, h.mode);

	const built = h.children[0].options;
	const wrapped = new Set((built.customTools ?? []).map((tool) => tool.name));
	assert.deepEqual(built.tools, ["read", "write"], "the allowlist is the planned loadout");
	for (const name of built.tools ?? []) {
		assert.ok(wrapped.has(name), `${name} is active in the child, so it must carry a wrapper`);
	}
	assert.equal(wrapped.size, built.tools?.length, "one wrapper per active tool");
});

test("dispatch: a wildcard loadout is refused and names the entry", async () => {
	const h = harness({ agent: { ...AGENT, tools: ["read", "*", "read?"] } as unknown as AgentConfig });
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const text = out.content[0]?.type === "text" ? out.content[0].text : "";

	assert.equal(out.isError, true, "the refusal is a failed result");
	assert.match(text, /"\*"/, "the refusal names the star entry");
	assert.match(text, /"read\?"/, "the refusal names the question-mark entry");
	assert.equal(h.children.length, 0, "no session is built for a wildcard loadout");
	assert.equal(h.registry.size, 0, "no record is written, so no wildcard tool can be gated as a child");
});

test("dispatch: a null parent session id never builds a session and never takes the root role", async () => {
	const h = harness({ parentSessionId: null });
	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.equal(out.isError, true, "a dispatch with no parent id is a failed result");
	assert.match(out.details?.results[0]?.stderr ?? "", /parent session id/, "the refusal names the cause");
	assert.equal(h.children.length, 0, "no session is built");
	assert.equal(h.registry.size, 0, "no record is written, so the walk cannot report depth 0");
});

test("dispatch: a named in-process tool is wrapped and runs after the gate allows", async () => {
	const calls: string[] = [];
	registerChildTool({
		name: "todo",
		label: "Todo",
		description: "fixture",
		parameters: {} as never,
		execute: async () => {
			calls.push("todo");
			return { content: [{ type: "text" as const, text: "todo ran" }], details: undefined };
		},
	});
	bindParentGate(async () => undefined);
	const h = harness({ agent: { ...AGENT, tools: ["read", "todo"] } as unknown as AgentConfig });
	await runSingleMode("tester", "do it", undefined, h.mode);

	const wrapper = h.children[0]?.options.customTools?.find((tool) => tool.name === "todo");
	assert.ok(wrapper, "the child carries a todo wrapper");
	const out = await wrapper.execute("call-1", {}, undefined, undefined, {} as never);
	assert.equal(calls.length, 1, "the wrapped todo ran after the allow");
	assert.notEqual(out.isError, true, "the wrapped call is not an error");
});

test("registry: a session shutdown finishes the root record only", () => {
	const start = {
		role: "orchestrator",
		class: "orchestrator" as const,
		source: "package" as const,
		skills: [],
		alwaysLoad: [],
		sessionFile: null,
		startedAt: 0,
	};
	const registry = new RunRegistry();
	registry.register(newRunRecord({ ...start, sessionId: "root-session", depth: 0, parentSessionId: null }));
	registry.register(newRunRecord({ ...start, sessionId: "child-0", depth: 1, parentSessionId: "root-session" }));
	// A running record never qualifies for the sweep, so the root is stuck until now.
	assert.equal(registry.sweepable(RUN_RETENTION_MS * 2).length, 0, "a running root is never swept");

	assert.equal(finishRootSession(registry, "root-session", 5000), true, "the root record closes");
	assert.equal(registry.get("root-session")?.status, "done", "the root is marked done");
	assert.equal(registry.get("root-session")?.endedAt, 5000, "the root carries an exit time");
	assert.deepEqual(
		registry.sweepable(5000 + RUN_RETENTION_MS + 1).map((record) => record.sessionId),
		["root-session"],
		"the closed root becomes sweepable",
	);

	assert.equal(finishRootSession(registry, "child-0", 5000), false, "the builder owns the child exit mark");
	assert.equal(registry.get("child-0")?.status, "running", "the child record stays open");
	assert.equal(finishRootSession(registry, "absent", 5000), false, "an absent id closes nothing");
});

test("depth: a level-2 caller is refused with the cap text and builds nothing", async () => {
	const start = {
		role: "orchestrator",
		class: "orchestrator" as const,
		source: "package" as const,
		skills: [],
		alwaysLoad: [],
		sessionFile: null,
		startedAt: 0,
	};
	const h = harness();
	// Two hops above the caller put it at level 2, where the cap forbids a spawn.
	h.registry.register(newRunRecord({ ...start, sessionId: "level-0", depth: 0, parentSessionId: null }));
	h.registry.register(newRunRecord({ ...start, sessionId: "level-1", depth: 1, parentSessionId: "level-0" }));
	h.registry.register(newRunRecord({ ...start, sessionId: "root-session", depth: 2, parentSessionId: "level-1" }));
	const before = h.registry.size;

	const out = await runSingleMode("tester", "do it", undefined, h.mode);

	assert.equal(out.isError, true, "the cap refusal is a failed result");
	assert.match(
		out.details?.results[0]?.stderr ?? "",
		/Depth cap reached \(level 2\)/,
		"the refusal names the level",
	);
	assert.equal(h.children.length, 0, "no session is built at the cap");
	assert.equal(h.registry.size, before, "the registry gained no record");
});

test("depth: the child depth comes from the registry walk, not the process", async () => {
	const start = {
		role: "orchestrator",
		class: "orchestrator" as const,
		source: "package" as const,
		skills: [],
		alwaysLoad: [],
		sessionFile: null,
		startedAt: 0,
	};
	// The factory registers this definition; the case supplies it the same way.
	registerChildTool({
		name: "subagent",
		label: "Subagent",
		description: "fixture",
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "spawned" }], details: undefined }),
	});

	// A root caller: the spawn tool stays in the child loadout.
	const shallow = harness({ agent: { ...AGENT, tools: ["read", "subagent"] } as unknown as AgentConfig });
	shallow.registry.register(newRunRecord({ ...start, sessionId: "root-session", depth: 0, parentSessionId: null }));
	const rootRun = await runSingleMode("tester", "do it", undefined, shallow.mode);
	assert.notEqual(rootRun.isError, true, "the root caller may spawn");
	assert.deepEqual(
		shallow.children[0]?.options.tools,
		["read", "subagent"],
		"a depth-0 caller keeps the spawn tool, whatever depth this process started at",
	);

	// A level-1 caller: it spawns a depth-2 child, which loses the spawn tool.
	const deep = harness({ agent: { ...AGENT, tools: ["read", "subagent"] } as unknown as AgentConfig });
	deep.registry.register(newRunRecord({ ...start, sessionId: "grand-root", depth: 0, parentSessionId: null }));
	deep.registry.register(newRunRecord({ ...start, sessionId: "root-session", depth: 1, parentSessionId: "grand-root" }));
	const childRun = await runSingleMode("tester", "do it", undefined, deep.mode);
	assert.notEqual(childRun.isError, true, "a level-1 child may spawn a depth-2 child");
	assert.deepEqual(deep.children[0]?.options.tools, ["read"], "the depth-2 loadout loses the spawn tool");
});
