/**
 * Subagent child runner.
 *
 * Builds one in-process child session per run, folds its events into one
 * `SingleResult`, and disposes the child on every exit. No process starts, so
 * the parent folds session events instead of parsing JSON lines.
 */

import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type BuiltChild,
	type ChildLoadout,
	type ChildModel,
	type ChildThinking,
	buildChildSession,
	withChildBuild,
} from "./child-session.ts";
import {
	assertWrapperListEquals,
	builtinChildTool,
	childToolsFor,
	missingChildToolReason,
	missingChildTools,
	wildcardChildTools,
	wildcardLoadoutReason,
	wrapChildTools,
} from "./child-tools.ts";
import { childRoleText, childTaskPrompt } from "./child-prompt.ts";
import { ENV_AGENT_DEPTH, MAX_AGENT_DEPTH, canSpawn, newRunId, parseDepth, planSpawn } from "./depth.ts";
import { createSubagentMcpCounter } from "./mcp-usage.ts";
import { RunRegistry, UNKNOWN_RUN_ROLE, newRunRecord, type RunRegistry as RegistryType } from "./run-registry.ts";
import { type AgentConfig, type PersonaConfig, discoverSkills, formatPersonaId, matchSkills } from "./resolver.ts";
import { foldEvent } from "./subagent-fold.ts";
import {
	type SingleResult,
	type SubagentDetails,
	failureResult,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
} from "./subagent-result.ts";
import { makeThinkingEventHandler, reduceThinking } from "./subagent-thinking.ts";
import {
	TREE_OUTPUT_PREVIEW_BYTES,
	TREE_TASK_PREVIEW_BYTES,
	TREE_UPDATE_INTERVAL_MS,
	appendTreeEvent,
	truncateUtf8,
} from "./subagent-tree.ts";
import type { RunEvent } from "./tree-log.ts";

/** Live repaint period during a run. Short enough to look live, long enough to stay cheap. */
const RUN_TICK_MS = 250;

/** This process's nesting depth, read once at module load. Absent env means level 0. */
const myDepth = parseDepth(process.env[ENV_AGENT_DEPTH]);
/** The class a record carries when the agent names none. Matches the gate rule. */
const FALLBACK_CLASS = "reader";

/** The refusal when no parent session id exists, so a child would walk to depth 0. */
export const NO_PARENT_SESSION_REASON =
	"Refused: no parent session id, so the child record would sit at depth 0 as the root";

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** The model lookup a child named model needs. An unknown name returns undefined. */
export interface ModelLookup {
	find(provider: string, modelId: string): ChildModel | undefined;
}

export interface DispatchDefaults {
	/** The parent model id, `provider/model`, for display. */
	model?: string;
	/** The parent model object. A child uses it when the agent names no model. */
	modelObject?: ChildModel;
	thinkingLevel?: ChildThinking;
	/** Resolves a model the agent frontmatter names. */
	modelRegistry?: ModelLookup;
}

/** The child session parts one build consumes. */
export interface PreparedChildRuntime {
	sessionManager: SessionManager;
	loader: ResourceLoader;
	settingsManager: SettingsManager;
}

/** The parts a child build needs from this process. */
export interface ChildRuntime {
	/** The run records this process writes. The gate reads the same map. */
	registry: RegistryType;
	/** The pi session id that spawned the run. */
	parentSessionId: string | null;
	/** Test seam. Production calls `createAgentSession`. */
	createSession?: typeof createAgentSession;
	/** Test seam. Production builds an extension-free loader and an in-memory session. */
	prepare?: (cwd: string) => Promise<PreparedChildRuntime>;
}

/** Everything one dispatch call reads. The mode code builds this once. */
export interface DispatchDeps {
	/** Parent cwd, used when a step names no cwd. */
	defaultCwd: string;
	defaults: DispatchDefaults;
	agents: AgentConfig[];
	resolveTarget?: (requestedName: string) => { agent: AgentConfig; theme?: string } | null;
	resolveSpawnPersona: (agentName: string) => PersonaConfig | null;
	runtime: ChildRuntime;
}

