/**
 * Regression tests for skill-script inheritance on the pi gate.
 *
 * A loaded skill's real `scripts/` directory is the structural allow-list for
 * `.sh` scripts. This is a path check, not a regex rule: a forged
 * `/tmp/skills/...` path is denied. Deny and ask rules still win.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, matchSkills, skillScriptsDirs } from "./resolver.ts";
import { allSegmentsAreSkillScripts, isAllowedSkillScript } from "./permissions.ts";
import { evaluateCommandRules, type Decision, type RuleSets } from "./command-segments.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NO_RULES: RuleSets = {
	globalDeny: [],
	globalAsk: [],
	agentDeny: [],
	agentAsk: [],
	agentAllow: [],
};

/**
 * Combine the regex verdict with the gate's structural fallback, mirroring the
 * `tool_call` handler: deny/ask win; only a deny-by-default fall-through checks
 * the skill scripts.
 */
function verdict(ruleSets: RuleSets, command: string, skillDirs: string[], cwd = repoRoot): Decision["kind"] {
	const decision = evaluateCommandRules(command, true, ruleSets, "deny-by-default", "bash", "orchestrator");
	if (decision.kind !== "default") return decision.kind;
	return allSegmentsAreSkillScripts(command, new Set<number>(), skillDirs, cwd) ? "allow" : "default";
}

const ORCH_DIR = "/repo/skills/orchestrator/plan-tracking/scripts";

describe("skill scripts: structural segment check", () => {
	const dirs = [ORCH_DIR];

	const allowed = [
		"bash /repo/skills/orchestrator/plan-tracking/scripts/plan-mark.sh x --status done",
		"/repo/skills/orchestrator/plan-tracking/scripts/plan-list.sh",
		"cd /repo && bash /repo/skills/orchestrator/plan-tracking/scripts/plan-mark.sh",
	];

	for (const command of allowed) {
		test(`allows ${command}`, () => {
			assert.equal(allSegmentsAreSkillScripts(command, new Set<number>(), dirs, "/repo"), true, command);
		});
	}

	const denied = [
		"bash /tmp/skills/orchestrator/plan-tracking/scripts/evil.sh",
		"bash /tmp/evil.sh",
		"bash /repo/skills/planner/task-decomposition/scripts/x.sh",
	];

	for (const command of denied) {
		test(`denies ${command}`, () => {
			assert.equal(allSegmentsAreSkillScripts(command, new Set<number>(), dirs, "/repo"), false, command);
		});
	}

	test("denies a bare script name with no path", () => {
		assert.equal(isAllowedSkillScript("plan-mark.sh x --status done", dirs, "/repo"), false);
	});

	test("denies a non-.sh script", () => {
		assert.equal(
			isAllowedSkillScript("bash /repo/skills/orchestrator/plan-tracking/scripts/evil.bash", dirs, "/repo"),
			false,
		);
	});

	test("denies rm of a skill script (first token is rm)", () => {
		assert.equal(
			isAllowedSkillScript("rm /repo/skills/orchestrator/plan-tracking/scripts/plan-list.sh", dirs, "/repo"),
			false,
		);
	});

	test("a cd base resolves a relative script path", () => {
		assert.equal(
			isAllowedSkillScript(
				"cd /repo/skills/orchestrator/plan-tracking && bash scripts/plan-list.sh",
				dirs,
				"/repo",
			),
			true,
		);
	});

	test("a whole-command fallback rejects a mixed command", () => {
		assert.equal(
			allSegmentsAreSkillScripts(
				"echo hi && bash /repo/skills/orchestrator/plan-tracking/scripts/plan-list.sh",
				new Set<number>(),
				dirs,
				"/repo",
			),
			false,
		);
	});
});

describe("skill scripts: deny and ask precedence", () => {
	const dirs = [ORCH_DIR];
	const command = `bash ${ORCH_DIR}/plan-mark.sh x --status done`;

	test("an agent deny rule beats the structural allow", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentDeny: [{ tool: "bash", match: "plan-mark\\.sh" }] };
		assert.equal(
			evaluateCommandRules(command, true, ruleSets, "deny-by-default", "bash", "orchestrator").kind,
			"deny",
		);
		assert.equal(verdict(ruleSets, command, dirs), "deny");
	});

	test("an agent ask rule beats the structural allow", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentAsk: [{ tool: "bash", match: "\\bsudo\\b" }] };
		const cmd = `bash ${ORCH_DIR}/plan-mark.sh --by sudo`;
		assert.equal(evaluateCommandRules(cmd, true, ruleSets, "deny-by-default", "bash", "orchestrator").kind, "ask");
		assert.equal(verdict(ruleSets, cmd, dirs), "ask");
	});
});

describe("skill scripts: real repo integration", () => {
	const discovered = discoverSkills(repoRoot);
	const orch = matchSkills(["orchestrator/*", "common/simplified-technical-english"], discovered);
	const planner = matchSkills(["planner/*", "common/simplified-technical-english"], discovered);
	const orchDirs = skillScriptsDirs(orch);
	const plannerDirs = skillScriptsDirs(planner);
	const realScriptsDir = fs.realpathSync(path.join(repoRoot, "skills/orchestrator/plan-tracking/scripts"));

	test("the orchestrator loads plan-tracking", () => {
		assert.ok(orch.some((s) => s.group === "orchestrator" && s.name === "plan-tracking"));
	});

	test("the orchestrator's skill dirs include the real plan-tracking scripts dir", () => {
		assert.ok(orchDirs.includes(realScriptsDir), orchDirs.join(", "));
	});

	test("the planner's skill dirs do not include plan-tracking scripts", () => {
		assert.ok(!plannerDirs.includes(realScriptsDir), plannerDirs.join(", "));
	});

	test("every real plan-tracking script is allowed for the orchestrator, not without dirs", () => {
		const files = fs.readdirSync(realScriptsDir).filter((f) => f.endsWith(".sh"));
		assert.ok(files.length > 0, "plan-tracking must ship at least one script");
		for (const file of files) {
			const abs = path.join(realScriptsDir, file);
			assert.equal(verdict(NO_RULES, `bash ${abs}`, orchDirs), "allow", file);
			assert.notEqual(verdict(NO_RULES, `bash ${abs}`, []), "allow", file);
		}
	});

	test("the planner's dirs do not permit a plan-tracking script", () => {
		const abs = path.join(realScriptsDir, "plan-list.sh");
		assert.notEqual(verdict(NO_RULES, `bash ${abs}`, plannerDirs), "allow");
	});

	test("a forged path shaped like a skill script is denied", () => {
		assert.equal(
			isAllowedSkillScript(
				"bash /tmp/skills/orchestrator/plan-tracking/scripts/evil.sh",
				orchDirs,
				repoRoot,
			),
			false,
		);
	});
});
