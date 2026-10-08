/**
 * Agent nesting depth — pure helpers.
 *
 * Depth is carried to a child through the environment (`PI_AGENT_DEPTH`) and
 * enforced by the parent's `--tools` strip plus a child self-guard. The env is
 * a carrier, not a boundary.
 *
 * No pi import: this module is pure so `depth.test.ts` needs no runtime.
 */

/** Maximum nesting depth: levels 0, 1, 2. A level-2 agent may not spawn. */
export const MAX_AGENT_DEPTH = 2;

/** Env var for the agent nesting depth. */
export const ENV_AGENT_DEPTH = "PI_AGENT_DEPTH";
/** Env var for a run's own run id. */
export const ENV_RUN_ID = "PI_AGENT_RUN_ID";
/** Env var for a run's parent run id. */
export const ENV_PARENT_RUN_ID = "PI_AGENT_PARENT_RUN_ID";
/** Env var for the shared append-only tree log path. */
export const ENV_TREE_LOG = "PI_AGENT_TREE_LOG";

/**
 * True when `env` belongs to a root process.
 *
 * A child always receives `PI_AGENT_PARENT_RUN_ID` from `buildChildEnv`; the
 * root never has it. Do not test `PI_AGENT_RUN_ID`: the root sets it on its
 * own env, and it survives `/reload` when module state resets.
 */
export function isRootProcessEnv(env: NodeJS.ProcessEnv): boolean {
	return !env[ENV_PARENT_RUN_ID];
}

/**
 * Parse a depth value. Absent or non-numeric input gives 0.
 * A negative value clamps to 0.
 */
export function parseDepth(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return parsed;
}

/** True when an agent at `depth` may spawn a child. */
export function canSpawn(depth: number): boolean {
	return depth < MAX_AGENT_DEPTH;
}

/** The depth of a child spawned by an agent at `depth`. */
export function childDepth(depth: number): number {
	return depth + 1;
}

/**
 * Remove the `subagent` tool when the child would sit at or above the cap.
 * Returns a new array; never mutates the input.
 */
export function stripSpawnTool(tools: string[], depth: number): string[] {
	if (childDepth(depth) >= MAX_AGENT_DEPTH) {
		return tools.filter((tool) => tool !== "subagent");
	}
	return tools.slice();
}

/** The result of planning one spawn from the current depth. */
export interface SpawnPlan {
	allowed: boolean;
	childDepth: number;
	tools: string[];
}

/**
 * Plan a spawn from `myDepth` with `tools`. At the cap the spawn is refused and
 * the tools are unchanged. Otherwise the child depth is set and `subagent` is
 * stripped when the child would be at the cap.
 */
export function planSpawn(myDepth: number, tools: string[]): SpawnPlan {
	if (!canSpawn(myDepth)) {
		return { allowed: false, childDepth: myDepth, tools: tools.slice() };
	}
	return {
		allowed: true,
		childDepth: childDepth(myDepth),
		tools: stripSpawnTool(tools, myDepth),
	};
}

/**
 * The argv fragment for a child's locked tool set.
 *
 * An empty request means "no override". A non-empty request that strips to
 * empty passes `--no-tools`; an absent `--tools` would re-enable pi defaults.
 */
export function childToolArgs(requestedTools: string[], myDepth: number): string[] {
	if (requestedTools.length === 0) return [];
	const tools = stripSpawnTool(requestedTools, myDepth);
	if (tools.length === 0) return ["--no-tools"];
	return ["--tools", tools.join(",")];
}

let runCounter = 0;

/** A unique run id for one spawned agent process. */
export function newRunId(): string {
	runCounter += 1;
	return `${process.pid}-${runCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Env fragment that carries the child depth for a spawn from `depth`. */
export function depthEnv(depth: number): { PI_AGENT_DEPTH: string } {
	return { [ENV_AGENT_DEPTH]: String(childDepth(depth)) };
}
