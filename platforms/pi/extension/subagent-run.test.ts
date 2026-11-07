/**
 * Subagent runner tests: the turn count, the exit, and the parent abort.
 *
 * Every child is fake. A fake child emits assistant turns in a loop, so the
 * runner path runs without a model call.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { bindParentGate, clearChildToolImplementations } from "./child-tools.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import type { AgentConfig } from "./resolver.ts";
import { RunRegistry } from "./run-registry.ts";
import { foldEvent } from "./subagent-fold.ts";
import type { SingleResult, SubagentDetails } from "./subagent-result.ts";
import { type DispatchDeps, type PreparedChildRuntime } from "./subagent-run.ts";
import { SESSION_ROUND_CAP, sessionStoreDir, writeSidecar } from "./session-store.ts";
import { type ModeRun, runSingleMode } from "./subagent.ts";
import { readAllEvents } from "./tree-log.ts";

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

/** One fake child: its prompts, its steers, its aborts, and its exits. */
interface Child {
	session: AgentSession;
	prompts: string[];
	steers: string[];
	aborts: number;
	disposed: number;
	emitted: number;
}

interface HarnessOptions {
	/** The most assistant turns the fake emits before it stops on its own. */
	emitLimit?: number;
	/** Runs after each emitted turn, so a test can fire the parent signal mid-run. */
	onTurn?: (turn: number) => void;
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
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 }, totalTokens: 11 },
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

/** A harness with one registry, one fake agent, and one fake session per build. */
function harness(options: HarnessOptions = {}): Harness {
	const children: Child[] = [];
	const registry = new RunRegistry();
	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope: "user",
			projectAgentsDir: null,
			results,
		});

	const prepare = async (): Promise<PreparedChildRuntime> => {
		const id = `child-${children.length}`;
		const sessionManager = {
			getSessionId: () => id,
			getSessionFile: () => undefined,
		} as unknown as SessionManager;
		return { sessionManager, loader: {} as ResourceLoader, settingsManager: fakeSettings() };
	};

	const createSession = async (_options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const emittedLimit = options.emitLimit ?? 50;
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const child: Child = {
			session: null as unknown as AgentSession,
			prompts: [],
			steers: [],
			aborts: 0,
			disposed: 0,
			emitted: 0,
		};
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async (text: string) => {
				child.prompts.push(text);
				for (let i = 0; i < emittedLimit; i++) {
					child.emitted += 1;
					const message = assistantMessage(`turn ${child.emitted}`);
					for (const listener of listeners) listener({ type: "message_end", message });
					options.onTurn?.(child.emitted);
				}
			},
			steer: async (text: string) => {
				child.steers.push(text);
				return "handled" as const;
			},
			abort: async () => {
				child.aborts += 1;
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
		agents: [AGENT],
		resolveTarget: (name: string) => (name === AGENT.name ? { agent: AGENT } : null),
		resolveSpawnPersona: () => null,
		runtime: { registry, parentSessionId: "root-session", createSession, prepare },
	};

	const mode: ModeRun = { deps, signal: undefined, onUpdate: undefined, makeDetails };
	return { deps, children, registry, mode };
}

/** A clean result with no messages, so a fold test starts empty. */
function emptyResult(): SingleResult {
	return {
		agent: "tester",
		agentSource: "user",
		task: "do it",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		session: null,
		resumed: false,
		round: 1,
	};
}

/** Fold one assistant message end and return the result. */
function foldAssistant(stopReason: string, errorMessage: string): SingleResult {
	const result = emptyResult();
	const message = { role: "assistant", content: [], stopReason, errorMessage } as unknown as Message;
	foldEvent({ type: "message_end", message }, result, () => {}, () => {}, () => {});
	return result;
}

/** Run one single-mode call. */
async function run(h: Harness): Promise<SingleResult> {
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const result = out.details?.results[0];
	assert.ok(result, "the mode returned a result");
	return result;
}

