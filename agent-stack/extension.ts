/**
 * persona-agents — single-entry pi extension.
 *
 * Provides:
 *   - subagent tool (single / parallel / chain), agents from user/project/package
 *   - per-agent frontmatter permissions (deny-by-default + regex allow lists)
 *   - /agents and /persona commands (+ persisted defaultAgent / defaultPersona)
 *   - default agent/persona applied to the main session via before_agent_start
 *
 * Install:
 *   pi install ~/persona-agents                                (development)
 *   pi install git:github.com/las-pinter/persona-agents@<ref>  (distribution — PIN a
 *     release tag; unpinned git clones the repo's default branch, no pi work)
 */

import * as fs from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEBUG_AGENT_STACK_PATH } from "./state.ts";

function debugLog(...parts: unknown[]): void {
	// Off by default; enable with PI_AGENT_STACK_DEBUG=1 in the pi process env.
	if (!process.env["PI_AGENT_STACK_DEBUG"]) return;
	try {
		fs.appendFileSync(DEBUG_AGENT_STACK_PATH, `${new Date().toISOString()} ${parts.join(" ")}\n`);
	} catch {
		/* ignore */
	}
}

const MODULE_LOAD_ID = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

// Tunable budgets, not yet settings-backed.
const SKILL_INJECTION_BUDGET_BYTES = 24 * 1024;
const SKILL_BODY_CAP_BYTES = 12 * 1024;

import { registerCommands } from "./commands.ts";
import { registerInspectorCommands } from "./inspector.ts";
import { installPermissionGate } from "./permissions.ts";
import { getActiveAgent, getActivePersona } from "./state.ts";
import {
	discoverAgents,
	discoverSkills,
	matchSkills,
	resolvePersonaForAgent,
	resolveResources,
} from "./resolver.ts";
import { getDefaultAgentName, getDefaultPersonaId, setActiveAgent, setActivePersona } from "./state.ts";
import registerSubagentTool from "./subagent.ts";

