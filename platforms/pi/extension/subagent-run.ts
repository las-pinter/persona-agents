/**
 * Subagent child runner.
 *
 * Spawns one `pi` child per run, parses its JSON stdout lines, and returns one
 * `SingleResult`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type AgentConfig, type PersonaConfig, formatPersonaId } from "./resolver.ts";
import {
	ENV_AGENT_DEPTH,
	ENV_PARENT_RUN_ID,
	ENV_RUN_ID,
	canSpawn,
	childToolArgs,
	newRunId,
	parseDepth,
	planSpawn,
} from "./depth.ts";
import { createSubagentMcpCounter } from "./mcp-usage.ts";
import {
	type SingleResult,
	type SubagentDetails,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
} from "./subagent-result.ts";
import { isThinkingEventType, makeThinkingEventHandler, reduceThinking } from "./subagent-thinking.ts";
import {
	TREE_OUTPUT_PREVIEW_BYTES,
	TREE_TASK_PREVIEW_BYTES,
	TREE_UPDATE_INTERVAL_MS,
	appendTreeEvent,
	truncateUtf8,
} from "./subagent-tree.ts";

/** Live repaint period during a run. Short enough to look live, long enough to stay cheap. */
const RUN_TICK_MS = 250;

/** This process's nesting depth, read once at module load. Absent env means level 0. */
const myDepth = parseDepth(process.env[ENV_AGENT_DEPTH]);

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/** Build the child environment. Env is a carrier for depth and run identity;
 * the parent `--tools` strip is the real control. */
