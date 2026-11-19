/**
 * Agent profiles for the Pi adapter.
 *
 * One profile per agent under the `persona-agents:` namespace. The profile
 * decides what the agent is allowed to do, and which tools it gets; the persona
 * decides only how it sounds. A Pi identity is therefore data, not code: adding
 * an agent means adding an entry here and a markdown file under agents/.
 *
 * `pi --agent persona-agents:companion` resolves at session start. An unknown
 * value refuses the session instead of guessing a profile: a silently wrong
 * profile is worse than a startup error.
 */

export const AGENT_PREFIX = "persona-agents:";
/** The theme used when neither the flag nor the settings name one. */
export { DEFAULT_THEME } from "../../shared/context/context.ts";

export type ProfileName = "companion" | "reviewer";

export interface Profile {
	/** The short name, also the profile key in the policy file. */
	name: ProfileName;
	/** The full agent id, as passed to --agent. */
	id: string;
	/**
	 * The content/professions file that holds the work rules, or null for an
	 * agent whose prompt is its own agent file (the reviewer, as a subagent).
	 */
	profession: string | null;
	/** Whether the theme persona is added to the prompt. */
	persona: boolean;
	/** Whether the agent may change files. */
	writable: boolean;
	/** Tools added to the user's active selection. */
	require: readonly string[];
	/** Tools removed from the user's active selection. */
	drop: readonly string[];
}

const COMPANION: Profile = {
	name: "companion",
	id: `${AGENT_PREFIX}companion`,
	profession: "companion",
	persona: true,
	writable: true,
	require: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	drop: [],
};

const REVIEWER: Profile = {
	name: "reviewer",
	id: `${AGENT_PREFIX}reviewer`,
	profession: null,
	persona: false,
	writable: false,
	// Bash is kept for the one test run the reviewer reports; the policy denies
	// every write it can see, so the read-only contract holds two ways.
	require: ["read", "grep", "find", "ls", "bash"],
	drop: ["edit", "write"],
};

/** Every known profile, by short name. */
export const PROFILES: Record<ProfileName, Profile> = { companion: COMPANION, reviewer: REVIEWER };

/**
 * The profiles a Pi session can run as the main agent. The reviewer is a
 * subagent: it may be started directly (useful for testing the gate), but it is
 * not advertised as a session type.
 */
export const SESSION_PROFILES: readonly Profile[] = [COMPANION];

/** True when the value names an agent of this package. */
export function isAgentId(value: string): boolean {
	return value.startsWith(AGENT_PREFIX);
}

/** The profile for an agent id, or null when the id is not one of ours. */
export function profileOf(value: string | undefined | null): Profile | null {
	if (typeof value !== "string" || !isAgentId(value)) return null;
	const name = value.slice(AGENT_PREFIX.length);
	return name in PROFILES ? PROFILES[name as ProfileName] : null;
}

/** The profiles as an error message lists them. */
export function profileIds(): string[] {
	return Object.values(PROFILES).map((profile) => profile.id);
}

/**
 * Resolve the agent id of a session. Null means "not our agent": a plain Pi
 * session keeps its default behavior and the extension stays inert.
 * Throws for an id in our namespace that names no profile.
 */
export function resolveProfile(value: string | undefined | null): Profile | null {
	const profile = profileOf(value);
	if (profile || typeof value !== "string" || !isAgentId(value)) return profile;
	throw new Error(`persona-agents: unknown agent "${value}"; known agents: ${profileIds().join(", ")}`);
}
