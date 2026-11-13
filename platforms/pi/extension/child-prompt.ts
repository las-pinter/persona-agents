/**
 * Child prompt text: the role a child session runs under.
 *
 * A child session loads no extension, so its `before_agent_start` hook never
 * runs. The retired spawn flags carried the same text as command-line
 * arguments. This module writes that text into the prompt instead: the
 * profession body, the always-load skill bodies, and the persona body.
 *
 * The order matches the root: profession, then skills, then persona last, so
 * the persona voice reaches the model after the role rules.
 *
 * No pi runtime import: the caller resolves the skills and the persona.
 */

import { type AgentConfig, type PersonaConfig } from "./resolver.ts";
import { type SkillRef, skillScriptsDir } from "./skill-discovery.ts";
import { personaBlock } from "./persona-text.ts";

/** Everything the child role text reads. */
export interface ChildRoleInput {
	/** The resolved agent: its name and its profession body. */
	agent: AgentConfig;
	/** The resolved persona, or null when the caller named none. */
	persona: PersonaConfig | null;
	/** The always-load skills, already matched to real files. */
	alwaysLoad: readonly SkillRef[];
	/** Patterns the agent names that resolved to no skill, so the text marks them. */
	missingPatterns?: readonly string[];
}

/** One skill's identity as the prompt shows it. */
function skillId(skill: SkillRef): string {
	return skill.group ? `${skill.group}/${skill.name}` : skill.name;
}

/**
 * The role text for one child. An agent with no fixed body still gets its name,
 * so the child knows which profession it serves.
 */
export function childRoleText(input: ChildRoleInput): string {
	const { agent, persona } = input;
	let text = `\n\n## Profession: ${agent.name}\n`;
	const body = agent.systemPrompt ?? "";
	text += body.trim().length > 0 ? body : `You are the ${agent.name} agent.`;
	for (const skill of input.alwaysLoad) {
		const scriptsDir = skillScriptsDir(skill);
		text += `\n\n## Mandatory skill: ${skillId(skill)}\n`;
		// An absolute script path keeps the gate's skill-script allow reachable.
		if (scriptsDir) text += `Scripts: ${scriptsDir} (invoke with this absolute path)\n`;
		text += skill.body;
	}
	for (const pattern of input.missingPatterns ?? []) {
		text += `\n\nMISSING skill for alwaysLoad entry: ${pattern}`;
	}
	if (persona) text += personaBlock(persona);
	return text;
}

/** The prompt one child run receives: its role text, then the task. */
export function childTaskPrompt(roleText: string, task: string): string {
	return `${roleText}\n\nTask: ${task}`;
}