let processRegistry: RegistryType | null = null;
/** The run records for this process. One map serves every child run. */
export function getRunRegistry(): RegistryType {
	processRegistry ??= new RunRegistry();
	return processRegistry;
}

/**
 * The depth of the session that spawns this run. A registry walk carries it, so
 * an in-process child plans from its own depth, not the root depth. A walk that
 * finds no record falls back to the depth this process started at.
 */
function callerDepthOf(runtime: ChildRuntime): number {
	const callerId = runtime.parentSessionId;
	if (!callerId) return myDepth;
	const walk = runtime.registry.walk(callerId);
	return walk.ok ? walk.depth : myDepth;
}

/** The loader factory a test may replace, so no real extension file is read. */
export type ChildLoaderFactory = (
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
) => ResourceLoader;

/**
 * Build the child session parts. The loader carries no extension set, so a
 * child builds no second gate, and every child tool is wrapped instead.
 */
export async function prepareChildRuntime(
	cwd: string,
	makeLoader: ChildLoaderFactory = (dir, agentDir, settingsManager) =>
		new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true }),
): Promise<PreparedChildRuntime> {
	// The reload runs the extension factory, so it must run under the child guard.
	return withChildBuild(async () => {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = makeLoader(cwd, agentDir, settingsManager);
		await loader.reload();
		return { sessionManager: SessionManager.inMemory(cwd), loader, settingsManager };
	});
}

/**
 * Register the root session record. A child walk needs it to reach depth 0, and
 * the child ask queue reads the root id from that walk. The session shutdown
 * handler finishes the record, so the retention sweep can reclaim it.
 */
export function registerRootSession(sessionId: string, agent: AgentConfig | null): void {
	getRunRegistry().register(
		newRunRecord({
			sessionId,
			role: agent?.name ?? UNKNOWN_RUN_ROLE,
			class: agent?.permissionClass ?? FALLBACK_CLASS,
			source: agent?.source ?? "user",
			skills: agent?.skills ?? [],
			alwaysLoad: agent?.alwaysLoad ?? [],
			depth: 0,
			parentSessionId: null,
			sessionFile: null,
			startedAt: Date.now(),
		}),
	);
}

/**
 * Finish the root record of one session, so the retention sweep can reclaim it.
 * The builder already finished every child record, so only a root closes here.
 * Returns false when no root record holds the id.
 */
export function finishRootSession(registry: RegistryType, sessionId: string, endedAt: number): boolean {
	const record = registry.get(sessionId);
	if (!record || record.parentSessionId !== null) return false;
	return registry.finish(sessionId, "done", endedAt);
}

/**
 * The model object for one child. An agent that names a model the lookup cannot
 * answer returns null: a typo must fail before a session is built.
 */
function resolveChildModel(agent: AgentConfig, defaults: DispatchDefaults): ChildModel | null {
	if (!agent.model) return defaults.modelObject ?? null;
	const slash = agent.model.indexOf("/");
	if (slash <= 0) return null;
	return defaults.modelRegistry?.find(agent.model.slice(0, slash), agent.model.slice(slash + 1)) ?? null;
}

/**
 * Run one child agent and return its result.
 *
 * The run record exists before the build, so the gate resolves the child from
 * its first tool call. Every exit, including an abort or a throw, disposes the
 * session and marks the record.
 */
