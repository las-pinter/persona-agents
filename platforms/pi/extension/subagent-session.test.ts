/**
 * Session-store wiring tests for single mode.
 *
 * Every test uses a temporary agent directory, never the real one. A fake child
 * appends its messages to the real planned SessionManager, so the store file and
 * the sidecar are driven end to end.
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
	AgentSessionEvent,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionAPI,
	ExtensionContext,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildModel } from "./child-session.ts";
import { bindParentGate, clearChildToolImplementations } from "./child-tools.ts";
import type { AgentConfig } from "./resolver.ts";
import { RUN_RETENTION_MS, RunRegistry, newRunRecord } from "./run-registry.ts";
import {
	type SidecarRecord,
	ROUND_CAP_REASON,
	findSessionFile,
	readSidecar,
	sessionStoreDir,
	writeSidecar,
} from "./session-store.ts";
import type { SingleResult, SubagentDetails } from "./subagent-result.ts";
import type { DispatchDeps, PreparedChildRuntime } from "./subagent-run.ts";
import subagentExtension, {
	type ModeRun,
	SESSION_SINGLE_MODE_REASON,
	runSingleMode,
	sessionParamOf,
} from "./subagent.ts";

const AGENT = {
	name: "implementer",
	source: "user",
	tools: ["read", "write"],
	permissionClass: "worker",
	spawnable: true,
} as unknown as AgentConfig;

const PARENT = "root-session";
const ID = "implementer-auth-fix";
const WORK = "/tmp/subagent-session-work";

const roots: string[] = [];

/** A throw-away directory. Removed after the file finishes. */
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-session-"));
	roots.push(dir);
	return dir;
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	bindParentGate(null);
	clearChildToolImplementations();
});

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() } as unknown as Message;
}

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 }, totalTokens: 11 },
		stopReason: "end",
		model: "fake/model",
	} as unknown as Message;
}

function fakeSettings(): SettingsManager {
	return {
		getImageAutoResize: () => true,
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
	} as unknown as SettingsManager;
}

interface Child {
	prompts: string[];
	disposed: number;
}

interface HarnessOptions {
	agentDir: string;
	/** False makes the child append no message, so the round writes no file. */
	emit?: boolean;
}

interface Harness {
	deps: DispatchDeps;
	children: Child[];
	registry: RunRegistry;
	mode: ModeRun;
}

/** One registry, one agent, and one fake child per build. */
function harness(options: HarnessOptions): Harness {
	const children: Child[] = [];
	const registry = new RunRegistry();
	// A live process holds its caller record, so the harness registers the root.
	registry.register(
		newRunRecord({
			sessionId: PARENT,
			role: "orchestrator",
			class: "orchestrator",
			source: "package",
			skills: [],
			alwaysLoad: [],
			depth: 0,
			parentSessionId: null,
			sessionFile: null,
			startedAt: 0,
		}),
	);
	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope: "user",
			projectAgentsDir: null,
			results,
		});

	const prepare = async (): Promise<PreparedChildRuntime> => {
		const sessionManager = {
			getSessionId: () => `child-${children.length}`,
			getSessionFile: () => undefined,
			appendMessage: () => {},
		} as unknown as SessionManager;
		return { sessionManager, loader: {} as ResourceLoader, settingsManager: fakeSettings() };
	};

	const createSession = async (buildOptions?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const child: Child = { prompts: [], disposed: 0 };
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async (text: string) => {
				child.prompts.push(text);
				if (options.emit === false) return;
				const user = userMessage(text);
				buildOptions?.sessionManager?.appendMessage(user);
				const reply = assistantMessage("done");
				buildOptions?.sessionManager?.appendMessage(reply);
				for (const listener of listeners) listener({ type: "message_end", message: user });
				for (const listener of listeners) listener({ type: "message_end", message: reply });
			},
			abort: async () => {},
			dispose: () => {
				child.disposed += 1;
			},
		};
		children.push(child);
		return { session: session as unknown as AgentSession, extensionsResult: {} } as unknown as CreateAgentSessionResult;
	};

	const deps: DispatchDeps = {
		defaultCwd: WORK,
		defaults: {
			model: "fake/model",
			modelObject: { id: "fake-model" } as ChildModel,
			thinkingLevel: "medium",
		},
		agents: [AGENT],
		resolveTarget: (name: string) => (name === AGENT.name ? { agent: AGENT } : null),
		resolveSpawnPersona: () => null,
		runtime: {
			registry,
			parentSessionId: PARENT,
			createSession,
			prepare,
			agentDir: options.agentDir,
		},
	};

	const mode: ModeRun = { deps, signal: undefined, onUpdate: undefined, makeDetails };
	return { deps, children, registry, mode };
}

