/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * This module owns the public tool definition: the schema, the mode dispatch,
 * and the renderers; the child runner, result helpers, tree events, and thinking
 * state live in the sibling `subagent-*.ts` modules.
 */

import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
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
import { archiveRun } from "./inspector.ts";
import {
	type SingleResult,
	type SubagentDetails,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	toInspectTask,
	truncateChainPrevious,
	truncateParallelOutput,
} from "./subagent-result.ts";
import { type DispatchDefaults, type OnUpdateCallback, runSingleAgent } from "./subagent-run.ts";
import { renderSubagentCall, renderSubagentResult } from "./subagent-render.ts";
import { SubagentParams } from "./subagent-schema.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"Agent names also accept theme-profession aliases (e.g. goblin-mascot = mascot with the goblin persona).",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			// Resolve discovered agents/personas up front: later initializers below
			// (callerTheme, resolveTarget, resolveSpawnPersona) close over them.
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			// The caller's theme (from its active persona) flows into every spawned
			// agent so a goblin orchestrator spawns goblin subagents.
			const activeAgent = getActiveAgent();
			const callerTheme =
				getActivePersona()?.theme ??
				(activeAgent?.persona
					? resolvePersonaForAgent(discovery.personas, activeAgent.persona, activeAgent.name)?.theme
					: undefined);

			// Resolve a requested agent name, supporting "theme-profession" aliases
			// (goblin-mascot -> mascot agent + goblin theme) from the kiro/opencode
			// ecosystems, in addition to pi's plain agent names.
			const targetCache = new Map<string, { agent: AgentConfig; theme?: string } | null>();
			const resolveTarget = (requestedName: string): { agent: AgentConfig; theme?: string } | null => {
				if (targetCache.has(requestedName)) return targetCache.get(requestedName) ?? null;
				let resolved = resolveAgentAlias(requestedName, agents, discovery.personas);
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
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

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
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, truncateChainPrevious(previousOutput));

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						resolveTarget,
						resolveSpawnPersona,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				archive("chain", results);
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					// The worker starts now; queue wait must not count as run time.
					allResults[index].runStartedAt = Date.now();
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						resolveTarget,
						resolveSpawnPersona,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				archive("parallel", results);
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					resolveTarget,
					resolveSpawnPersona,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				archive("single", [result]);
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

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
