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
import {
	discoverSkills,
	matchSkills,
	skillScriptsDirs,
	type AgentConfig,
	type PermissionRule,
} from "./resolver.ts";
import { evaluateCommandRules, unallowedSegments, type RawRule, type RuleSets } from "./command-segments.ts";

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

/** The shell interpreters whose first argument is the script to run. */
const SCRIPT_INTERPRETERS = new Set(["bash", "sh", "dash", "zsh"]);

/**
 * A plain path token. It allows only path characters, so a backslash, `$`,
 * quote, space, or any other shell metacharacter denies the segment. Bash
 * strips those before it opens the file, so a token that keeps them is forged.
 */
const PLAIN_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * True only when `candidate` resolves (through symlinks) to a real file inside
 * one of the allow-listed script dirs. A path that does not resolve is denied:
 * fail closed, because an expanded or escaped form cannot be trusted.
 */
function resolvesInsideScriptDir(candidate: string, dirs: string[]): boolean {
	let real: string;
	try {
		real = fs.realpathSync(candidate);
	} catch {
		return false;
	}
	return dirs.some((dir) => real === dir || real.startsWith(dir + path.sep));
}

/**
 * True when a shell segment runs a `.sh` script that lives inside one of the
 * loaded skills' real `scripts/` dirs. This is a STRUCTURAL check, not a pattern
 * match: a forged `/tmp/skills/...` path never resolves inside a real skill dir.
 *
 * A leading `cd <dir> &&` guard sets the resolution base. The interpreter is
 * recognised by basename, so `/bin/bash <script>` works; interpreter flags are
 * NOT skipped, so `bash -c ...` and `bash -x ...` stay denied. The script token
 * must be a plain path, contain a `/`, and end in `.sh`; `rm script.sh` has
 * first token `rm`, so it never passes.
 */
export function isAllowedSkillScript(segment: string, skillScriptsDirs: string[], cwd: string): boolean {
	let base = cwd;
	let rest = segment.trim();
	const cd = /^cd\s+(\S+)\s*&&\s*/.exec(rest);
	if (cd) {
		base = cd[1];
		rest = rest.slice(cd[0].length).trim();
	}
	const tokens = rest.split(/\s+/);
	let token = tokens[0] ?? "";
	if (SCRIPT_INTERPRETERS.has(path.basename(token))) token = tokens[1] ?? "";
	if (!PLAIN_PATH_RE.test(token)) return false;
	if (!token.includes("/") || !token.endsWith(".sh")) return false;
	return resolvesInsideScriptDir(path.resolve(base, token), skillScriptsDirs);
}

/**
 * True when every segment that falls through to deny-by-default is a loaded
 * skill's real script. This rescues a deny-by-default fall-through, so deny and
 * ask rules always win; segments the caller approved or an allow rule already
 * matched are skipped, so a command may mix regex-allowed parts with skill
 * scripts. An empty command returns false.
 */
export function allSegmentsAreSkillScripts(
	command: string,
	approvedSegmentIndices: ReadonlySet<number>,
	skillScriptsDirs: string[],
	cwd: string,
	ruleSets: RuleSets,
	toolName: string,
): boolean {
	const { segments, indices } = unallowedSegments(
		command,
		true,
		ruleSets,
		toolName,
		approvedSegmentIndices,
	);
	if (segments.length === 0) return false;
	return indices.every((idx) => isAllowedSkillScript(segments[idx], skillScriptsDirs, cwd));
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

	// Derived skill-script dirs, cached per (agent name, cwd). /reload re-runs
	// this factory, which clears the cache. These dirs are the structural
	// allow-list; no regex rule is appended to `agentAllow`.
	let skillDirsCache: { key: string; dirs: string[] } | null = null;
	const derivedSkillScriptDirs = (agent: AgentConfig, cwd: string): string[] => {
		const key = `${agent.name}\u0000${cwd}`;
		if (skillDirsCache?.key === key) return skillDirsCache.dirs;
		const loaded = matchSkills(
			[...(agent.skills ?? []), ...(agent.alwaysLoad ?? [])],
			discoverSkills(cwd),
		);
		const dirs = skillScriptsDirs(loaded);
		skillDirsCache = { key, dirs };
		return dirs;
	};

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
		const skillDirs = isShell && agent ? derivedSkillScriptDirs(agent, ctx.cwd) : [];
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

			if (decision.kind === "deny") {
				return { block: true, reason: decision.reason };
			}
			if (decision.kind === "default") {
				// The regex verdict fell through to deny-by-default. A loaded skill's
				// real script is the one structural exception. Segments an allow rule
				// already matched are skipped, so a mixed command works. Deny and ask
				// already won above, so this can never override them.
				if (
					skillDirs.length > 0 &&
					allSegmentsAreSkillScripts(probe, approvedSegments, skillDirs, ctx.cwd, ruleSets, toolName)
				) {
					return undefined;
				}
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