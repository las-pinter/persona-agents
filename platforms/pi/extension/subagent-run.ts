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
import { DEPTH_CAP_REASON, ENV_AGENT_DEPTH, canSpawn, newRunId, parseDepth, planSpawn } from "./depth.ts";
import { createSubagentMcpCounter } from "./mcp-usage.ts";
import { RunRegistry, UNKNOWN_RUN_ROLE, newRunRecord, type RunRegistry as RegistryType } from "./run-registry.ts";
import { type AgentConfig, type PersonaConfig, discoverSkills, formatPersonaId, matchSkills } from "./resolver.ts";
import { foldEvent } from "./subagent-fold.ts";
import {
	type SingleResult,
	type SubagentDetails,
	ABORT_TEXT,
	failureResult,
	getFinalOutput,
	isFailedResult,
	resultBodyBlock,
	resultText,
} from "./subagent-result.ts";
import { makeThinkingEventHandler, reduceThinking } from "./subagent-thinking.ts";
import {
	type PlannedSession,
	openPlannedSession,
	planSession,
	writeRoundSidecar,
} from "./session-store.ts";
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
	/** Test seam for the session store. Defaults to `getAgentDir()`. */
	agentDir?: string;
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
 * the gate denies a child ask by reading the depth of that walk. The session
 * shutdown handler finishes the record, so the retention sweep can reclaim it.
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
	session?: string,
): Promise<SingleResult> {
	// Every refusal carries the caller's id, so a refused run still names it.
	const fail = (source: SingleResult["agentSource"], reason: string, round = 1): SingleResult => ({
		...failureResult(agentName, source, task, step, reason),
		session: session ?? null,
		round,
	});
	const target = deps.resolveTarget ? deps.resolveTarget(agentName) : null;
	const agent = target?.agent ?? null;
	if (!agent) {
		const available = deps.agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return fail("unknown", `Unknown agent: "${agentName}". Available agents: ${available}.`);
	}
	// A child needs a parent id, or its record walks to depth 0 as the root.
	if (!deps.runtime.parentSessionId) {
		return fail(agent.source, NO_PARENT_SESSION_REASON);
	}
	// An in-process child shares this process, so the registry carries its depth.
	const callerDepth = callerDepthOf(deps.runtime);
	// The registry walk answers the cap here; the env depth is the fallback.
	if (!canSpawn(callerDepth)) {
		return fail(agent.source, DEPTH_CAP_REASON);
	}
	// A resolved agent whose frontmatter sets `spawnable: false` runs as the main
	// session only. Reject before a session is built.
	if (agent.spawnable === false) {
		return fail(
			agent.source,
			`Agent '${agentName}' is not spawnable as a subagent (its frontmatter sets spawnable: false).`,
		);
	}
	const model = resolveChildModel(agent, deps.defaults);
	if (!model) {
		const named = agent.model ? ` "${agent.model}"` : "";
		return fail(agent.source, `No usable model${named} for agent "${agentName}".`);
	}

	const childCwd = cwd ?? deps.defaultCwd;
	const persona = deps.resolveSpawnPersona(agent.name);
	const personaId = persona ? formatPersonaId(persona) : null;
	const spawnPlan = planSpawn(callerDepth, agent.tools ?? []);
	// A wildcard would activate tools that no wrapper covers, so it never builds.
	const wildcards = wildcardChildTools(spawnPlan.tools);
	if (wildcards.length > 0) {
		return fail(agent.source, wildcardLoadoutReason(wildcards));
	}
	// A name no builtin and no kept definition covers has nothing to run.
	const missing = missingChildTools(spawnPlan.tools);
	if (missing.length > 0) {
		return fail(agent.source, missingChildToolReason(missing));
	}
	const loadout: ChildLoadout = {
		tools: spawnPlan.tools,
		customTools: childToolsFor(spawnPlan.tools),
		model,
		// A named model brings its own thinking default, so the call value would fight it.
		thinkingLevel: agent.model ? undefined : deps.defaults.thinkingLevel,
	};

	// The store owns every resume rule. The runner only switches on the plan.
	const plan = session
		? planSession({
				agentDir: deps.runtime.agentDir ?? getAgentDir(),
				id: session,
				agent: agent.name,
				class: agent.permissionClass ?? FALLBACK_CLASS,
				cwd: childCwd,
				now: Date.now(),
			})
		: null;
	// A cap refusal names the round it refused, so the count reads true.
	if (plan !== null && plan.kind === "refuse") return fail(agent.source, plan.message, plan.round ?? 1);
	// The round opens inside the build try, so a failed open is one failed run.
	let plannedRound: PlannedSession | null = null;

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
		session: plan ? plan.id : null,
		resumed: false,
		round: 1,
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
				round: currentResult.round,
				resumed: currentResult.resumed,
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
	// The plan holds the true round; the current result still holds the default.
	emitTree("start", {
		status: "running",
		task: truncateUtf8(task, TREE_TASK_PREVIEW_BYTES),
		round: plan?.round ?? 1,
		resumed: plan?.kind === "resume",
	});
	let built: BuiltChild | null = null;
	try {
		const prepared = await (deps.runtime.prepare ?? prepareChildRuntime)(childCwd);
		let sessionManager = prepared.sessionManager;
		if (plan !== null) {
			plannedRound = openPlannedSession(plan, deps.runtime.parentSessionId);
			sessionManager = plannedRound.sessionManager;
			currentResult.session = plannedRound.id;
			currentResult.resumed = plannedRound.resumed;
			// A cold round carries the store reason, so the caller reads why it started fresh.
			currentResult.stderr = plannedRound.note;
		}
		currentResult.round = plannedRound === null ? 1 : plannedRound.round;
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
		const sessionId = sessionManager.getSessionId();
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
				sessionFile: sessionManager.getSessionFile() ?? null,
				startedAt: Date.now(),
			},
			sessionManager,
			registry: deps.runtime.registry,
			createSession: deps.runtime.createSession,
		});
		const child = built;
		// The registry count and usage.turns move together, once per assistant end.
		const onAssistantTurn = (): void => {
			deps.runtime.registry.addTurn(child.record.sessionId);
		};

		const unsubscribe = built.session.subscribe((event) => {
			bytesOut += foldEvent(
				event,
				currentResult,
				(e) => mcp.count(e),
				handleThinkingEvent,
				() => {
					emitUpdate();
					emitTreeUpdate();
				},
				onAssistantTurn,
			);
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
		// Only a round that appended a conversation message leaves a sidecar behind.
		// Saved history seeds agent state, and no replay emits an event, so this list
		// holds this round's messages only.
		const wroteRound = currentResult.messages.some(
			(message) => message.role === "user" || message.role === "assistant",
		);
		if (plannedRound !== null && wroteRound) {
			writeRoundSidecar(plannedRound.plan, currentResult.usage.turns, deps.runtime.parentSessionId, Date.now());
		}
		// The parent abort ended this run, so the caller reads an aborted result.
		if (signal?.aborted) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= ABORT_TEXT;
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
		// The shared rule supplies the real error text for the end event.
		emitTree("end", {
			status: isFailedResult(currentResult) ? "failed" : "done",
			bytesIn: taskBytes,
			bytesOut,
			toolCount: mcp.toolCount(),
			usage: usageSnapshot(),
			exitCode: currentResult.exitCode,
			error: resultText(currentResult).error,
			outputPreview: truncateUtf8(resultBodyBlock(currentResult), TREE_OUTPUT_PREVIEW_BYTES),
		});
	}
}
