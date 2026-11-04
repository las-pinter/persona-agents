/**
 * Subagent parameter schema.
 *
 * The TypeBox schema for the `subagent` tool arguments, shared by the tool
 * registration and the tool renderers.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SESSION_ROUND_CAP } from "./session-store.ts";
import { DEFAULT_MAX_TURNS, MAX_MAX_TURNS, MIN_MAX_TURNS } from "./turn-cap.ts";

/** The rounds one store id may run, written from the cap. */
function sessionRoundsText(): string {
	return Array.from({ length: SESSION_ROUND_CAP }, (_, i) => `round ${i + 1}`).join(" and ");
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	session: Type.Optional(
		Type.String({
			description: `Single mode only. Store session id: it must start with the agent name and a hyphen. Only ${sessionRoundsText()} may run on one id.`,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description: `Turn cap for each child run: a whole number from ${MIN_MAX_TURNS} to ${MAX_MAX_TURNS}. Default: ${DEFAULT_MAX_TURNS}. A value outside the range is refused before the run.`,
		}),
	),
});
