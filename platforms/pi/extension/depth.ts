/**
 * Agent nesting depth — pure helpers.
 *
 * A child runs in this process, so its depth comes from the run record walk.
 * The process env carries the depth of a launch that an outer process started.
 *
 * No pi import: this module is pure so `depth.test.ts` needs no runtime.
 */

/** Maximum nesting depth: levels 0, 1, 2. A level-2 agent may not spawn. */
export const MAX_AGENT_DEPTH = 2;

/** The refusal text for a spawn at the cap. One text serves every caller. */
export const DEPTH_CAP_REASON = `Depth cap reached (level ${MAX_AGENT_DEPTH}): subagents cannot spawn further subagents.`;

/** The spawn tool name. The registration and the strip both read it. */
export const SPAWN_TOOL_NAME = "subagent";

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
 * An in-process child shares this env, so no spawn sets the parent run id here.
 * Only an outer launch sets it, and that launch, not this one, owns the log. Do
 * not test `PI_AGENT_RUN_ID`: the root sets it on its own env, and it survives
 * `/reload` when module state resets.
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

/** The one registry call a depth read needs: walk one session id to its root. */
export interface DepthWalkSource {
	walk(sessionId: string): { ok: true; depth: number } | { ok: false };
}

/**
 * The walked depth of `parentSessionId`, or the cap when the walk fails.
 *
 * A broken chain must not read as a shallow one, so an absent id and a failed
 * walk both answer the cap. A caller then refuses the spawn or strips the tool.
 */
export function resolvedDepth(registry: DepthWalkSource, parentSessionId: string | null): number {
	if (parentSessionId === null) return MAX_AGENT_DEPTH;
	const walk = registry.walk(parentSessionId);
	return walk.ok ? walk.depth : MAX_AGENT_DEPTH;
}

/**
 * Remove the spawn tool when the child would sit at or above the cap.
 * Returns a new array; never mutates the input.
 */
export function stripSpawnTool(tools: string[], depth: number): string[] {
	if (childDepth(depth) >= MAX_AGENT_DEPTH) {
		return tools.filter((tool) => tool !== SPAWN_TOOL_NAME);
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
 * the tools are unchanged. Otherwise the child depth is set and the spawn tool is
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

let runCounter = 0;

/** A unique run id for one agent run in this process. */
export function newRunId(): string {
	runCounter += 1;
	return `${process.pid}-${runCounter}-${Math.random().toString(36).slice(2, 10)}`;
}
