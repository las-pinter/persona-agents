/**
 * Shared fixtures and helpers for the legacy permission regression suite.
 *
 * The gate reads the compiled table now, and the pi frontmatters carry no rule
 * list. These three regression files still drive the real engine, so they read
 * the frozen legacy corpus in `tests/legacy-pi-permissions/` and keep the
 * behaviour the retired lists proved. `permission-table.test.ts` proves the
 * shipped table; a case that must change verdict belongs there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	evaluateCommandRules,
	type Decision,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "../platforms/pi/extension/command-segments.ts";

const frontmatterDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "legacy-pi-permissions");

interface FrontmatterPermissions {
	mode?: string;
	allow?: RawRule[];
	ask?: RawRule[];
	deny?: RawRule[];
}

/** Read one frozen legacy rule block and map it onto gate `RuleSets`. */
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

const OTHER_AGENTS = ["researcher", "reviewer", "tester", "planner", "mascot"];
// Mascot has no bash tool. Bash behavior matrices skip it: deny-by-default still
// denies it, but the kind is `default`, not an explicit `deny` rule.
export const PI_SHELL_AGENTS = OTHER_AGENTS.filter((agent) => agent !== "mascot");
