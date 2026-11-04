/**
 * Turn cap tests: the range, the one steer, the grace window, and the result.
 *
 * Every child is fake. A fake child emits assistant turns in a loop and stops
 * when the runner aborts it, so the cap path runs without a model call.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
import { renderNodeDetail } from "./sidebar-render.ts";
import { theme } from "./sidebar-render-fixtures.ts";
import type { SingleResult, SubagentDetails } from "./subagent-result.ts";
import { type DispatchDeps, type PreparedChildRuntime } from "./subagent-run.ts";
import { type ModeRun, runChainMode, runSingleMode } from "./subagent.ts";
import { MAX_MAX_TURNS, MIN_MAX_TURNS, TURN_GRACE } from "./turn-cap.ts";
import { assembleTree, findNode } from "./tree-model.ts";
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
	/** The turn count at the moment the runner aborted the child. */
	turnsAtAbort: number | null;
	/** The turn count at the moment the child took the steer. */
	turnsAtSteer: number | null;
}

interface HarnessOptions {
	/** The most assistant turns the fake emits before it stops on its own. */
	emitLimit?: number;
	/** The assistant turns the fake emits after it takes the steer, then it stops on its own. */
	stopAfterSteerTurns?: number;
	/** Makes the prompt throw once the runner aborts, as a real aborted session does. */
	abortThrows?: boolean;
	/** The abort text the prompt throws. Defaults to the repo abort text. */
	abortMessage?: string;
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
			turnsAtAbort: null,
			turnsAtSteer: null,
		};
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			prompt: async (text: string) => {
				child.prompts.push(text);
				// A capped child keeps going until the runner aborts it.
				for (let i = 0; i < emittedLimit && child.aborts === 0; i++) {
					// A child that wraps up after the steer ends the run on its own.
					if (
						options.stopAfterSteerTurns !== undefined &&
						child.turnsAtSteer !== null &&
						child.emitted >= child.turnsAtSteer + options.stopAfterSteerTurns
					) {
						break;
					}
					child.emitted += 1;
					const message = assistantMessage(`turn ${child.emitted}`);
					for (const listener of listeners) listener({ type: "message_end", message });
				}
				if (options.abortThrows && child.aborts > 0)
					throw new Error(options.abortMessage ?? "Subagent was aborted");
			},
			steer: async (text: string) => {
				child.steers.push(text);
				child.turnsAtSteer ??= child.emitted;
				return "handled" as const;
			},
			abort: async () => {
				child.aborts += 1;
				child.turnsAtAbort = child.emitted;
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

/** Run one single-mode call with an optional cap. */
async function run(h: Harness, maxTurns?: number): Promise<SingleResult> {
	h.mode.maxTurns = maxTurns;
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const result = out.details?.results[0];
	assert.ok(result, "the mode returned a result");
	return result;
}

/** A unique tree log path per test, so one test reads only its own events. */
function treeLogPath(): string {
	return join(tmpdir(), `pi-cap-tree-${process.pid}-${Math.random().toString(36).slice(2)}.ndjson`);
}

test("cap: a call with no maxTurns uses the default and stays uncapped below it", async () => {
	const h = harness({ emitLimit: 3 });
	const result = await run(h);

	assert.equal(result.maxTurns, 40, "the default cap is the literal 40");
	assert.equal(result.usage.turns, 3, "three assistant turns were counted");
	assert.equal(result.turnsCapped, false, "a run below the cap is not capped");
	assert.equal(h.children[0].steers.length, 0, "no steer is sent below the cap");
	assert.equal(h.children[0].aborts, 0, "no abort is sent below the cap");
});

test("cap: a value outside the range is refused before the build, and the ends are accepted", async () => {
	for (const bad of [0, MAX_MAX_TURNS + 1]) {
		const h = harness({ emitLimit: 1 });
		h.mode.maxTurns = bad;
		const out = await runSingleMode("tester", "do it", undefined, h.mode);
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		const refused = out.details?.results[0];

		assert.equal(h.children.length, 0, `maxTurns ${bad} builds no session`);
		assert.equal(h.registry.size, 0, `maxTurns ${bad} writes no record`);
		assert.equal(refused?.stopReason, "error", `maxTurns ${bad} refuses as an error`);
		assert.match(text, new RegExp(`${MIN_MAX_TURNS} to ${MAX_MAX_TURNS}`), "the refusal names the range");
	}

	for (const good of [MIN_MAX_TURNS, MAX_MAX_TURNS]) {
		const h = harness({ emitLimit: 1 });
		const result = await run(h, good);

		assert.equal(h.children.length, 1, `maxTurns ${good} builds one session`);
		assert.equal(result.maxTurns, good, `maxTurns ${good} is the cap in force`);
	}
});

test("cap: one steer, then five grace turns, then one abort", async () => {
	const cap = 2;
	const h = harness();
	const result = await run(h, cap);
	const child = h.children[0];

	assert.equal(child.steers.length, 1, "exactly one steer message");
	assert.equal(child.aborts, 1, "exactly one abort");
	assert.equal(child.turnsAtAbort, cap + TURN_GRACE + 1, "the abort lands on the turn after the grace window");
	assert.equal(child.turnsAtAbort, 8, "the small cap aborts on turn 8");
	assert.equal(result.usage.turns, child.turnsAtAbort, "the run stops on that turn");
});

test("cap: the six capped fields hold, the registry agrees, and the caller reads the line", async () => {
	const cap = 3;
	const h = harness();
	h.mode.maxTurns = cap;
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const result = out.details?.results[0];
	const child = h.children[0];
	const text = out.content[0]?.type === "text" ? out.content[0].text : "";

	assert.ok(result);
	assert.equal(result.usage.turns, cap + TURN_GRACE + 1, "turns is the count at the abort");
	assert.equal(result.maxTurns, cap, "maxTurns is the call value");
	assert.equal(result.turnsCapped, true, "the run is capped");
	assert.equal(result.stopReason, "aborted", "the cap aborts the run");
	assert.equal(result.exitCode, 1, "a capped run exits non-zero");
	assert.equal(result.messages.at(-1)?.role, "assistant", "the final text is kept");
	assert.match(text, new RegExp(`^turns ${cap + TURN_GRACE + 1}/${cap} \\(capped, ${TURN_GRACE} grace\\) - partial output follows`));
	assert.ok(text.includes(`turn ${cap + TURN_GRACE + 1}`), "the partial output follows the line");
	assert.equal(h.registry.get("child-0")?.turns, result.usage.turns, "the record count equals the result count");
	assert.equal(child.disposed, 1, "the child is disposed once");

	// The caller keeps the partial text, so the tool result is not empty.
	assert.equal(out.isError, true, "a capped run reports a failed tool result");
});

test("cap: a capped chain step shows its partial text, not the abort error", async () => {
	const cap = 2;
	const h = harness({ abortThrows: true });
	h.mode.maxTurns = cap;
	const out = await runChainMode([{ agent: "tester", task: "do it" }], h.mode);
	const text = out.content[0]?.type === "text" ? out.content[0].text : "";
	const result = out.details?.results[0];

	assert.ok(result);
	assert.equal(result.turnsCapped, true, "the step is capped");
	assert.match(result.errorMessage ?? "", /Subagent was aborted/, "the abort error text exists on the result");
	assert.ok(text.includes("partial output follows"), "the cap line promises the partial text");
	assert.ok(text.includes(`turn ${cap + TURN_GRACE + 1}`), "the partial text follows the cap line");
	assert.ok(!text.includes("Subagent was aborted"), "the abort error text is not shown");
});

test("cap: a capped single run keeps the abort error off the tool result text", async () => {
	const cap = 2;
	const h = harness({ abortThrows: true });
	h.mode.maxTurns = cap;
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const result = out.details?.results[0];
	const text = out.content[0]?.type === "text" ? out.content[0].text : "";

	assert.ok(result);
	assert.equal(result.turnsCapped, true, "the run is capped");
	assert.match(result.errorMessage ?? "", /Subagent was aborted/, "the abort error text exists on the result");
	assert.ok(text.includes("partial output follows"), "the cap line promises the partial text");
	assert.ok(text.includes(`turn ${cap + TURN_GRACE + 1}`), "the partial text follows the cap line");
	assert.ok(!text.includes("Subagent was aborted"), "the abort error text is not shown");
});

test("cap: a provider abort text stays off the run text and the tree error", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const cap = 2;
		const h = harness({ abortThrows: true, abortMessage: "Request was aborted" });
		h.mode.maxTurns = cap;
		const out = await runSingleMode("tester", "do it", undefined, h.mode);
		const result = out.details?.results[0];
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		const end = readAllEvents(logPath).find((event) => event.type === "end");

		assert.ok(result);
		assert.equal(result.turnsCapped, true, "the run is capped");
		assert.equal(result.errorMessage, "Request was aborted", "the provider text lands on the result");
		assert.ok(text.includes("partial output follows"), "the cap line shows");
		assert.ok(!text.includes("Error:"), "no error line shows");
		assert.ok(!text.includes("Request was aborted"), "the provider abort text is not shown");
		assert.equal(end?.error, null, "the tree end event carries no error");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
	}
});