export default function (pi: ExtensionAPI): void {
	debugLog(`factory enter module=${MODULE_LOAD_ID} pid=${process.pid}`);

	// 1. Permission gate on every tool call (global + active agent frontmatter).
	installPermissionGate(pi, getActiveAgent);

	// 2. Slash commands.
	registerCommands(pi);
	registerInspectorCommands(pi);

	// 3. Orchestrator tool (spawn-based subagents, isolated contexts).
	registerSubagentTool(pi);

	// 4. Apply configured defaults when a session starts.
	// CLI flags: `pi --agent orchestrator --persona goblin/bossnik-chief`.
	// Pi parses extension-registered flags before the session starts.
	pi.registerFlag("agent", { description: "Start session as this agent (name from agents/)", type: "string" });
	pi.registerFlag("persona", { description: "Start session with this persona (theme/name)", type: "string" });

	const cliFlag = (name: string): string | undefined => {
		try {
			const v = pi.getFlag(name);
			if (typeof v === "string" && v) return v;
		} catch {
			/* getFlag may not be resolvable in every entrypoint */
		}
		return undefined;
	};

	/**
	 * Apply configured defaults (CLI flags > settings/env). Runs at extension
	 * factory time (survives /reload, which re-runs the factory) and again at
	 * session_start (which knows the cwd, so project agents resolve too).
	 */
	const applyDefaults = (cwd: string | undefined) => {
		const discovery = cwd ? discoverAgents(cwd, "both") : discoverAgents(getAgentDir(), "both");

		// CLI flags may not be parsed yet when the factory runs, so session_start
		// re-applies: without the "already active" guards, flag values (including
		// "off") can correct whatever the factory activated from settings.
		const flagAgent = cliFlag("agent");
		const defaultAgentName = flagAgent ?? getDefaultAgentName();
		if (flagAgent === "off") {
			setActiveAgent(null);
		} else if (defaultAgentName && defaultAgentName !== "off") {
			const agent = discovery.agents.find((a) => a.name === defaultAgentName);
			if (agent) {
				setActiveAgent(agent);
				debugLog("defaults: activated agent", agent.name);
				if (agent.persona) {
					const persona = resolvePersonaForAgent(discovery.personas, agent.persona, agent.name);
					if (persona) setActivePersona(persona);
				}
			}
		}

		const flagPersona = cliFlag("persona");
		const defaultPersonaId = flagPersona ?? getDefaultPersonaId();
		if (flagPersona === "off") {
			setActivePersona(null);
		} else if (defaultPersonaId && defaultPersonaId !== "off") {
			const persona = resolvePersonaForAgent(discovery.personas, defaultPersonaId, getActiveAgent()?.name);
			if (persona) {
				setActivePersona(persona);
				debugLog("defaults: activated persona", defaultPersonaId);
			}
		}
	};

	// Factory-time: survives /reload even though session_start does not re-fire.
	applyDefaults(undefined);

	/** Reflect the active agent/persona in the footer status bar. */
	const syncStatus = (ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined) => {
		if (!ctx?.ui?.setStatus) return;
		const agent = getActiveAgent();
		const persona = getActivePersona();
		ctx.ui.setStatus("agent", agent ? `agent: ${agent.name}` : undefined);
		ctx.ui.setStatus(
			"persona",
			persona ? `persona: ${persona.theme ? `${persona.theme}/${persona.name}` : persona.name}` : undefined,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		debugLog("session_start cwd=", ctx.cwd);
		applyDefaults(ctx.cwd);
		syncStatus(ctx);
	});

	// 5. Inject agent + persona prompts ahead of every agent run.
	pi.on("before_agent_start", async (event, ctx) => {
		const agent = getActiveAgent();
		const persona = getActivePersona();
		debugLog(
			"before_agent_start agent=",
			agent?.name ?? "none",
			"persona=",
			persona ? `${persona.theme}/${persona.name}` : "none",
			"personaBodyLen=",
			persona?.body?.length ?? 0,
			"baseLen=",
			event.systemPrompt?.length ?? 0,
		);
		if (!agent && !persona) return undefined;

		let extra = "";
		if (agent) {
			extra += `\n\n${agent.systemPrompt}`;

			// Shared dedup: a skill in both lists is injected once (alwaysLoad wins).
			const seen = new Set<string>();
			const discoveredSkills = discoverSkills(ctx.cwd);

			// P3: bind the agent's `alwaysLoad:` globs. Mandatory skills warn
			// loudly when missing or oversized — never drop a steering skill silently.
			const mandatory = matchSkills(agent.alwaysLoad ?? [], discoveredSkills);
			if (agent.alwaysLoad && agent.alwaysLoad.length > 0) {
				let mandatoryBudget = SKILL_INJECTION_BUDGET_BYTES;
				for (const s of mandatory) {
					const id = s.group ? `${s.group}/${s.name}` : s.name;
					if (seen.has(id)) continue;
					seen.add(id);
					let body = s.body;
					if (body.length > SKILL_BODY_CAP_BYTES) {
						console.warn(`agent-stack: mandatory skill ${id} exceeds the ${SKILL_BODY_CAP_BYTES} byte body cap; truncated`);
						body = `${body.slice(0, SKILL_BODY_CAP_BYTES)}\n>> SKILL TRUNCATED: ${id}`;
					}
					if (mandatoryBudget - body.length < 0) {
						console.warn(`agent-stack: mandatory skill ${id} would exceed the ${SKILL_INJECTION_BUDGET_BYTES} byte budget; body omitted`);
						extra += `\n\n## Mandatory skill: ${id}\n>> SKILL TRUNCATED: ${id}`;
						continue;
					}
					mandatoryBudget -= body.length;
					extra += `\n\n## Mandatory skill: ${id}\n${body}`;
				}
				for (const pattern of agent.alwaysLoad) {
					if (matchSkills([pattern], discoveredSkills).length === 0) {
						console.warn(`agent-stack: alwaysLoad entry resolves to no skill: ${pattern}`);
						extra += `\n\nMISSING skill for alwaysLoad entry: ${pattern}`;
					}
				}
				debugLog("alwaysLoad injected:", Array.from(seen).join(","));
			}

			// P3: bind the agent's `skills:` globs (package + user + project).
			const skills = matchSkills(agent.skills, discoveredSkills);
			if (skills.length > 0) {
				extra += `\n\n## Agent skills for "${agent.name}"`;
				let budget = SKILL_INJECTION_BUDGET_BYTES;
				for (const s of skills) {
					const id = s.group ? `${s.group}/${s.name}` : s.name;
					if (seen.has(id)) continue;
					seen.add(id);
					const body = s.body.length > SKILL_BODY_CAP_BYTES ? `${s.body.slice(0, SKILL_BODY_CAP_BYTES)}\n<!-- (truncated) -->` : s.body;
					budget -= body.length;
					if (budget < 0) break;
					extra += `\n\n### Skill: ${id}\n${body}`;
				}
				debugLog("skills injected:", Array.from(seen).join(","));
			}

			// P3: bind the agent's `resources:` globs relative to the cwd.
			const resources = resolveResources(agent.resources, ctx.cwd);
			if (resources.inlined.length > 0 || resources.paths.length > 0) {
				extra += `\n\n## Agent resources for "${agent.name}"`;
				for (const r of resources.inlined) extra += `\n\n### ${r.path}\n${r.content}`;
				if (resources.paths.length > 0) {
					extra += `\n\nLarge matched files (read what you need):`;
					for (const p of resources.paths.slice(0, 20)) extra += `\n- ${p}`;
				}
				debugLog(
					"resources injected:",
					resources.inlined.length,
					"inlined,",
					resources.paths.length,
					"paths",
				);
			}
		}
		if (persona) {
			extra += `\n\n## PERSONA (MANDATORY VOICE)\n`;
			extra += `Ignore any earlier plain-voice context. From now on you ARE the persona below.\n`;
			extra += `Adopt its speech patterns and role in every reply, until the persona changes.\n\n${persona.body}`;
		}
		debugLog("injecting; extraLen=", extra.length);

		syncStatus(ctx);
		return { systemPrompt: `${event.systemPrompt}${extra}` };
	});
}