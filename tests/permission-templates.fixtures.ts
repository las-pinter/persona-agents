/**
 * Shared fixtures and helpers for the permission-template regression suite.
 *
 * The engine verdict helpers mirror the permission gate on each stack; the
 * shared agent lists and the rule matcher back every split test file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	compileRegex,
	evaluateCommandRules,
	type Decision,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "../platforms/pi/extension/command-segments.ts";

export const frontmatterDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../platforms/pi/frontmatters",
);

export interface FrontmatterPermissions {
	mode?: string;
	allow?: RawRule[];
	ask?: RawRule[];
	deny?: RawRule[];
}

/** Read one shipped pi frontmatter and map its rules onto gate `RuleSets`. */
export function loadAgentRules(agent: string): { mode: PermissionMode; ruleSets: RuleSets } {
	const content = fs.readFileSync(path.join(frontmatterDir, `${agent}.yaml`), "utf-8");
	const { frontmatter } = parseFrontmatter<{ permissions?: FrontmatterPermissions }>(
		`---\n${content}\n---\n`,
	);
	const perms = frontmatter.permissions ?? {};
	return {
		mode: perms.mode === "deny-by-default" ? "deny-by-default" : "allow-unless-matched",
		ruleSets: {
			globalDeny: [],
			globalAsk: [],
			agentDeny: perms.deny ?? [],
			agentAsk: perms.ask ?? [],
			agentAllow: perms.allow ?? [],
		},
	};
}

/** Verdict kind for one agent + one bash command. */
export function verdict(agent: string, command: string): Decision["kind"] {
	const { mode, ruleSets } = loadAgentRules(agent);
	return evaluateCommandRules(command, true, ruleSets, mode, "bash", agent).kind;
}

/** Verdict kind for one agent + one read-tool path. */
export function readVerdict(agent: string, filePath: string): Decision["kind"] {
	const { mode, ruleSets } = loadAgentRules(agent);
	return evaluateCommandRules(filePath, false, ruleSets, mode, "read", agent).kind;
}


export const OTHER_AGENTS = ["researcher", "reviewer", "tester", "planner", "mascot"];
// Mascot has no bash tool. Bash behavior matrices skip it: deny-by-default still
// denies it, but the kind is `default`, not an explicit `deny` rule.
export const PI_SHELL_AGENTS = OTHER_AGENTS.filter((agent) => agent !== "mascot");

/** Path of the live global permissions file (the user's file). */
export function liveGlobalPath(): string {
	return process.env.PI_PERMISSIONS_FILE ?? path.join(getAgentDir(), "permissions.json");
}

/**
 * Load the live global file into a `RuleSets` with no agent rules, so a verdict
 * reflects the global file alone. Returns null when the file is absent.
 */