export async function runSingleAgent(
	deps: DispatchDeps,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const target = deps.resolveTarget ? deps.resolveTarget(agentName) : null;
	const agent = target?.agent ?? null;
	if (!agent) {
		const available = deps.agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return failureResult(
			agentName,
			"unknown",
			task,
			step,
			`Unknown agent: "${agentName}". Available agents: ${available}.`,
		);
	}
	// A child needs a parent id, or its record walks to depth 0 as the root.
	if (!deps.runtime.parentSessionId) {
		return failureResult(agentName, agent.source, task, step, NO_PARENT_SESSION_REASON);
	}
	// An in-process child shares this process, so the registry carries its depth.
	const callerDepth = callerDepthOf(deps.runtime);
	// The registry walk answers the cap here; the env depth is the fallback.
	if (!canSpawn(callerDepth)) {
		return failureResult(
			agentName,
			agent.source,
			task,
			step,
			`Depth cap reached (level ${MAX_AGENT_DEPTH}): subagents cannot spawn further subagents.`,
		);
	}
	// A resolved agent whose frontmatter sets `spawnable: false` runs as the main
	// session only. Reject before a session is built.
	if (agent.spawnable === false) {
		return failureResult(
			agentName,
			agent.source,
			task,
			step,
			`Agent '${agentName}' is not spawnable as a subagent (its frontmatter sets spawnable: false).`,
		);
	}
	const model = resolveChildModel(agent, deps.defaults);
	if (!model) {
		const named = agent.model ? ` "${agent.model}"` : "";
		return failureResult(agentName, agent.source, task, step, `No usable model${named} for agent "${agentName}".`);
	}

	const childCwd = cwd ?? deps.defaultCwd;
	const persona = deps.resolveSpawnPersona(agent.name);
	const personaId = persona ? formatPersonaId(persona) : null;
	const spawnPlan = planSpawn(callerDepth, agent.tools ?? []);
	// A wildcard would activate tools that no wrapper covers, so it never builds.
	const wildcards = wildcardChildTools(spawnPlan.tools);
	if (wildcards.length > 0) {
		return failureResult(agentName, agent.source, task, step, wildcardLoadoutReason(wildcards));
	}
	// A name no builtin and no kept definition covers has nothing to run.
	const missing = missingChildTools(spawnPlan.tools);
	if (missing.length > 0) {
		return failureResult(agentName, agent.source, task, step, missingChildToolReason(missing));
	}
	const loadout: ChildLoadout = {
		tools: spawnPlan.tools,
		customTools: childToolsFor(spawnPlan.tools),
		model,
		// A named model brings its own thinking default, so the call value would fight it.
		thinkingLevel: agent.model ? undefined : deps.defaults.thinkingLevel,
	};

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // -1 = still running
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model ?? deps.defaults.model,
		step,
		runStartedAt: Date.now(),
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 0 },
	};

	// Run identity for the append-only tree log. The parent reads its id from env.
	const childRunId = newRunId();
	const parentRunId = process.env["PI_AGENT_RUN_ID"] ?? null;
	const taskBytes = Buffer.byteLength(task, "utf8");
	let bytesOut = 0;
	let lastTreeUpdateAt = Date.now();
	const mcp = createSubagentMcpCounter();

	const emitTree = (type: "start" | "update" | "end", extra: Record<string, unknown>) => {
		appendTreeEvent(
			{
				v: 1,
				type,
				runId: childRunId,
				parentRunId,
				depth: spawnPlan.childDepth,
				agent: agent.name,
				persona: personaId,
				at: new Date().toISOString(),
				...extra,
			} as RunEvent,
			mcp,
		);
	};
	const usageSnapshot = () => ({
		input: currentResult.usage.input,
		output: currentResult.usage.output,
		cost: currentResult.usage.cost,
		turns: currentResult.usage.turns,
	});
	const emitTreeUpdate = () => {
		const now = Date.now();
		if (now - lastTreeUpdateAt < TREE_UPDATE_INTERVAL_MS) return;
		lastTreeUpdateAt = now;
		const usage = usageSnapshot();
		emitTree("update", { status: "running", bytesIn: taskBytes, bytesOut, toolCount: mcp.toolCount(), usage });
	};
	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};
	// Repaint on a timer so the header elapsed moves during tool runs too.
	let runTicker: ReturnType<typeof setInterval> | undefined;
	if (onUpdate) {
		runTicker = setInterval(() => {
			emitUpdate();
			emitTreeUpdate();
		}, RUN_TICK_MS);
		runTicker.unref?.();
	}
	const handleThinkingEvent = makeThinkingEventHandler(
		() => currentResult.thinking,
		(state) => {
			currentResult.thinking = state;
		},
		emitUpdate,
		() => Date.now(),
	);
	emitTree("start", { status: "running", task: truncateUtf8(task, TREE_TASK_PREVIEW_BYTES) });
	let built: BuiltChild | null = null;
	try {
		const prepared = await (deps.runtime.prepare ?? prepareChildRuntime)(childCwd);
		// A child loads no extension, so its role text travels in the prompt.
		const discovered = discoverSkills(childCwd);
		const patterns = agent.alwaysLoad ?? [];
		const alwaysLoad = matchSkills(patterns, discovered);
		const missingPatterns = patterns.filter((pattern) => matchSkills([pattern], discovered).length === 0);
		const roleText = childRoleText({ agent, persona, alwaysLoad, missingPatterns });
		// One wrapper per loadout tool: the child has no gate of its own to ask.
		const wrappers = wrapChildTools({
			names: loadout.tools,
			customTools: loadout.customTools,
			resolveBuiltin: (name) => builtinChildTool(name, childCwd, prepared.settingsManager),
		});
		assertWrapperListEquals(loadout.tools, wrappers);
		const sessionId = prepared.sessionManager.getSessionId();
		built = await buildChildSession({
			loadout: { ...loadout, customTools: wrappers },
			parent: { cwd: childCwd, loader: prepared.loader, settingsManager: prepared.settingsManager, signal },
			start: {
				sessionId,
				role: agent.name,
				class: agent.permissionClass ?? FALLBACK_CLASS,
				source: agent.source,
				skills: agent.skills ?? [],
				alwaysLoad: agent.alwaysLoad ?? [],
				depth: spawnPlan.childDepth,
				parentSessionId: deps.runtime.parentSessionId,
				sessionFile: prepared.sessionManager.getSessionFile() ?? null,
				startedAt: Date.now(),
			},
			sessionManager: prepared.sessionManager,
			registry: deps.runtime.registry,
			createSession: deps.runtime.createSession,
		});

		const unsubscribe = built.session.subscribe((event) => {
			bytesOut += foldEvent(event, currentResult, (e) => mcp.count(e), handleThinkingEvent, () => {
				emitUpdate();
				emitTreeUpdate();
			});
		});
		let promptError: string | null = null;
		try {
			await built.session.prompt(childTaskPrompt(roleText, task));
		} catch (error) {
			promptError = error instanceof Error ? error.message : String(error);
		} finally {
			unsubscribe();
		}

		if (promptError) currentResult.errorMessage = promptError;
		if (signal?.aborted) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= "Subagent was aborted";
			return currentResult;
		}
		// The running marker is -1, so the exit code comes from the run itself.
		const failed =
			promptError !== null || currentResult.stopReason === "error" || currentResult.stopReason === "aborted";
		currentResult.exitCode = failed ? 1 : 0;
		return currentResult;
	} catch (error) {
		// A build or session throw is one failed run, so every caller keeps a result.
		currentResult.exitCode = 1;
		currentResult.errorMessage ??= error instanceof Error ? error.message : String(error);
		return currentResult;
	} finally {
		if (runTicker) clearInterval(runTicker);
		if (currentResult.thinking?.thinking) {
			currentResult.thinking = reduceThinking(currentResult.thinking, "thinking_end", Date.now());
		}
		// The record and the session close here on every exit, including a throw.
		built?.dispose(isFailedResult(currentResult) ? "failed" : "done");
		emitTree("end", {
			status: isFailedResult(currentResult) ? "failed" : "done",
			bytesIn: taskBytes,
			bytesOut,
			toolCount: mcp.toolCount(),
			usage: usageSnapshot(),
			exitCode: currentResult.exitCode,
			error: currentResult.errorMessage ?? null,
			outputPreview: truncateUtf8(getResultOutput(currentResult), TREE_OUTPUT_PREVIEW_BYTES),
		});
	}
}