function resultOf(out: Awaited<ReturnType<typeof runSingleMode>>): SingleResult {
	const result = out.details?.results[0];
	assert.ok(result, "the run returned a result");
	return result;
}

function run(h: Harness, id?: string): Promise<Awaited<ReturnType<typeof runSingleMode>>> {
	return runSingleMode(AGENT.name, "do it", undefined, h.mode, id);
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}

interface CapturedTool {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
}

/** Capture the registered subagent tool. */
function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool: (tool: CapturedTool) => {
			captured = tool;
		},
	};
	subagentExtension(pi as unknown as ExtensionAPI);
	if (!captured) throw new Error("the extension registered no tool");
	return captured;
}

function textOf(out: ToolResult): string {
	return out.content.map((part) => part.text ?? "").join("\n");
}

// --- a cold round persists the file and the round sidecar ---------------------

test("session: a cold single run persists the store file and the round sidecar", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir });

	const result = resultOf(await run(h, ID));

	assert.equal(result.session, ID);
	assert.equal(result.resumed, false);
	assert.equal(result.round, 1);
	assert.equal(h.children.length, 1);

	const names = fs.readdirSync(sessionStoreDir(agentDir));
	const saved = names.filter((name) => name.endsWith(`_${ID}.jsonl`));
	assert.equal(saved.length, 1, "the store holds one session file whose name carries the id");
	assert.equal(findSessionFile(agentDir, ID)?.path, path.join(sessionStoreDir(agentDir), saved[0]));

	const sidecar = readSidecar(agentDir, ID);
	assert.equal(sidecar?.agent, AGENT.name);
	assert.equal(sidecar?.class, "worker");
	assert.equal(sidecar?.rounds, 1);
	assert.equal(sidecar?.turns, 1);
	assert.equal(sidecar?.parentSession, PARENT);
});

// --- round 2 resumes, round 3 refuses before a child --------------------------

test("session: round 2 resumes and round 3 refuses with the cap reason", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir });

	await run(h, ID);
	const second = resultOf(await run(h, ID));
	assert.equal(second.resumed, true);
	assert.equal(second.round, 2);
	assert.equal(readSidecar(agentDir, ID)?.rounds, 2);

	const built = h.children.length;
	const third = await run(h, ID);
	const refused = resultOf(third);

	assert.equal(third.isError, true, "the cap is a failed run");
	assert.equal(refused.exitCode, 1);
	assert.equal(refused.stderr, ROUND_CAP_REASON);
	assert.equal(h.children.length, built, "the cap refuses before a child is built");
});

// --- a stale sidecar starts a cold round and saves a new file -----------------

