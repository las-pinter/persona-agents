/**
 * Subagent tool: delegate tasks to specialized agents.
 *
 * Builds one in-process child session per invocation. Modes: single, parallel,
 * and chain with a `{previous}` placeholder. The child runner owns the build
 * and the dispose; this module owns the tool definition and the mode dispatch.
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type PersonaConfig,
	discoverAgents,
	personaForThemeProfession,
	resolveAgentAlias,
	resolvePersonaForAgent,
} from "./resolver.ts";
import { getActiveAgent, getActivePersona } from "./state.ts";
import { SPAWN_TOOL_NAME } from "./depth.ts";
import { archiveRun } from "./inspector.ts";
import {
	type SingleResult,
	type SubagentDetails,
	getFinalOutput,
	isFailedResult,
	resultTextBlock,
	toInspectTask,
	truncateChainPrevious,
	truncateParallelOutput,
} from "./subagent-result.ts";
import {
	type ChildRuntime,
	type DispatchDeps,
	type OnUpdateCallback,
	getRunRegistry,
	runSingleAgent,
} from "./subagent-run.ts";
import { renderSubagentCall, renderSubagentResult } from "./subagent-render.ts";
import { SubagentParams } from "./subagent-schema.ts";
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
/** The refusal when a session id rides a mode that cannot persist one. */
export const SESSION_SINGLE_MODE_REASON =
	"session needs single mode: name one agent and its task. chain and tasks cannot carry a session.";

/** An empty session id is no session, so a bare string never reaches the store. */
export function sessionParamOf(params: { session?: string }): string | undefined {
	return params.session || undefined;
}
/** One step of a chain or parallel call. */
export interface StepInput {
	agent: string;
	task: string;
	cwd?: string;
}
/** The shared inputs of one dispatch call. The mode code reads it once. */
export interface ModeRun {
	deps: DispatchDeps;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails;
	/** Writes a finished run to the inspector archive. Absent in a test. */
	archive?: (mode: "chain" | "parallel" | "single", results: SingleResult[]) => void;
}

/** A bounded worker pool. The queue order is the task order. */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const runWorker = async (): Promise<void> => {
		for (let current = nextIndex++; current < items.length; current = nextIndex++) {
			results[current] = await fn(items[current], current);
		}
	};
	const workers: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) workers.push(runWorker());
	await Promise.all(workers);
	return results;
}

