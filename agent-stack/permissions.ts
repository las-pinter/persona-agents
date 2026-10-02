/**
 * Permission gate for agent frontmatter rules + the global permissions.json.
 *
 * Every tool call the model makes is checked against:
 *
 *   1. global hard rules  (~/.pi/agent/permissions.json `deny`)   – always win
 *   2. global ask rules   (~/.pi/agent/permissions.json `ask`)
 *   3. active agent rules (agent frontmatter `permissions.deny`)
 *   4. active agent rules (agent frontmatter `permissions.ask`)
 *   5. active agent rules (agent frontmatter `permissions.allow`)
 *   6. `permissions.mode` default:
 *        - "deny-by-default":       anything not allowed is blocked
 *        - "allow-unless-matched":  anything not matched runs (Pi's default)
 *
 * Ask rules (steps 2 and 4) GRANT the single call when the user approves the
 * prompt: they are a manual override for things the allow list does not cover.
 * Deny rules (steps 1 and 3) always win; headless runs (no UI) treat ask as a
 * hard block.
 *
 * Rule shape (global file or frontmatter):
 *   { "tool": "bash", "match": "\\brm\\s+-rf\\b", "reason": "optional" }
 *
 * `tool` is optional (matches every tool). `match` is a JavaScript regex
 * tested against the tool's target: bash/powershell -> the command,
 * read/grep/find/ls/edit/write -> the path, other tools -> the JSON arguments.
 *
 * Run /reload after editing permissions.json or agent frontmatter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, PermissionRule } from "./resolver.ts";

interface CompiledRule {
	tool: string;
	re: RegExp;
	rule: PermissionRule;
}

/**
 * Compiled-regex cache for the gate hot path: patterns are recompiled on every
 * tool call today (`compile()` runs per call for agent rules). Compile once per
 * pattern string and reuse. Semantics are identical (unanchored, case-insensitive,
 * non-global — `.test()` never advances a `lastIndex`).
 */
const regexCache = new Map<string, RegExp>();

function compileRegex(pattern: string): RegExp {
	let re = regexCache.get(pattern);
	if (!re) {
		re = new RegExp(pattern, "i");
		regexCache.set(pattern, re);
	}
	return re;
}

function configPath(): string {
	if (process.env.PI_PERMISSIONS_FILE) return process.env.PI_PERMISSIONS_FILE;
	return path.join(getAgentDir(), "permissions.json");
}

function compile(rules: PermissionRule[] | undefined): CompiledRule[] {
	return (rules ?? [])
		.filter((r) => r && typeof r.match === "string" && r.match)
		.map((rule) => ({ tool: rule.tool ?? "*", re: compileRegex(rule.match), rule }));
}

function probeFor(toolName: string, input: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
		case "powershell":
			return String(input.command ?? "");
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "edit":
		case "write":
			return String(input.path ?? input.pattern ?? input.glob ?? "");
		default:
			return JSON.stringify(input);
	}
}

export function installPermissionGate(
	pi: ExtensionAPI,
	getActiveAgent: () => AgentConfig | null,
): void {
	let globalRules: { deny: CompiledRule[]; ask: CompiledRule[] } | null = null;

	const loadGlobal = () => {
		try {
			const cfg = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as {
				deny?: PermissionRule[];
				ask?: PermissionRule[];
			};
			globalRules = { deny: compile(cfg.deny), ask: compile(cfg.ask) };
		} catch {
			globalRules = { deny: [], ask: [] };
		}
	};
	loadGlobal();
	// /reload re-runs this factory (via the extension runner), which re-reads the
	// global rules from disk again - no per-tool-call reload is needed here.

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (toolName.startsWith("mcp__") || toolName.includes(".")) return undefined;

		// MCP and namespaced tools (mcp__context7__…, server.tool, …) are never
		// gated by this regex gate — deliberate: they are research/read-only
		// services or extension namespaces, and child subagents are already
		// limited to their `tools:` loadout via `--tools`. The gate exists to
		// constrain bash/read/edit/write/etc. tool calls.
		const probe = probeFor(toolName, input);
		const agent = getActiveAgent();
		const agentPerms = agent?.permissions;
		const mode = agentPerms?.mode ?? "allow-unless-matched";

		const g = globalRules ?? { deny: [], ask: [] };

		// 1. global deny — always wins
		for (const { tool, re, rule } of g.deny) {
			if (tool !== "*" && tool !== toolName) continue;
			if (re.test(probe)) {
				return { block: true, reason: rule.reason ?? `Denied by global policy: ${rule.match}` };
			}
		}
		// 2. agent deny
		for (const { tool, re, rule } of compile(agentPerms?.deny)) {
			if (tool !== "*" && tool !== toolName) continue;
			if (re.test(probe)) {
				return { block: true, reason: rule.reason ?? `Denied by ${agent?.name} policy: ${rule.match}` };
			}
		}

		// 3. global ask — approving the prompt grants THIS single call.
		// (Without this, a deny-by-default agent would block the call in the allow
		// list below anyway, turning the prompt into a dead end.)
		for (const { tool, re, rule } of g.ask) {
			if (tool !== "*" && tool !== toolName) continue;
			if (re.test(probe)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Blocked by policy (no UI): ${rule.match}` };
				}
				const choice = await ctx.ui.select(
					`⚠️ Permission required (${toolName} matches "${rule.match}")\n\n  ${probe}\n\nAllow?`,
					["Deny", "Allow"],
				);
				if (choice !== "Allow") return { block: true, reason: "Denied by user" };
				return undefined; // user approved — allow this call
			}
		}
		// 4. agent ask — same grant-on-approve semantics
		for (const { tool, re, rule } of compile(agentPerms?.ask)) {
			if (tool !== "*" && tool !== toolName) continue;
			if (re.test(probe)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Blocked by ${agent?.name} policy (no UI): ${rule.match}` };
				}
				const choice = await ctx.ui.select(
					`⚠️ Permission required (${toolName} matches "${rule.match}")\n\n  ${probe}\n\nAllow?`,
					["Deny", "Allow"],
				);
				if (choice !== "Allow") return { block: true, reason: "Denied by user" };
				return undefined; // user approved — allow this call
			}
		}

		// 5. allow list (only meaningful in deny-by-default mode)
		if (mode === "deny-by-default") {
			const allowed = compile(agentPerms?.allow);
			for (const { tool, re } of allowed) {
				if (tool !== "*" && tool !== toolName) continue;
				if (re.test(probe)) {
					return undefined; // explicitly allowed
				}
			}
			// 6. default-deny
			return {
				block: true,
				reason: agent
					? `Denied by default (agent "${agent.name}" is deny-by-default; add an allow rule to permit \`${probe.slice(0, 120)}\`)`
					: `Denied by default: \`${probe.slice(0, 120)}\``,
			};
		}

		return undefined;
	});
}