test("session: a stale saved session starts a cold round 2 and saves a new file", async () => {
	const agentDir = tempDir();
	const now = Date.now();
	const aged = new Date(now - RUN_RETENTION_MS - 6 * 60 * 60 * 1000);
	const oldFile = path.join(sessionStoreDir(agentDir), `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
	fs.mkdirSync(sessionStoreDir(agentDir), { recursive: true });
	const header = { type: "session", version: 3, id: ID, timestamp: aged.toISOString(), cwd: WORK };
	fs.writeFileSync(oldFile, `${JSON.stringify(header)}\n`, "utf8");
	fs.utimesSync(oldFile, aged, aged);
	const record: SidecarRecord = {
		agent: AGENT.name,
		class: "worker",
		rounds: 1,
		turns: 1,
		createdAt: aged.getTime(),
		updatedAt: aged.getTime(),
		parentSession: PARENT,
		cwd: WORK,
	};
	writeSidecar(agentDir, ID, record);
	const h = harness({ agentDir });

	const result = resultOf(await run(h, ID));

	assert.equal(result.session, ID);
	assert.equal(result.resumed, false, "a stale file is not reopened");
	assert.equal(result.round, 2, "the sidecar round counter still advances");
	assert.match(result.stderr, /^stale session/, "the cold note names the stale reason, not the missing one");
	const names = fs.readdirSync(sessionStoreDir(agentDir)).filter((name) => name.endsWith(".jsonl"));
	const fresh = names.filter((name) => path.join(sessionStoreDir(agentDir), name) !== oldFile);
	assert.equal(fresh.length, 1, "the cold round saved a new file whose name carries the id");
});

// --- chain and tasks refuse a session; no session stays in memory ------------

test("session: a chain or tasks call that carries a session is refused", async () => {
	const tool = captureTool();
	const ctx = {
		cwd: tempDir(),
		hasUI: false,
		sessionManager: { getSessionId: () => PARENT },
	} as unknown as ExtensionContext;

	const chain = await tool.execute(
		"call-1",
		{ chain: [{ agent: AGENT.name, task: "one" }], session: ID },
		undefined,
		undefined,
		ctx,
	);
	const tasks = await tool.execute(
		"call-2",
		{ tasks: [{ agent: AGENT.name, task: "one" }], session: ID },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(textOf(chain), SESSION_SINGLE_MODE_REASON);
	assert.equal(textOf(tasks), SESSION_SINGLE_MODE_REASON);
});

test("session: a single call without a session stays in memory", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir });

	const result = resultOf(await run(h));

	assert.equal(result.exitCode, 0, "the round finished in memory with no store");
	assert.equal(result.session, null, "no session id was recorded");
	assert.equal(result.resumed, false, "nothing was resumed");
	assert.equal(result.round, 1);
	assert.equal(h.children.length, 1);
	assert.equal(fs.existsSync(sessionStoreDir(agentDir)), false, "a no-session round touches no store");
});

test("session: a single call with an empty session string runs in memory with no store", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir });

	const session = sessionParamOf({ session: "" });
	const result = resultOf(await run(h, session));

	assert.equal(session, undefined, "an empty id normalizes to no id");
	assert.equal(result.session, null);
	assert.equal(result.exitCode, 0, "the round finished in memory with no store");
	assert.equal(result.resumed, false);
	assert.equal(result.round, 1);
	assert.equal(h.children.length, 1);
	assert.equal(fs.existsSync(sessionStoreDir(agentDir)), false, "an empty id touches no store");
});

// --- bad id and foreign agent refuse with the plan message -------------------

test("session: a bad id refuses with the plan message and builds no child", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir });

	const out = await run(h, "implementer-Bad");
	const result = resultOf(out);

	assert.equal(out.isError, true);
	assert.match(result.stderr, /bad-id/);
	assert.match(result.stderr, /implementer-/);
	assert.equal(h.children.length, 0, "the id guard refuses before a child is built");
	assert.equal(fs.existsSync(sessionStoreDir(agentDir)), false, "a refused id touches no disk");
});

test("session: a foreign-agent sidecar refuses and names both agents", async () => {
	const agentDir = tempDir();
	const id = "implementer-foreign";
	fs.mkdirSync(sessionStoreDir(agentDir), { recursive: true });
	const now = Date.now();
	const record: SidecarRecord = {
		agent: "reviewer",
		class: "reader",
		rounds: 1,
		turns: 1,
		createdAt: now - 1000,
		updatedAt: now - 1000,
		parentSession: PARENT,
		cwd: WORK,
	};
	writeSidecar(agentDir, id, record);
	const h = harness({ agentDir });

	const out = await run(h, id);
	const result = resultOf(out);

	assert.equal(out.isError, true);
	assert.match(result.stderr, /belongs to agent "reviewer"/);
	assert.match(result.stderr, /"implementer"/);
	assert.equal(h.children.length, 0, "the foreign refusal builds no child");
});

// --- no message, no file, no sidecar -----------------------------------------

test("session: a round that appends no message leaves no file and no sidecar", async () => {
	const agentDir = tempDir();
	const h = harness({ agentDir, emit: false });

	const result = resultOf(await run(h, ID));

	assert.equal(result.session, ID);
	assert.equal(h.children.length, 1);
	assert.equal(findSessionFile(agentDir, ID), null, "no message leaves no saved session");
	assert.equal(readSidecar(agentDir, ID), null, "no message leaves no sidecar");
});
