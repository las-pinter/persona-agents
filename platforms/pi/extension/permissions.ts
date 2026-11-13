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
 *   6. the mode default     (`deny-by-default`; an unnamed agent gets its class rows)
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
 * factory never builds a pattern per call. `gate-call.ts` owns one call: the
 * caller checks, the verdict order, the ask path, and the one retry step.
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
 * Compound shell commands are split into segments by `shell-parse.ts`; every
 * segment must pass. `command-segments.ts` owns the decision core.
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
import type { AgentConfig } from "./resolver.ts";
import { discoverSkills, matchSkills, skillScriptsDirs } from "./skill-discovery.ts";
import {
	unallowedSegments,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";
import {
	compileClass,
	compileRole,
} from "./permission-table-groups.ts";
import type { RuleRow } from "./permission-table.ts";
import {
	PERMISSION_CLASSES,
	READER_CLASS,
	ROLE_CLASS,
	isRole,
	type PermissionClass,
	type Role,
} from "./permission-class.ts";
import { loadDefaultRows, loadGlobalRules, loadPermissionConfig, type OverlayRules } from "./permission-config.ts";
import { bindChildAsk, childAskQueue } from "./child-ask.ts";
import { type ParentGateHandler, bindParentGate } from "./child-tools.ts";
import { bindRunRegistry, type RunRegistry } from "./run-registry.ts";
import { evaluateCall } from "./gate-call.ts";

export { loadGlobalRules } from "./permission-config.ts";

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
 * skill's real script. A segment with an unresolved expansion is in the list,
 * so the rescue can never launder one. This rescues a deny-by-default
 * fall-through, so deny and ask rules always win; segments the caller approved,
 * a session-allowed segment, or an allow rule already matched are skipped, so a
 * command may mix regex-allowed parts with skill scripts. An empty command
 * returns false.
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
	const byClass = new Map<PermissionClass, RuleSets>();
	for (const cls of PERMISSION_CLASSES) byClass.set(cls, compileClass(rows, cls));
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
		const cls = agent.permissionClass ?? READER_CLASS;
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

	const gate = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> =>
		evaluateCall({
			event,
			ctx,
			getActiveAgent,
			source,
			registry,
			overlay,
			sessionAllow,
			derivedSkillScriptDirs,
			allSegmentsAreSkillScripts,
		});
	// A child tool wrapper asks this same handler, so one gate serves both sessions.
	// SAFETY: the wrapper passes `{ toolName, input }`, the two fields this handler reads.
	bindParentGate(gate as unknown as ParentGateHandler);
	pi.on("tool_call", gate);
}