/** A unique tree log path per test, so one test reads only its own events. */
function treeLogPath(): string {
	return join(tmpdir(), `pi-run-tree-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
}

/** A sidecar whose next round the cap refuses. */
function cappedAgentDir(agent: string, id: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-run-store-"));
	writeSidecar(agentDir, id, {
		agent,
		class: "worker",
		rounds: SESSION_ROUND_CAP,
		turns: 3,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		parentSession: "root-session",
		cwd: "/tmp/subagent-work",
	});
	return agentDir;
}

/** A store with one saved round and a matching header, so the next round resumes. */
function resumedAgentDir(agent: string, id: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-run-store-"));
	writeSidecar(agentDir, id, {
		agent,
		class: "worker",
		rounds: 1,
		turns: 3,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		parentSession: "root-session",
		cwd: "/tmp/subagent-work",
	});
	const storeDir = sessionStoreDir(agentDir);
	mkdirSync(storeDir, { recursive: true });
	const header = { type: "session", version: 3, id, cwd: "/tmp/subagent-work" };
	writeFileSync(join(storeDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify(header)}\n`, "utf8");
	return agentDir;
}

test("run: a child runs to its own end, and the turn count equals the registry record", async () => {
	const h = harness({ emitLimit: 200 });
	const result = await run(h);
	const child = h.children[0];

	assert.equal(child.steers.length, 0, "no steer is sent");
	assert.equal(child.aborts, 0, "no abort is sent");
	assert.equal(result.usage.turns, 200, "the run counts every assistant turn");
	assert.equal(h.registry.get("child-0")?.turns, 200, "the record count equals the result count");
	assert.equal(result.messages.at(-1)?.role, "assistant", "the final message is kept");
	assert.equal(result.exitCode, 0, "the run exits clean");
	assert.equal(child.disposed, 1, "the child is disposed once");
});

test("run: a parent abort keeps its error text on the tool result and the tree end event", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const controller = new AbortController();
		const h = harness({ emitLimit: 3, onTurn: () => controller.abort() });
		h.mode.signal = controller.signal;
		const out = await runSingleMode("tester", "do it", undefined, h.mode);
		const result = out.details?.results[0];
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		const end = readAllEvents(logPath).find((event) => event.type === "end");

		assert.ok(result);
		assert.equal(result.stopReason, "aborted", "the abort sets the stop reason");
		assert.equal(result.exitCode, 1, "an aborted run exits non-zero");
		assert.ok(result.errorMessage, "the run carries one error text");
		assert.ok(text.includes(result.errorMessage), "the tool result keeps the error text");
		assert.equal(end?.outputPreview, result.errorMessage, "the tree preview keeps the error text");
		assert.equal(end?.error, result.errorMessage, "the tree end event keeps the error text");
		assert.doesNotMatch(text, /capped/, "the tool result carries no cap line");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
	}
});

test("run: a refused third round writes no start record", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	const agentDir = cappedAgentDir(AGENT.name, "tester-cap");
	try {
		const h = harness();
		h.deps.runtime.agentDir = agentDir;
		const out = await runSingleMode(AGENT.name, "do it", "/tmp/subagent-work", h.mode, "tester-cap");
		const result = out.details?.results[0];

		assert.ok(result, "a refused run still returns a result");
		assert.equal(result.round, 3, "the refusal names the round it refused");
		assert.match(result.stderr, /round cap reached/, "the refusal text is the store reason");
		assert.equal(h.children.length, 0, "no child session is built");
		assert.deepEqual(readAllEvents(logPath), [], "a refused run leaves no tree record");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("run: a resumed plan writes its round and the resume flag on the first record", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	const agentDir = resumedAgentDir(AGENT.name, "tester-resume");
	try {
		const h = harness();
		h.deps.runtime.agentDir = agentDir;
		const out = await runSingleMode(AGENT.name, "do it", "/tmp/subagent-work", h.mode, "tester-resume");
		const result = out.details?.results[0];
		const first = readAllEvents(logPath)[0];

		assert.ok(result, "the resumed run returns a result");
		assert.equal(result.round, 2, "the plan resumes at round 2");
		assert.equal(result.resumed, true, "the result carries the resume flag");
		assert.equal(first?.type, "start", "the first record is the start event");
		assert.equal(first?.round, 2, "the start record carries the plan round");
		assert.equal(first?.resumed, true, "the start record carries the resume flag");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("fold: an error message is kept only on an error or aborted stop", () => {
	assert.equal(foldAssistant("end", "a stray message").errorMessage, undefined, "a clean stop keeps no error text");
	assert.equal(foldAssistant("error", "the provider failed").errorMessage, "the provider failed", "an error stop keeps its text");
	assert.equal(foldAssistant("aborted", "the caller stopped it").errorMessage, "the caller stopped it", "an abort keeps its text");
});