/** Chain mode: run each step in order and pass the prior output to the next. */
export async function runChainMode(
	chain: StepInput[],
	mode: ModeRun,
): Promise<AgentToolResult<SubagentDetails>> {
	const results: SingleResult[] = [];
	let previousOutput = "";
	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, truncateChainPrevious(previousOutput));
		// Combine the completed steps with the one that is streaming now.
		const chainUpdate: OnUpdateCallback | undefined = mode.onUpdate
			? (partial) => {
					const current = partial.details?.results[0];
					if (!current) return;
					mode.onUpdate?.({
						content: partial.content,
						details: mode.makeDetails("chain")([...results, current]),
					});
				}
			: undefined;
		const result = await runSingleAgent(
			mode.deps,
			step.agent,
			taskWithContext,
			step.cwd,
			i + 1,
			mode.signal,
			chainUpdate,
			mode.makeDetails("chain"),
		);
		results.push(result);
		if (isFailedResult(result)) {
			// The shared rule adds the body and any real error.
			const body = resultTextBlock(result);
			return {
				content: [
					{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${body}` },
				],
				details: mode.makeDetails("chain")(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	mode.archive?.("chain", results);
	return {
		content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
		details: mode.makeDetails("chain")(results),
	};
}

/** Parallel mode: run every task with a bounded worker pool. */
export async function runParallelMode(
	tasks: StepInput[],
	mode: ModeRun,
): Promise<AgentToolResult<SubagentDetails>> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [
				{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
			],
			details: mode.makeDetails("parallel")([]),
		};
	}
	const allResults: SingleResult[] = tasks.map((task) => ({
		agent: task.agent,
		agentSource: "unknown",
		task: task.task,
		exitCode: -1, // -1 = still running
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 0 },
		session: null,
		resumed: false,
		round: 1,
	}));
	const emitParallelUpdate = () => {
		if (!mode.onUpdate) return;
		const running = allResults.filter((r) => r.exitCode === -1).length;
		const done = allResults.filter((r) => r.exitCode !== -1).length;
		mode.onUpdate({
			content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
			details: mode.makeDetails("parallel")([...allResults]),
		});
	};
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
		// The worker starts now; queue wait must not count as run time.
		allResults[index].runStartedAt = Date.now();
		const result = await runSingleAgent(
			mode.deps,
			task.agent,
			task.task,
			task.cwd,
			undefined,
			mode.signal,
			(partial) => {
				const current = partial.details?.results[0];
				if (!current) return;
				allResults[index] = current;
				emitParallelUpdate();
			},
			mode.makeDetails("parallel"),
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		// The shared rule carries the body and any real error.
		const output = truncateParallelOutput(resultTextBlock(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	mode.archive?.("parallel", results);
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: mode.makeDetails("parallel")(results),
	};
}

/** Single mode: run one agent and return its output. */
export async function runSingleMode(
	agentName: string,
	task: string,
	cwd: string | undefined,
	mode: ModeRun,
	session?: string,
): Promise<AgentToolResult<SubagentDetails>> {
	const result = await runSingleAgent(
		mode.deps,
		agentName,
		task,
		cwd,
		undefined,
		mode.signal,
		mode.onUpdate,
		mode.makeDetails("single"),
		session,
	);
	if (isFailedResult(result)) {
		const head = `Agent ${result.stopReason || "failed"}: `;
		return {
			content: [{ type: "text", text: `${head}${resultTextBlock(result)}` }],
			details: mode.makeDetails("single")([result]),
			isError: true,
		};
	}
	mode.archive?.("single", [result]);
	const body = getFinalOutput(result.messages) || "(no output)";
	// A cold round puts its store reason on stderr, so a caller reads why it started fresh.
	const text = result.stderr ? `${result.stderr}\n\n${body}` : body;
	return {
		content: [{ type: "text", text }],
		details: mode.makeDetails("single")([result]),
	};
}

/** The parent session id, or null when the manager cannot answer. */
function parentSessionIdOf(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionId() ?? null;
	} catch {
		return null;
	}
}
/** Duration formatting lives in `duration.ts`; re-exported for callers. */
export { formatDuration as formatToolDuration } from "./duration.ts";
/** Thinking state lives in `subagent-thinking.ts`; re-exported for callers. */
export {
	INITIAL_THINKING,
	type ThinkingEventType,
	type ThinkingState,
	formatThinkingIndicator,
	isThinkingEventType,
	makeThinkingEventHandler,
	reduceThinking,
	thinkingElapsedMs,
} from "./subagent-thinking.ts";
/** Result types live in `subagent-result.ts`; re-exported for callers. */
export { type SingleResult, toInspectTask } from "./subagent-result.ts";
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: SPAWN_TOOL_NAME,
		label: "Subagent",
		description: `Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}). To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project"). Agent names also accept theme-profession aliases (e.g. goblin-mascot = mascot with the goblin persona).`,
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			// Resolve the roster first: the helpers below close over it.
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			// A requested theme/agent alias decides the child persona; the caller's theme is the fallback.
			const activeAgent = getActiveAgent();
			const callerTheme =
				getActivePersona()?.theme ??
				(activeAgent?.persona
					? resolvePersonaForAgent(discovery.personas, activeAgent.persona, activeAgent.name)?.theme
					: undefined);
			// A requested name may be a plain agent name or a theme-profession alias
			// such as goblin-mascot (mascot agent plus goblin theme).
			const targetCache = new Map<string, { agent: AgentConfig; theme?: string } | null>();
			const resolveTarget = (requestedName: string): { agent: AgentConfig; theme?: string } | null => {
				if (targetCache.has(requestedName)) return targetCache.get(requestedName) ?? null;
				const resolved = resolveAgentAlias(requestedName, agents, discovery.personas);
				targetCache.set(requestedName, resolved);
				return resolved;
			};
			const resolveSpawnPersona = (agentName: string): PersonaConfig | null => {
				const target = resolveTarget(agentName);
				if (!target) return null;
				const p = resolvePersonaForAgent(discovery.personas, target.agent.persona, target.agent.name);
				if (p) return p;
				const theme = target.theme ?? callerTheme;
				if (theme) return personaForThemeProfession(theme, target.agent.name, discovery.personas);
				return null;
			};
			const archive = (mode: "chain" | "parallel" | "single", results: SingleResult[]) =>
				archiveRun({
					at: new Date().toISOString(),
					mode,
					agentScope,
					results: results.map(toInspectTask),
				});
			const runtime: ChildRuntime = {
				registry: getRunRegistry(),
				parentSessionId: parentSessionIdOf(ctx),
			};
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const session = sessionParamOf(params);
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const requestedMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});
			const modeRun: ModeRun = {
				deps: {
					defaultCwd: ctx.cwd,
					defaults: {
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						modelObject: ctx.model,
						thinkingLevel: ctx.thinkingLevel,
						modelRegistry: ctx.modelRegistry,
					},
					agents,
					resolveTarget,
					resolveSpawnPersona,
					runtime,
				},
				signal,
				onUpdate,
				makeDetails,
				archive,
			};
			if (session !== undefined && !hasSingle) {
				return {
					content: [{ type: "text", text: SESSION_SINGLE_MODE_REASON }],
					details: makeDetails(requestedMode)([]),
				};
			}
			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);
				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");
				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(requestedMode)([]),
						};
				}
			}
			if (params.chain && params.chain.length > 0) return runChainMode(params.chain, modeRun);
			if (params.tasks && params.tasks.length > 0) return runParallelMode(params.tasks, modeRun);
			if (params.agent && params.task)
				return runSingleMode(params.agent, params.task, params.cwd, modeRun, session);
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
}
