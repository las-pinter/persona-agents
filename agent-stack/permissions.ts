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
 * Ask rules (steps 2 and 4) prompt with four options:
 *   - "Deny"                            → block this call (reason "Denied by user")
 *   - "Allow once (whole command)"       → grant THIS single call
 *   - "Allow once (this segment only)"   → approve only the matching segment of a
 *                                          compound command, then re-evaluate the
 *                                          remaining segments
 *   - "Always allow (session)"           → approve only the matching segment,
 *                                          then remember the rule for the
 *                                          session (agent|tool|match key,
 *                                          in-memory only, nothing persisted
 *                                          to disk)
 *
 * Compound shell commands are split into segments by `command-segments.ts`;
 * every segment must pass. See that module for the parse/decision core.
 * Deny rules (steps 1 and 3) always win; headless runs (no UI) treat ask as a
 * hard block — undefined (no prompt) never auto-allows.
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
import { evaluateCommandRules, type RawRule, type RuleSets } from "./command-segments.ts";

function configPath(): string {
	if (process.env.PI_PERMISSIONS_FILE) return process.env.PI_PERMISSIONS_FILE;
	return path.join(getAgentDir(), "permissions.json");
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
	let globalRules: { deny: PermissionRule[]; ask: PermissionRule[] } | null = null;

	// Session-scoped "always allow" memory, keyed by `agent|tool|ruleMatch`, created
	// with this gate installation. In-memory only — nothing is written to disk, so
	// an "Always allow (session)" choice never survives a restart or /reload (a
	// persistent always-allow list is a separate decision). A key hit skips the
	// prompt entirely on later calls.
	const sessionAllow = new Set<string>();

	const loadGlobal = () => {
		try {
			const cfg = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as {
				deny?: PermissionRule[];
				ask?: PermissionRule[];
			};
			globalRules = { deny: cfg.deny ?? [], ask: cfg.ask ?? [] };
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
		const isShell = toolName === "bash" || toolName === "powershell";
		const ruleSets: RuleSets = {
			globalDeny: g.deny,
			agentDeny: agentPerms?.deny ?? [],
			globalAsk: g.ask,
			agentAsk: agentPerms?.ask ?? [],
			agentAllow: agentPerms?.allow ?? [],
		};
		const sessionKey = (match: string): string => `${agent?.name ?? "<none>"}|${toolName}|${match}`;
		const isSessionAllowed = (rule: RawRule): boolean => sessionAllow.has(sessionKey(rule.match));

		// User-approved segments ("Allow once, this segment only") for THIS call.
		const approvedSegments = new Set<number>();

		// Resolve asks round by round: each "segment only" choice approves exactly
		// one segment, then the remaining segments are re-evaluated.
		for (;;) {
			const decision = evaluateCommandRules(probe, isShell, ruleSets, mode, toolName, agent?.name ?? null, {
				approvedSegmentIndices: approvedSegments,
				isSessionAllowed,
			});

			if (decision.kind === "deny" || decision.kind === "default") {
				return { block: true, reason: decision.reason };
			}
			if (decision.kind === "allow") return undefined;

			// decision.kind === "ask"
			const rule = decision.rule;
			const key = sessionKey(rule.match);

			if (!ctx.hasUI) {
				return {
					block: true,
					reason:
						decision.source === "global"
							? `Blocked by policy (no UI): ${rule.match}`
							: `Blocked by ${agent?.name} policy (no UI): ${rule.match}`,
				};
			}

			const segmentLine =
				decision.segment === probe ? "" : `\n\nMatching segment:\n  ${decision.segment}`;
			// The herdr courier clears only on active:false, so every prompt outcome must emit it.
			pi.events.emit("herdr:blocked", { active: true, label: rule.reason ?? rule.match });
			let choice: string | undefined;
			try {
				choice = await ctx.ui.select(
					`⚠️ Permission required (${toolName} matches "${rule.match}")\n\n  ${probe}${segmentLine}\n\nAllow?`,
					[
						"Deny",
						"Allow once (whole command)",
						"Allow once (this segment only)",
						"Always allow (session)",
					],
				);
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
			}

			if (choice === "Always allow (session)") {
				sessionAllow.add(key); // remembered for the rest of the session
				// Approve only this segment, then keep evaluating the rest.
				approvedSegments.add(decision.segmentIndex);
				continue;
			}
			if (choice === "Allow once (this segment only)") {
				approvedSegments.add(decision.segmentIndex);
				continue; // re-evaluate the remaining segments
			}
			if (choice === "Allow once (whole command)") {
				return undefined; // user approved — allow this call
			}
			return { block: true, reason: "Denied by user" };
		}
	});
}