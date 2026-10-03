/**
 * Slash commands: /agents and /persona.
 *
 *   /agents              list discovered agents (user, project, package)
 *   /agents <name>       activate agent for this + future sessions (persisted)
 *   /agents <name> -persona <id|off>   activate agent and set persona in one call
 *   /agents off          deactivate
 *
 *   /persona             list personas (theme/name)
 *   /persona <id>        activate persona (id = "theme/name", "name", or "theme")
 *   /persona off         remove persona
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	discoverAgents,
	discoverSkills,
	formatPersonaId,
	matchSkills,
	personaId,
	resolveAgentAlias,
	resolvePersonaForAgent,
} from "./resolver.ts";
import { getActiveAgent, setActiveAgent, setActivePersona, setSetting } from "./state.ts";

/** Parse "/agents <name> [-persona <id|off>]" into its parts. */
function parseAgentArgs(args: string): { agentArg: string; personaArg?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const flagIdx = tokens.findIndex((t) => /^-{1,2}persona$/i.test(t));
	if (flagIdx === -1) return { agentArg: tokens.join(" ") };
	return {
		agentArg: tokens.slice(0, flagIdx).join(" "),
		personaArg: tokens[flagIdx + 1] ?? "off",
	};
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("agents", {
		description: "List or activate agents (usage: /agents [name|off] [-persona theme/name|off])",
		handler: async (args: string, ctx) => {
			const { agentArg, personaArg } = parseAgentArgs(args);
			const discovery = discoverAgents(ctx.cwd, "both");

			if (!agentArg) {
				if (discovery.agents.length === 0) {
					ctx.ui?.notify?.("No agents found.", "info");
					return;
				}
				const list = discovery.agents
					.map((a) => `${a.name} (${a.source})${a.persona ? ` · persona: ${a.persona}` : ""}`)
					.join("\n");
				ctx.ui?.notify?.(`Agents:\n${list}\n\nUse /agents <name> to activate.`, "info");
				return;
			}

			if (agentArg === "off") {
				setActiveAgent(null);
				await setSetting("defaultAgent", null);
				ctx.ui?.setStatus?.("agent", undefined);
				ctx.ui?.notify?.("Agent deactivated.", "info");
				return;
			}

			const resolvedTarget = resolveAgentAlias(agentArg, discovery.agents, discovery.personas);
			const agent = resolvedTarget?.agent ?? null;
			if (!agent) {
				ctx.ui?.notify?.(
					`Unknown agent "${agentArg}". Available: ${discovery.agents.map((a) => a.name).join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			// A theme-profession alias (goblin-mascot) implies the theme persona
			// unless an explicit -persona flag overrides it.
			const effectivePersonaArg = personaArg ?? resolvedTarget?.theme;

			setActiveAgent(agent);
			ctx.ui?.setStatus?.("agent", `agent: ${agent.name}`);
			await setSetting("defaultAgent", agent.name);

			// Persona handling: explicit -persona flag (or alias theme) wins; otherwise
			// the agent's declared default persona applies.
			if (effectivePersonaArg !== undefined) {
				if (effectivePersonaArg === "off" || effectivePersonaArg === "none") {
					setActivePersona(null);
					await setSetting("defaultPersona", null);
					ctx.ui?.setStatus?.("persona", undefined);
				} else {
					const persona = resolvePersonaForAgent(discovery.personas, effectivePersonaArg, agent.name);
					if (persona) {
						setActivePersona(persona);
						ctx.ui?.setStatus?.("persona", `persona: ${formatPersonaId(persona)}`);
						await setSetting("defaultPersona", personaId(persona));
					} else {
						ctx.ui?.notify?.(`Unknown persona "${effectivePersonaArg}".`, "warning");
					}
				}
			} else if (agent.persona) {
				const persona = resolvePersonaForAgent(discovery.personas, agent.persona, agent.name);
				if (persona) {
					setActivePersona(persona);
					ctx.ui?.setStatus?.("persona", `persona: ${formatPersonaId(persona)}`);
					await setSetting("defaultPersona", personaId(persona));
				}
			}

			ctx.ui?.notify?.(
				`Agent activated: ${agent.name} (${agent.source})\nTakes effect on the next agent run.\nTip: run /new first in a long session so the new voice and rules are not drowned out by earlier plain conversation.`,
				"info",
			);
		},
	});

	pi.registerCommand("persona", {
		description: "List or activate personas (usage: /persona [theme/name|off])",
		handler: async (args: string, ctx) => {
			const arg = args.trim();
			const discovery = discoverAgents(ctx.cwd, "user");

			if (!arg) {
				if (discovery.personas.length === 0) {
					ctx.ui?.notify?.("No personas found.", "info");
					return;
				}
				const byTheme = new Map<string, string[]>();
				for (const p of discovery.personas) {
					const bucket = p.theme ?? "(root)";
					const existing = byTheme.get(bucket) ?? [];
					existing.push(formatPersonaId(p));
					byTheme.set(bucket, existing);
				}
				const list = Array.from(byTheme.entries())
					.map(([theme, ids]) => `${theme}: ${ids.join(", ")}`)
					.join("\n");
				ctx.ui?.notify?.(`Personas:\n${list}\n\nUse /persona <theme/name> to activate.`, "info");
				return;
			}

			if (arg === "off" || arg === "none") {
				setActivePersona(null);
				await setSetting("defaultPersona", null);
				ctx.ui?.setStatus?.("persona", undefined);
				ctx.ui?.notify?.("Persona removed.", "info");
				return;
			}

			const persona = resolvePersonaForAgent(discovery.personas, arg, getActiveAgent()?.name);
			if (!persona) {
				ctx.ui?.notify?.(`Unknown persona "${arg}".`, "warning");
				return;
			}

			setActivePersona(persona);
			ctx.ui?.setStatus?.("persona", `persona: ${formatPersonaId(persona)}`);
			await setSetting("defaultPersona", personaId(persona));
			ctx.ui?.notify?.(
				`Persona activated: ${formatPersonaId(persona)}\nTip: run /new first — in a long session earlier plain replies can outvote the persona.`,
				"info",
			);
		},
	});

	pi.registerCommand("skills", {
		description: "List discovered skills (usage: /skills [agent])",
		handler: async (args: string, ctx) => {
			const arg = args.trim();
			const skills = discoverSkills(ctx.cwd);

			if (!arg) {
				if (skills.length === 0) {
					ctx.ui?.notify?.("No skills found.", "info");
					return;
				}
				const list = skills
					.map((s) => `${s.group ? s.group + "/" : ""}${s.name} — ${s.description ?? ""}`)
					.join("\n");
				ctx.ui?.notify?.(`Skills (${skills.length}):\n${list}`, "info");
				return;
			}

			const discovery = discoverAgents(ctx.cwd, "both");
			const agent = discovery.agents.find((a) => a.name === arg);
			if (!agent) {
				ctx.ui?.notify?.(`Unknown agent "${arg}".`, "warning");
				return;
			}
			const matched = matchSkills(agent.skills, skills);
			ctx.ui?.notify?.(
				`Agent "${agent.name}" skills patterns: ${(agent.skills ?? []).join(", ") || "none"}\n` +
					`Loaded (${matched.length}): ${matched
						.map((s) => (s.group ? `${s.group}/${s.name}` : s.name))
						.join(", ") || "none"}`,
				"info",
			);
		},
	});
}