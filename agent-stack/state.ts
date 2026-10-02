/**
 * Session-global agent/persona state plus persistence of `defaultAgent` /
 * `defaultPersona` in ~/.pi/agent/settings.json.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, PersonaConfig } from "./resolver.ts";

/** Shared debug-log path for the whole agent-stack extension (written by extension.ts). */
export const DEBUG_AGENT_STACK_PATH = path.join(os.tmpdir(), "pi-agent-stack-debug.log");
function debugLog(...parts: unknown[]): void {
	// Off by default; enable with PI_AGENT_STACK_DEBUG=1 in the pi process env.
	if (!process.env["PI_AGENT_STACK_DEBUG"]) return;
	try {
		fs.appendFileSync(DEBUG_AGENT_STACK_PATH, `${new Date().toISOString()} ${parts.join(" ")}\n`);
	} catch {
		/* ignore */
	}
}

let activeAgent: AgentConfig | null = null;
let activePersona: PersonaConfig | null = null;

export function getActiveAgent(): AgentConfig | null {
	return activeAgent;
}

export function setActiveAgent(agent: AgentConfig | null): void {
	debugLog("state: setActiveAgent ->", agent?.name ?? "null");
	activeAgent = agent;
}

export function getActivePersona(): PersonaConfig | null {
	return activePersona;
}

export function setActivePersona(persona: PersonaConfig | null): void {
	debugLog(
		"state: setActivePersona ->",
		persona ? (persona.theme ? `${persona.theme}/${persona.name}` : persona.name) : "null",
	);
	activePersona = persona;
}

function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Configured default agent: settings.json `defaultAgent`, else PI_DEFAULT_AGENT env. */
export function getDefaultAgentName(): string | undefined {
	const fromSettings = readSettings()["defaultAgent"];
	if (typeof fromSettings === "string" && fromSettings) return fromSettings;
	const fromEnv = process.env["PI_DEFAULT_AGENT"];
	return fromEnv || undefined;
}

/** Configured default persona: settings.json `defaultPersona`, else PI_DEFAULT_PERSONA env. */
export function getDefaultPersonaId(): string | undefined {
	const fromSettings = readSettings()["defaultPersona"];
	if (typeof fromSettings === "string" && fromSettings) return fromSettings;
	const fromEnv = process.env["PI_DEFAULT_PERSONA"];
	return fromEnv || undefined;
}

/** Persist (or clear, when value is undefined/null) an agent/persona default in settings.json. */
export async function setSetting(key: "defaultAgent" | "defaultPersona", value: string | null): Promise<void> {
	const filePath = settingsPath();
	await withFileMutationQueue(filePath, async () => {
		const settings = readSettings();
		if (value === null) delete settings[key];
		else settings[key] = value;
		await fs.promises.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	});
}