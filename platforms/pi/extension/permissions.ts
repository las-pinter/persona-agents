/**
 * Permission gate for the pi rule table.
 *
 * Every tool call the model makes is checked against one compiled table, with the
 * live global file as an optional local overlay. `permission-config.ts` reads the
 * three layers in order: the shipped default data file, the user override file,
 * and the global overlay. Every rule records its layer. Precedence
 * (`command-segments.ts` owns the order):
 *
 *   1. global deny rows     (the table's global group, then the overlay)
 *   2. class deny rows      (the resolved role's class)
 *   3. a spanning ask       (global ask rows, then class ask rows)
 *   4. a per-segment ask    (global ask rows, then class ask rows)
 *   5. class allow rows
 *   6. the mode default     (`deny-by-default`; nothing unnamed runs)
 *
 * Deny wins over ask wins over allow, and every segment of a compound command
 * must pass.
 *
 * The role comes from the resolved agent: its name must be a shipped profession,
 * its `permissionClass` must equal that profession's class, and the agent must
 * come from the package before the profession's notes zone binds. An agent whose
 * name is not a profession, whose class disagrees, or that comes from a user or
 * project file gets its class rule set with no notes write zone. A session with
 * no active agent keeps the global rows and runs under `allow-unless-matched`,
 * as a bare pi session does.
 *
 * `installPermissionGate` compiles the table once at factory time; the returned
 * factory never builds a pattern per call.
 *
 * Ask rows prompt with plain-language options (`permission-prompt.ts`). A root
 * session renders its own ask inline. A child session has no UI, so it enqueues
 * the request on the root queue (`child-ask.ts`), and the root renders one
 * prompt at a time on the surface the root gate captured. The grant key carries
 * the session id, so a child answer stays with its own session. Every tool shows
 * the same three choices:
 *   - Allow once                       → grant THIS single call
 *   - Always allow this rule (session) → remember the rule for the session
 *                                        (session|role|tool|rule key, in-memory
 *                                        only, nothing persisted to disk)
 *   - Deny                             → block this call ("Denied by user")
 * A shell segment also approves the matching segment and re-evaluates the
 * remaining segments. A spanning rule runs the whole call once and approves no
 * segment. The prompt shows the full command, highlights the blocked part, and
 * shows the rule's human `reason`, never a pattern.
 *
 * Compound shell commands are split into segments by `command-segments.ts`;
 * every segment must pass. See that module for the parse/decision core.
 * Headless runs (no UI) treat ask as a hard block — undefined (no prompt) never
 * auto-allows.
 *
 * The overlay file `~/.pi/agent/permissions.json` keeps the shape
 *   { "deny": [ { "tool": "bash", "match": "...", "reason": "..." } ], "ask": [ ... ] }
 * Its rows are appended after the table's global rows. A malformed file fails
 * closed: one line names the path and every call is denied.
 *
 * Run /reload after editing permissions.json or permissions.table.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	discoverSkills,
	matchSkills,
	skillScriptsDirs,
	type AgentConfig,
} from "./resolver.ts";
import {
	evaluateCommandRules,
	unallowedSegments,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";
import {
	CLASS_ORDER,
	compileClass,
	compileRole,
	ROLE_CLASS,
	type Role,
	type RoleClass,
	type RuleRow,
} from "./permission-table.ts";
import { loadDefaultRows, loadGlobalRules, loadPermissionConfig, type OverlayRules } from "./permission-config.ts";
import {
	buildPromptModel,
	blockedLabel,
	DENIED_BY_USER_REASON,
	humanReason,
	renderPermissionPrompt,
	type PermissionChoice,
} from "./permission-prompt.ts";
import { bindChildAsk, childAskQueue } from "./child-ask.ts";
import { type ParentGateHandler, bindParentGate } from "./child-tools.ts";
import { bindRunRegistry, UNKNOWN_RUN_REASON, type RunRecord, type RunRegistry } from "./run-registry.ts";

export { loadGlobalRules } from "./permission-config.ts";

/**
 * The grant key. One answer covers one session, role, tool, and rule.
 * A key that lacks one part would lend the grant to a sibling or the root.
 */
