/**
 * The agents.json persona lookup: theme ↔ profession ↔ persona mapping.
 *
 * Reads <package root>/content/agents.json through the package layout. The
 * agent and persona types come in by type-only import, so this module adds no
 * runtime edge to agent discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getPackageRoot, PACKAGE_LAYOUT } from "./package-layout.ts";
import type { AgentConfig } from "./resolver.ts";
import type { PersonaConfig } from "./persona-loader.ts";

// ---------------------------------------------------------------------------
// agents.json theme ↔ profession ↔ persona mapping
//   {"goblin": {"orchestrator": {"personaFile": "bossnik-chief.md", ...}, ...}}
// ---------------------------------------------------------------------------

interface AgentsJsonShape {
	[theme: string]: {
		[profession: string]: { personaFile?: unknown } | undefined;
	} | undefined;
}

let agentsJsonMap: Map<string, Map<string, string>> | null | undefined;

function loadAgentsJson(): Map<string, Map<string, string>> | null {
	if (agentsJsonMap !== undefined) return agentsJsonMap;
	agentsJsonMap = null;
	const root = getPackageRoot();
	if (!root) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(root, PACKAGE_LAYOUT.agentsJson), "utf-8")) as AgentsJsonShape;
		const outer = new Map<string, Map<string, string>>();
		for (const [theme, professions] of Object.entries(raw)) {
			const inner = new Map<string, string>();
			for (const [profession, info] of Object.entries(professions ?? {})) {
				if (typeof info?.personaFile === "string") {
					inner.set(profession, info.personaFile.replace(/\.md$/, ""));
				}
			}
			if (inner.size > 0) outer.set(theme, inner);
		}
		agentsJsonMap = outer;
	} catch {
		agentsJsonMap = null;
	}
	return agentsJsonMap;
}

/** The persona agents.json assigns to a (theme, profession) pair, if it exists. */
export function personaForThemeProfession(
	theme: string,
	profession: string,
	personas: PersonaConfig[],
): PersonaConfig | null {
	const stem = loadAgentsJson()?.get(theme)?.get(profession);
	if (!stem) return null;
	return (
		personas.find((p) => p.theme === theme && (p.name === stem || p.fileNameStem === stem)) ??
		personas.find((p) => p.theme === theme && p.fileNameStem === stem) ??
		null
	);
}

/**
 * Resolve an agent reference that may be a "theme-profession" alias from the
 * kiro/opencode ecosystem (e.g. "goblin-mascot" -> mascot agent + goblin theme).
 */
export function resolveAgentAlias(
	alias: string,
	agents: AgentConfig[],
	personas: PersonaConfig[],
): { agent: AgentConfig; theme?: string } | null {
	const direct = agents.find((a) => a.name === alias);
	if (direct) return { agent: direct };

	const dash = alias.indexOf("-");
	if (dash > 0 && dash < alias.length - 1) {
		const theme = alias.slice(0, dash);
		const profession = alias.slice(dash + 1);
		const isTheme = personas.some((p) => p.theme === theme) || loadAgentsJson()?.has(theme);
		if (isTheme) {
			const agent = agents.find((a) => a.name === profession);
			if (agent) return { agent, theme };
		}
	}
	return null;
}

/**
 * Match a persona reference against a persona list, theme-aware.
 *
 * Priority:
 *   1. explicit "theme/name" (name or filename stem)
 *   2. bare persona name
 *   3. type personas.json mapping for (ref=theme, agentName=profession)
 *   4. fallback: first persona in the theme
 */
export function resolvePersonaForAgent(
	personas: PersonaConfig[],
	ref: string | undefined,
	agentName?: string,
): PersonaConfig | null {
	if (!ref || ref === "none" || ref === "off") return null;

	if (ref.includes("/")) {
		const [theme, name] = ref.split("/", 2);
		for (const p of personas) {
			if (p.theme === theme && (p.name === name || p.fileNameStem === name)) return p;
		}
		return null;
	}

	for (const p of personas) {
		if (p.name === ref) return p;
	}

	if (agentName) {
		const mapped = personaForThemeProfession(ref, agentName, personas);
		if (mapped) return mapped;
	}

	for (const p of personas) {
		if (p.theme === ref) return p;
	}
	return null;
}
