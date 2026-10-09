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
 * Ask rules (steps 2 and 4) prompt with plain-language options
 * (`permission-prompt.ts`). Shell tools with segments get four decisions:
 *   - Deny                    → block this call (reason "Denied by user")
 *   - Allow this command once → grant THIS single call
 *   - Allow only the blocked part once
 *                             → approve only the matching segment of a
 *                               compound command, then re-evaluate the
 *                               remaining segments
 *   - Always allow the blocked part (this session)
 *                             → approve only the matching segment,
 *                               then remember the rule for the
 *                               session (agent|tool|match key,
 *                               in-memory only, nothing persisted
 *                               to disk)
 * Other tools have one target and a simpler list (Deny / Allow once /
 * Always allow this in this session). The prompt shows the rule's human
 * `reason`, never the raw regex.
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
import {
	evaluateCommandRules,
	splitShellSegments,
	unallowedSegments,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";
import {
	buildPromptModel,
	renderPermissionPrompt,
	type PermissionChoice,
} from "./permission-prompt.ts";

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
 * Real interpreter paths allowed when the interpreter token carries a slash.
 * The token is resolved through symlinks first, so symlinked `/bin/*` entries
 * still match their real `/usr/bin/*` target.
 */
const TRUSTED_INTERPRETER_PATHS = new Set([
	"/bin/bash",
	"/usr/bin/bash",
	"/bin/sh",
	"/usr/bin/sh",
	"/bin/dash",
	"/usr/bin/dash",
	"/bin/zsh",
	"/usr/bin/zsh",
]);

/** First-token class: trusted interpreter, forged look-alike, or the script path. */
type InterpreterKind = "trusted" | "untrusted" | "not-interpreter";

/**
 * A token is an interpreter look-alike only when its basename is one of the four
 * interpreter names. A bare name is trusted only when it is exactly one of those
 * names. A slash form is trusted only when it resolves through symlinks to a real
 * whitelisted interpreter path; a slash form that does not resolve, or resolves
 * elsewhere, is "untrusted", so `/tmp/x/bash` can never hide the script.
 */
function classifyInterpreterToken(token: string): InterpreterKind {
	if (!SCRIPT_INTERPRETERS.has(path.basename(token))) return "not-interpreter";
	if (!token.includes("/")) return "trusted"; // basename equals token here
	let real: string;
	try {
		real = fs.realpathSync(token);
	} catch {
		return "untrusted";
	}
	return TRUSTED_INTERPRETER_PATHS.has(real) ? "trusted" : "untrusted";
}

/**
 * A plain path token. It allows only path characters, so a backslash, `$`,
 * quote, space, or any other shell metacharacter denies the segment. Bash
 * strips those before it opens the file, so a token that keeps them is forged.
 */
const PLAIN_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * True only when `candidate` resolves (through symlinks) to a regular file
 * inside one of the allow-listed script dirs. A path that does not resolve, or
 * that resolves to a directory or a FIFO, is denied: fail closed. Anything
 * placed inside a trusted scripts dir is trusted, so keep those dirs clean.
 */
function resolvesInsideScriptDir(candidate: string, dirs: string[]): boolean {
	let real: string;
	try {
		real = fs.realpathSync(candidate);
		if (!fs.statSync(real).isFile()) return false;
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
 * A leading `cd <dir> &&` guard sets the resolution base; a relative target
 * resolves against `cwd`, so the checked path matches the executed path. The
 * first token is an interpreter only when it is a bare `bash`/`sh`/`dash`/`zsh`
 * or a slash form that resolves to a whitelisted real interpreter; any other
 * interpreter look-alike (`/tmp/x/bash`) denies the segment. Interpreter flags
 * are NOT skipped, so `bash -c ...` and `bash -x ...` stay denied. The script
 * token must be a plain path, contain a `/`, and end in `.sh`; `rm script.sh`
 * has first token `rm`, so it never passes.
 */
export function isAllowedSkillScript(segment: string, skillScriptsDirs: string[], cwd: string): boolean {
	let base = cwd;
	let rest = segment.trim();
	const cd = /^cd\s+(\S+)\s*&&\s*/.exec(rest);
	if (cd) {
		base = path.resolve(cwd, cd[1]);
		rest = rest.slice(cd[0].length).trim();
	}
	const tokens = rest.split(/\s+/);
	let token = tokens[0] ?? "";
	const interpreter = classifyInterpreterToken(token);
	if (interpreter === "untrusted") return false;
	if (interpreter === "trusted") token = tokens[1] ?? "";
	if (!PLAIN_PATH_RE.test(token)) return false;
	if (!token.includes("/") || !token.endsWith(".sh")) return false;
	return resolvesInsideScriptDir(path.resolve(base, token), skillScriptsDirs);
}

/**
 * True when every segment that falls through to deny-by-default is a loaded
 * skill's real script. This rescues a deny-by-default fall-through, so deny and
 * ask rules always win; segments the caller approved, a session-allowed
 * segment, or an allow rule already matched are skipped, so a command may mix
 * regex-allowed parts with skill scripts. An empty command returns false.
 */
export function allSegmentsAreSkillScripts(
	command: string,
	approvedSegmentIndices: ReadonlySet<number>,
	skillScriptsDirs: string[],
	cwd: string,
	ruleSets: RuleSets,
	toolName: string,
	isSessionAllowed?: (rule: RawRule) => boolean,
): boolean {
	const { segments, indices } = unallowedSegments(
		command,
		true,
		ruleSets,
		toolName,
		approvedSegmentIndices,
		isSessionAllowed,
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
					allSegmentsAreSkillScripts(
						probe,
						approvedSegments,
						skillDirs,
						ctx.cwd,
						ruleSets,
						toolName,
						isSessionAllowed,
					)
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

			// The rule's regex is never shown; the prompt uses the human reason.
			const segmentCount = isShell ? splitShellSegments(probe).length : 1;
			const promptModel = buildPromptModel({
				toolName,
				probe,
				segment: decision.segment,
				segmentIndex: decision.segmentIndex,
				segmentCount,
				reason: rule.reason,
				isSpanning: decision.segmentIndex === -1,
			});
			// The herdr courier clears only on active:false, so every prompt outcome must emit it.
			pi.events.emit("herdr:blocked", { active: true, label: rule.reason ?? rule.match });
			let choice: PermissionChoice;
			try {
				choice = await renderPermissionPrompt(ctx, promptModel);
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
			}

			if (choice === "always-allow") {
				sessionAllow.add(key); // remembered for the rest of the session
				// Approve only this segment, then keep evaluating the rest.
				approvedSegments.add(decision.segmentIndex);
				continue;
			}
			if (choice === "allow-once-segment") {
				approvedSegments.add(decision.segmentIndex);
				continue; // re-evaluate the remaining segments
			}
			if (choice === "allow-once-whole") {
				return undefined; // user approved — allow this call
			}
			return { block: true, reason: "Denied by user" };
		}
	});
}