function grantKey(sessionId: string, role: string, toolName: string, ruleId: string): string {
	return `${sessionId}|${role}|${toolName}|${ruleId}`;
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
 * has first token `rm`, so it never passes. A redirect (`<` or `>`) anywhere
 * after the script denies the segment: the exception covers running the
 * script, never a file write or read the redirect adds.
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
	let scriptIndex = 0;
	const interpreter = classifyInterpreterToken(tokens[0] ?? "");
	if (interpreter === "untrusted") return false;
	if (interpreter === "trusted") scriptIndex = 1;
	const token = tokens[scriptIndex] ?? "";
	if (tokens.slice(scriptIndex + 1).some((arg) => /[<>]/.test(arg))) return false;
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

/**
 * What one evaluation reads: the five rule sets and the mode default. The gate
 * builds this from the compiled table; a test may pass its own source.
 */
export interface GateRuleSource {
	ruleSets: RuleSets;
	mode: PermissionMode;
}

export type GateRuleSourceFactory = (agent: AgentConfig | null) => GateRuleSource;

/** The agent fields the gate reads, for a child whose record names its own role. */
const NO_AGENT: AgentConfig = { name: "", description: "", systemPrompt: "", source: "user", filePath: "" };

/**
 * The child agent. Its identity comes from the run record. A project child
 * therefore keeps its own source and its own skill lists, never the root's.
 */
function childAgentOf(record: Readonly<RunRecord>): AgentConfig {
	return {
		...NO_AGENT,
		name: record.role,
		permissionClass: record.class,
		source: record.source,
		skills: record.skills,
		alwaysLoad: record.alwaysLoad,
	};
}

/** The session id of one tool call, or null when the context carries none. */
function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string | null {
	return ctx.sessionManager?.getSessionId?.() ?? null;
}

/** True only for one of the seven shipped professions. */
function isRole(name: string): name is Role {
	return Object.prototype.hasOwnProperty.call(ROLE_CLASS, name);
}

/**
 * Compile the rule table once, then pick a set per call.
 *
 * Every profession is compiled with `compileRole`, so the role's own notes zone
 * binds when the agent comes from the package. Every class is compiled with
 * `compileClass`, which binds no zone, for an agent whose name is not a shipped
 * profession, whose class disagrees with the role map, or that comes from a user
 * or project file. The global rows are identical in every compiled set, so the
 * no-agent case reuses one copy and keeps `allow-unless-matched`, as a bare pi
 * session does today.
 */
export function compileGateSource(rows: readonly RuleRow[] = loadDefaultRows()): GateRuleSourceFactory {
	const byRole = new Map<Role, RuleSets>();
	for (const role of Object.keys(ROLE_CLASS) as Role[]) byRole.set(role, compileRole(rows, role));
	const byClass = new Map<RoleClass, RuleSets>();
	for (const cls of CLASS_ORDER) byClass.set(cls, compileClass(rows, cls));
	const reader = byClass.get("reader") as RuleSets;
	const noAgent: GateRuleSource = {
		ruleSets: {
			globalDeny: [...reader.globalDeny],
			agentDeny: [],
			globalAsk: [...reader.globalAsk],
			agentAsk: [],
			agentAllow: [],
		},
		mode: "allow-unless-matched",
	};
	return (agent) => {
		if (!agent) return noAgent;
		const cls = agent.permissionClass ?? "reader";
		// A name alone never widens the fence: discovery clamps a user or project
		// file above `reader`, and the class must agree with the role map here. The
		// notes zone binds only for a package file, so a user file named after a
		// profession cannot borrow that profession's write zone.
		if (agent.source === "package" && isRole(agent.name) && ROLE_CLASS[agent.name] === cls) {
			return { ruleSets: byRole.get(agent.name) as RuleSets, mode: "deny-by-default" };
		}
		return { ruleSets: byClass.get(cls) ?? reader, mode: "deny-by-default" };
	};
}

/** Install the gate with the loaded three-layer table as the rule source. */
export function installPermissionGate(
	pi: ExtensionAPI,
	getActiveAgent: () => AgentConfig | null,
	registry: RunRegistry,
): void {
	const config = loadPermissionConfig();
	installToolCallGate(pi, getActiveAgent, compileGateSource(config.rows), registry, config.overlay);
}

/**
 * Install the tool-call gate over one rule source and the global overlay. The
 * table entry point is `installPermissionGate`; this composition point exists so
 * a test can drive the real prompt and grant path with a fixture rule set.
 *
 * The run registry is required and bound here, so the gate never reads a bind
 * that a caller forgot or reordered. A child call then resolves its own record.
 */
export function installToolCallGate(
	pi: ExtensionAPI,
	getActiveAgent: () => AgentConfig | null,
	source: GateRuleSourceFactory,
	registry: RunRegistry,
	overlay: OverlayRules = loadGlobalRules(),
): void {
	bindRunRegistry(registry);
	// The queue reads that registry. An install keeps a queue a test already
	// bound, so an injected deadline or renderer survives the install. The
	// surfaces of an earlier install are dropped, so this gate starts clean.
	const installedQueue = childAskQueue();
	if (installedQueue) installedQueue.clearSurfaces();
	else bindChildAsk();

	// The overlay is read once per factory run. /reload re-runs this factory (via
	// the extension runner), which re-reads the file, so no per-call read is
	// needed here.

	// Session-scoped "always allow" memory, keyed by the grant key (session, role,
	// tool, rule). In-memory only: nothing is written to disk, so an "Always
	// allow (session)" choice never survives a restart or /reload (a persistent
	// always-allow list is a separate decision). A key hit skips the prompt.
	const sessionAllow = new Set<string>();

	// Derived skill-script dirs, cached per (agent name, cwd). /reload re-runs
	// this factory, which clears the cache. These dirs are the structural
	// allow-list; no regex rule is appended to `agentAllow`.
	let skillDirsCache: { key: string; dirs: string[] } | null = null;
	const derivedSkillScriptDirs = (agent: AgentConfig, cwd: string): string[] => {
		// The key names every field the derivation reads, so two sources for one role differ.
		const key = [
			agent.source,
			agent.name,
			cwd,
			(agent.skills ?? []).join(","),
			(agent.alwaysLoad ?? []).join(","),
		].join("\u0000");
		if (skillDirsCache?.key === key) return skillDirsCache.dirs;
		const loaded = matchSkills(
			[...(agent.skills ?? []), ...(agent.alwaysLoad ?? [])],
			discoverSkills(cwd),
		);
		const dirs = skillScriptsDirs(loaded);
		skillDirsCache = { key, dirs };
		return dirs;
	};

	const gate = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (toolName.startsWith("mcp__") || toolName.includes(".")) return undefined;

		// A child answer must not cover its sibling or the root.
		const sessionId = sessionIdOf(ctx);
		const routing = childAskQueue();
		if (routing && sessionId) routing.noteContext(sessionId, ctx);
		const record = sessionId ? registry.get(sessionId) : undefined;
		// The depth comes from the registry walk, never from the record's own copy.
		// A record that under-reports its depth is still judged as the child it is.
		const walk = sessionId ? registry.walk(sessionId) : null;
		const depth = walk !== null && walk.ok ? walk.depth : null;
		// Assumption: a context with no session id is the root. pi always supplies
		// one, so that fallback keeps its pre-child behaviour and stays unreachable.
		// A bound registry with no record for the caller denies. The live root role
		// must not cover an id the registry never saw.
		if (sessionId && !record) {
			return { block: true, reason: UNKNOWN_RUN_REASON };
		}
		// A walk that stops short places no depth, so the caller cannot be judged
		// as a root. It is refused rather than given the root role.
		if (sessionId && walk !== null && !walk.ok) {
			return { block: true, reason: `Blocked: broken parent chain at session ${walk.failureId}` };
		}
		// The child agent comes from its own record, never from the root.
		const childRecord = depth === 0 ? undefined : record;
		const agent: AgentConfig | null = childRecord ? childAgentOf(childRecord) : getActiveAgent();

		// MCP and namespaced tools (mcp__context7__…, server.tool, …) are never
		// gated by this regex gate — deliberate: they are research/read-only
		// services or extension namespaces, and child subagents are already
		// limited to their `tools:` loadout. The gate exists to
		// constrain bash/read/edit/write/etc. tool calls.
		const probe = probeFor(toolName, input);
		const fromSource = source(agent);
		const mode = fromSource.mode;
		const isShell = toolName === "bash" || toolName === "powershell";
		const skillDirs = isShell && agent ? derivedSkillScriptDirs(agent, ctx.cwd) : [];
		// The table rows come first, then the live overlay. Deny wins by order, so an
		// overlay row can only add a verdict; it can never loosen a table row.
		const ruleSets: RuleSets = {
			globalDeny: [...fromSource.ruleSets.globalDeny, ...overlay.deny],
			agentDeny: fromSource.ruleSets.agentDeny,
			globalAsk: [...fromSource.ruleSets.globalAsk, ...overlay.ask],
			agentAsk: fromSource.ruleSets.agentAsk,
			agentAllow: fromSource.ruleSets.agentAllow,
		};
		// The root keeps its live role; a child keeps the role its record fixed at the build.
		const grantRole = (depth === 0 ? undefined : record?.role) ?? agent?.name ?? "<none>";
		const sessionKey = (match: string): string =>
			grantKey(sessionId ?? "<none>", grantRole, toolName, match);
		const isSessionAllowed = (rule: RawRule): boolean => sessionAllow.has(sessionKey(rule.match));

		// User-approved segments ("Always allow" on a segment) for THIS call.
		const approvedSegments = new Set<number>();

		// Resolve asks round by round: a segment "Always allow" approves exactly
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

			// The rule's regex is never shown; the prompt uses the human reason.
			const promptModel = buildPromptModel({
				toolName,
				probe,
				segment: decision.segment,
				segmentStart: decision.segmentStart,
				reason: humanReason(rule.reason, rule.match),
				isSpanning: decision.segmentIndex === -1,
			});

			// A child ask has no UI of its own, so it goes to the root queue and waits
			// for the owner. The captured root surface renders the shared prompt, and
			// the answer becomes the child verdict. Depth 0 is the caller itself, so a
			// root ask stays on the inline path below.
			if (routing && record && sessionId && depth !== 0) {
				const outcome = await routing.enqueue({
					sessionId,
					role: record.role,
					toolName,
					key,
					model: promptModel,
					remember: (grant) => sessionAllow.add(grant),
				});
				if (outcome.kind === "block") return { block: true, reason: outcome.reason };
				if (outcome.alwaysAllow && isShell && decision.segmentIndex >= 0) {
					// Approve the matched segment, then re-evaluate the rest.
					approvedSegments.add(decision.segmentIndex);
					continue;
				}
				return undefined;
			}

			if (!ctx.hasUI) {
				// Fail closed. The label is stable and never the rule regex.
				return {
					block: true,
					reason: blockedLabel(toolName, decision.source, agent?.name ?? null, rule.reason, rule.match),
				};
			}

			const choice: PermissionChoice = await renderPermissionPrompt(ctx, promptModel);

			if (choice === "always-allow") {
				sessionAllow.add(key); // remembered for the rest of the session
				if (isShell && decision.segmentIndex >= 0) {
					// Approve the matched segment, then re-evaluate the rest.
					approvedSegments.add(decision.segmentIndex);
					continue;
				}
				return undefined; // spanning or target — run the call now
			}
			if (choice === "allow-once") {
				return undefined; // user approved — allow this call once
			}
			return { block: true, reason: DENIED_BY_USER_REASON };
		}
	};
	// A child tool wrapper asks this same handler, so one gate serves both sessions.
	// SAFETY: the wrapper passes `{ toolName, input }`, the two fields this handler reads.
	bindParentGate(gate as unknown as ParentGateHandler);
	pi.on("tool_call", gate);
}