test("cap: the tree end preview holds the capped partial text, not the abort error", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const cap = 2;
		const h = harness({ abortThrows: true });
		h.mode.maxTurns = cap;
		await runSingleMode("tester", "do it", undefined, h.mode);
		const end = readAllEvents(logPath).find((event) => event.type === "end");

		assert.ok(end, "the run wrote one end event");
		assert.equal(
			end.outputPreview,
			`turns ${cap + TURN_GRACE + 1}/${cap} (capped, ${TURN_GRACE} grace) - partial output follows\n\nturn ${cap + TURN_GRACE + 1}`,
			"the preview is the whole run text: the cap line then the partial text",
		);
		assert.equal(end.error, null, "the end event carries no abort error text");

		const node = findNode(assembleTree(readAllEvents(logPath), Date.parse(end.at) + 1, 60_000), end.runId);
		assert.ok(node, "the tree holds the capped run");
		assert.equal(node.error, null, "the node copies no abort error text");
		const detail = renderNodeDetail(node, 80, theme).join("\n");
		assert.ok(!detail.includes("Subagent was aborted"), "the sidebar detail shows no abort error text");
		assert.ok(detail.includes(`turn ${cap + TURN_GRACE + 1}`), "the sidebar detail shows the partial preview");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
	}
});

test("cap: an abort below the cap keeps its error text on the tool result and the tree", async () => {
	const logPath = treeLogPath();
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const controller = new AbortController();
		controller.abort();
		const h = harness({ emitLimit: 1 });
		h.mode.maxTurns = 5;
		h.mode.signal = controller.signal;
		const out = await runSingleMode("tester", "do it", undefined, h.mode);
		const result = out.details?.results[0];
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		const end = readAllEvents(logPath).find((event) => event.type === "end");

		assert.ok(result);
		assert.equal(result.turnsCapped, false, "the run ended below the cap");
		assert.ok(result.errorMessage, "the run carries one error text");
		assert.ok(text.includes(result.errorMessage), "the tool result keeps the error text");
		assert.equal(end?.outputPreview, result.errorMessage, "the tree preview keeps the error text");
		assert.equal(end?.error, result.errorMessage, "the tree end event keeps the error text");
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		rmSync(logPath, { force: true });
	}
});

test("cap: a child that stops inside the grace window is not capped", async () => {
	const cap = 2;
	const h = harness({ stopAfterSteerTurns: 2 });
	h.mode.maxTurns = cap;
	const out = await runSingleMode("tester", "do it", undefined, h.mode);
	const text = out.content[0]?.type === "text" ? out.content[0].text : "";
	const result = out.details?.results[0];
	const child = h.children[0];

	assert.ok(result);
	assert.equal(child.steers.length, 1, "the steer fires on the cap turn");
	assert.equal(child.aborts, 0, "no abort lands inside the grace window");
	assert.equal(child.emitted, cap + 2, "the child stopped two turns after the steer");
	assert.equal(result.usage.turns, child.emitted, "the run counts every turn it took");
	assert.equal(result.turnsCapped, false, "a run that ends inside the grace window is not capped");
	assert.equal(result.exitCode, 0, "the run exits clean");
	assert.doesNotMatch(text, /capped/, "the caller reads no cap line");
});