export function loadGlobalRuleSets(): RuleSets | null {
	if (!fs.existsSync(liveGlobalPath())) return null;
	const cfg = JSON.parse(fs.readFileSync(liveGlobalPath(), "utf-8")) as {
		deny?: RawRule[];
		ask?: RawRule[];
	};
	return {
		globalDeny: cfg.deny ?? [],
		globalAsk: cfg.ask ?? [],
		agentDeny: [],
		agentAsk: [],
		agentAllow: [],
	};
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Mirror of opencode's `Wildcard.match`: escape regex specials, `*` -> `.*`,
 * `?` -> `.`, and a trailing " .*" becomes optional. Anchored, dotall.
 */
function opencodeGlob(pattern: string, value: string): boolean {
	let body = pattern
		.replaceAll("\\", "/")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	if (body.endsWith(" .*")) body = `${body.slice(0, -3)}( .*)?`;
	return new RegExp(`^${body}$`, "s").test(value.replaceAll("\\", "/"));
}

export interface OpenCodeRule {
	action: string;
	resource: string;
	effect: string;
}

export function loadOpenCodeRules(agent: string): OpenCodeRule[] {
	const content = fs.readFileSync(
		path.join(repoRoot, "platforms/opencode/frontmatters", `${agent}.yaml`),
		"utf-8",
	);
	const { frontmatter } = parseFrontmatter<{
		permissions?: OpenCodeRule[];
		permission?: { bash?: Record<string, string> };
	}>(`---\n${content}\n---\n`);
	const rules: OpenCodeRule[] = [...(frontmatter.permissions ?? [])];
	for (const [resource, effect] of Object.entries(frontmatter.permission?.bash ?? {})) {
		rules.push({ action: "shell", resource, effect: String(effect) });
	}
	return rules;
}

/** opencode uses findLast: the last matching rule wins; no match is `ask`. */
export function opencodeVerdict(agent: string, command: string): string {
	const rules = loadOpenCodeRules(agent);
	for (let idx = rules.length - 1; idx >= 0; idx--) {
		const rule = rules[idx];
		if (opencodeGlob(rule.action, "shell") && opencodeGlob(rule.resource, command)) return rule.effect;
	}
	return "ask";
}

/** opencode last-match verdict for any action/resource pair (e.g. edit paths). */
export function opencodeResourceVerdict(agent: string, action: string, resource: string): string {
	const rules = loadOpenCodeRules(agent);
	for (let idx = rules.length - 1; idx >= 0; idx--) {
		const rule = rules[idx];
		if (opencodeGlob(rule.action, action) && opencodeGlob(rule.resource, resource)) return rule.effect;
	}
	return "ask";
}

/** True when the agent's rules carry an exact shell rule (action, resource, effect). */
export function hasOpenCodeRule(agent: string, resource: string, effect: string): boolean {
	return loadOpenCodeRules(agent).some(
		(rule) => rule.action === "shell" && rule.resource === resource && rule.effect === effect,
	);
}

/** Mirror of kiro's globset: `*` -> `.*`, `?` -> `.`, anchored, no optional trailing. */
export function kiroGlob(pattern: string, value: string): boolean {
	const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${body}$`, "s").test(value);
}

export function kiroVerdict(agent: string, command: string): string {
	const cfg = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "platforms/kiro/templates", `${agent}.json`), "utf-8"),
	) as { toolsSettings?: { shell?: { allowedCommands?: string[]; deniedCommands?: string[] } } };
	const shell = cfg.toolsSettings?.shell ?? {};
	if ((shell.deniedCommands ?? []).some((pattern) => kiroGlob(pattern, command))) return "deny";
	if ((shell.allowedCommands ?? []).some((pattern) => kiroGlob(pattern, command))) return "allow";
	return "ask";
}

export interface KiroAgentConfig {
	tools?: string[];
	allowedTools?: string[];
	toolsSettings?: { shell?: { allowedCommands?: string[]; deniedCommands?: string[] } };
}

export function loadKiroConfig(agent: string): KiroAgentConfig {
	return JSON.parse(
		fs.readFileSync(path.join(repoRoot, "platforms/kiro/templates", `${agent}.json`), "utf-8"),
	) as KiroAgentConfig;
}

export function kiroDeniedCommands(agent: string): string[] {
	return loadKiroConfig(agent).toolsSettings?.shell?.deniedCommands ?? [];
}

/** True when a kiro agent denies an exact command pattern. */
export function hasKiroDeny(agent: string, pattern: string): boolean {
	return kiroDeniedCommands(agent).includes(pattern);
}

/** kiro grants the shell tool only when `tools` or `allowedTools` lists it. */
export function kiroHasShellTool(agent: string): boolean {
	const cfg = loadKiroConfig(agent);
	return (cfg.tools ?? []).includes("shell") || (cfg.allowedTools ?? []).includes("shell");
}

/** kiro silently allows only the tools in `allowedTools`; others default to ask. */
export function kiroAllowedTools(agent: string): string[] {
	return loadKiroConfig(agent).allowedTools ?? [];
}

/** pi grants a tool only when the frontmatter lists it in `tools`. */
export function piHasBashTool(agent: string): boolean {
	const content = fs.readFileSync(path.join(frontmatterDir, `${agent}.yaml`), "utf-8");
	const { frontmatter } = parseFrontmatter<{ tools?: string[] }>(`---\n${content}\n---\n`);
	return (frontmatter.tools ?? []).includes("bash");
}

export const OPENCODE_AGENTS = [
	"implementer",
	"researcher",
	"reviewer",
	"tester",
	"planner",
	"mascot",
];
export const KIRO_AGENTS = [...OPENCODE_AGENTS];
// Mascot grants no shell command on opencode (the base `*:*` rule denies) and has
// no shell tool on kiro. Shell behavior matrices run on the shell-capable agents.
export const OPENCODE_SHELL_AGENTS = OPENCODE_AGENTS.filter((agent) => agent !== "mascot");
export const KIRO_SHELL_AGENTS = KIRO_AGENTS.filter((agent) => agent !== "mascot");

export function ruleSetMatches(rules: RawRule[], command: string): boolean {
	return rules.some((rule) => {
		const tool = rule.tool ?? "*";
		return (tool === "*" || tool === "bash") && compileRegex(rule.match).test(command);
	});
}