function buildChildEnv(childDepthValue: number, childRunId: string, parentRunId: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	env[ENV_AGENT_DEPTH] = String(childDepthValue);
	env[ENV_RUN_ID] = childRunId;
	// Overwrite any inherited parent id: this child's parent is THIS process.
	if (parentRunId) env[ENV_PARENT_RUN_ID] = parentRunId;
	else delete env[ENV_PARENT_RUN_ID];
	return env;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	resolveTarget: ((requestedName: string) => { agent: AgentConfig; theme?: string } | null) | undefined,
	resolveSpawnPersona: (agentName: string) => PersonaConfig | null,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const target = resolveTarget ? resolveTarget(agentName) : null;
	const agent = target?.agent ?? null;

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Depth cap: refuse before any process starts. Env is the carrier; this
	// self-guard is the defense-in-depth backstop for a stale template.
	if (!canSpawn(myDepth)) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "Depth cap reached (level 2): subagents cannot spawn further subagents.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Spawn allowlist: a resolved agent (direct name OR theme-profession alias)
	// whose frontmatter sets `spawnable: false` is never dispatched — it runs as
	// the main session only. Reject before any process is spawned.
	if (agent.spawnable === false) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Agent '${agentName}' is not spawnable as a subagent (its frontmatter sets spawnable: false).`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	// Keep the `subagent` strip in the pure `childToolArgs` helper. pi locks
	// tools at process start, so this is the real control. An absent `--tools`
	// re-enables pi defaults, so a stripped-to-empty list passes `--no-tools`.
	const requestedTools = agent.tools ?? [];
	const spawnPlan = planSpawn(myDepth, requestedTools);
	args.push(...childToolArgs(requestedTools, myDepth));

	// The child must activate EXACTLY this agent + persona; otherwise the child's
	// own applyDefaults would pull in global defaultAgent/defaultPersona and
	// override the caller's theme choice.
	args.push("--agent", agent.name);
	const persona = resolveSpawnPersona(agent.name);
	const personaId = persona ? formatPersonaId(persona) : null;
	args.push("--persona", personaId ?? "off");

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // -1 = still running
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
		runStartedAt: Date.now(),
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 0 },
	};

	/** Run identity carried to the child via env. Parent id comes from our env. */
	const childRunId = newRunId();
	const parentRunId = process.env[ENV_RUN_ID] ?? null;

	// The parent writes this run's records. Append the start before the spawn so
	// the tree shows the child the moment it exists.
	let lastTreeUpdateAt = Date.now();
	const taskBytes = Buffer.byteLength(task, "utf8");
	let bytesOut = 0;
	// One pass counts distinct tool calls and per-server MCP calls.
	const mcp = createSubagentMcpCounter();
	appendTreeEvent({
		v: 1,
		type: "start",
		runId: childRunId,
		parentRunId,
		depth: spawnPlan.childDepth,
		agent: agent.name,
		persona: personaId,
		status: "running",
		at: new Date().toISOString(),
		task: truncateUtf8(task, TREE_TASK_PREVIEW_BYTES),
	});

	const emitTreeUpdate = () => {
		const now = Date.now();
		if (now - lastTreeUpdateAt < TREE_UPDATE_INTERVAL_MS) return;
		lastTreeUpdateAt = now;
		appendTreeEvent({
			v: 1,
			type: "update",
			runId: childRunId,
			parentRunId,
			depth: spawnPlan.childDepth,
			agent: agent.name,
			persona: personaId,
			status: "running",
			at: new Date().toISOString(),
			bytesIn: taskBytes,
			bytesOut,
			toolCount: mcp.toolCount(),
			usage: {
				input: currentResult.usage.input,
				output: currentResult.usage.output,
				cost: currentResult.usage.cost,
				turns: currentResult.usage.turns,
			},
		}, mcp);
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	// Repaint the run on a timer so the header elapsed moves during tool runs
	// too. The ticker reuses the update emit, so parallel and chain repaint.
	let runTicker: ReturnType<typeof setInterval> | undefined;
	const stopRunTicker = () => {
		if (!runTicker) return;
		clearInterval(runTicker);
		runTicker = undefined;
	};
	const startRunTicker = () => {
		if (runTicker || !onUpdate) return;
		runTicker = setInterval(() => {
			emitUpdate();
			emitTreeUpdate();
		}, RUN_TICK_MS);
		runTicker.unref?.();
	};

	/** Fold one thinking event into this run's state. */
	const handleThinkingEvent = makeThinkingEventHandler(
		() => currentResult.thinking,
		(state) => {
			currentResult.thinking = state;
		},
		emitUpdate,
		() => Date.now(),
	);

	try {
		// The child activates the agent + persona via flags; its before_agent_start
		// then injects the profession body + persona itself (no temp prompt file).
		startRunTicker();
		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const spawnChild = () => {
				const invocation = getPiInvocation(args);
				return spawn(invocation.command, invocation.args, {
					cwd: cwd ?? defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: buildChildEnv(spawnPlan.childDepth, childRunId, parentRunId),
				});
			};
			let proc: ReturnType<typeof spawnChild>;
			try {
				proc = spawnChild();
			} catch (error) {
				// A synchronous spawn throw (bad options or args) must still close the
				// run, or the tree's `start` node stays `running` for five minutes.
				// Resolve here and let the normal post-await `end` emission run.
				currentResult.errorMessage = error instanceof Error ? error.message : String(error);
				resolve(1);
				return;
			}
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				mcp.count(event);

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const eventType = event.assistantMessageEvent.type;
					if (isThinkingEventType(eventType)) handleThinkingEvent(eventType);
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
							if (typeof usage.reasoning === "number") {
								currentResult.reasoningTokens = (currentResult.reasoningTokens ?? 0) + usage.reasoning;
							}
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					emitTreeUpdate();
				}
				// Note: tool results arrive as message_end with role "toolResult" (handled
				// above); pi emits no separate "tool_result_end" event.
			};

			proc.stdout.on("data", (data) => {
				bytesOut += data.length;
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		appendTreeEvent({
			v: 1,
			type: "end",
			runId: childRunId,
			parentRunId,
			depth: spawnPlan.childDepth,
			agent: agent.name,
			persona: personaId,
			status: isFailedResult(currentResult) ? "failed" : "done",
			at: new Date().toISOString(),
			bytesIn: taskBytes,
			bytesOut,
			toolCount: mcp.toolCount(),
			usage: {
				input: currentResult.usage.input,
				output: currentResult.usage.output,
				cost: currentResult.usage.cost,
				turns: currentResult.usage.turns,
			},
			exitCode,
			error: currentResult.errorMessage ?? null,
			outputPreview: truncateUtf8(getResultOutput(currentResult), TREE_OUTPUT_PREVIEW_BYTES),
		}, mcp);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		// Finalize the run: close any open thinking stretch and stop the ticker.
		stopRunTicker();
		if (currentResult.thinking?.thinking) {
			currentResult.thinking = reduceThinking(currentResult.thinking, "thinking_end", Date.now());
		}
	}
}
