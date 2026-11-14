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
 * caller checks, the verdict order, and the one retry step.
 *
 * `gate-call.ts` states the ask path. `permission-prompt.ts` owns the three
 * choice labels and the prompt text.
 *
 * Compound shell commands are split into segments by `shell-parse.ts`; every
 * segment must pass. `command-segments.ts` owns the decision core.
 *
 * The overlay file `~/.pi/agent/permissions.json` keeps the shape
 *   { "deny": [ { "tool": "bash", "match": "...", "reason": "..." } ], "ask": [ ... ] }
 * Its rows are appended after the table's global rows. A malformed file fails
 * closed: one line names the path and every call is denied.
 *
 * Run /reload after editing permissions.json or permissions.table.json.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./resolver.ts";
import { discoverSkills, matchSkills, skillScriptsDirs } from "./skill-discovery.ts";
import {
	type PermissionMode,
	type RuleSets,
} from "./command-segments.ts";
import { allSegmentsAreSkillScripts } from "./skill-script-rescue.ts";
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
