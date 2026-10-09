/**
 * Regression tests for skill-script inheritance on the pi gate.
 *
 * A loaded skill's real `scripts/` directory is the structural allow-list for
 * `.sh` scripts. This is a path check, not a regex rule: a forged
 * `/tmp/skills/...` path is denied. Deny and ask rules still win.
 *
 * ALLOW cases use real temp files, because the check now resolves real paths
 * and fails closed on a path that does not exist. Fake paths stay for DENY.
 *
 * Run: npm test
 */

import { after, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverSkills, matchSkills, skillScriptsDirs } from "./resolver.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import {
	allSegmentsAreSkillScripts,
	installPermissionGate,
	isAllowedSkillScript,
} from "./permissions.ts";
import { evaluateCommandRules, type Decision, type RawRule, type RuleSets } from "./command-segments.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NO_RULES: RuleSets = {
	globalDeny: [],
	globalAsk: [],
	agentDeny: [],
	agentAsk: [],
	agentAllow: [],
};

/**
 * Combine the regex verdict with the real structural fallback function the
 * handler calls: deny/ask win; only a deny-by-default fall-through checks the
 * skill scripts. The integration block below drives the actual handler too.
 */
function verdict(ruleSets: RuleSets, command: string, skillDirs: string[], cwd = repoRoot): Decision["kind"] {
	const decision = evaluateCommandRules(command, true, ruleSets, "deny-by-default", "bash", "orchestrator");
	if (decision.kind !== "default") return decision.kind;
	return allSegmentsAreSkillScripts(command, new Set<number>(), skillDirs, cwd, ruleSets, "bash")
		? "allow"
		: "default";
}

// A real temp scripts dir: the structural check resolves real paths now, so an
// ALLOW must point at a file that exists inside a real `scripts/` dir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-scripts-"));
const scriptsDir = path.join(tmpRoot, "skills", "orchestrator", "plan-tracking", "scripts");
fs.mkdirSync(scriptsDir, { recursive: true });
const planList = path.join(scriptsDir, "plan-list.sh");
const planReport = path.join(scriptsDir, "plan-report.sh");
fs.writeFileSync(planList, "#!/bin/sh\nexit 0\n");
fs.writeFileSync(planReport, "#!/bin/sh\nexit 0\n");
const scriptsRealDir = fs.realpathSync(scriptsDir);
const dirs = [scriptsRealDir];

// A symlink inside the real scripts dir that points outside it.
const outsideDir = path.join(tmpRoot, "outside");
fs.mkdirSync(outsideDir, { recursive: true });
const outsideScript = path.join(outsideDir, "evil.sh");
fs.writeFileSync(outsideScript, "#!/bin/sh\necho evil\n");
const symlinkScript = path.join(scriptsDir, "link.sh");
fs.symlinkSync(outsideScript, symlinkScript);

// A fake interpreter binary outside the whitelist: the slash-form check must
// reject it, because only real interpreter paths are trusted.
const evilBinDir = path.join(tmpRoot, "evil-bin");
fs.mkdirSync(evilBinDir, { recursive: true });
const evilBash = path.join(evilBinDir, "bash");
fs.writeFileSync(evilBash, "#!/bin/sh\necho pwned\n");

// A directory named `x.sh` inside a real scripts dir: not a regular file, denied.
const dirNamedScript = path.join(scriptsDir, "x.sh");
fs.mkdirSync(dirNamedScript, { recursive: true });

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const ORCH_DIR = "/repo/skills/orchestrator/plan-tracking/scripts";

describe("skill scripts: structural segment check", () => {
	const allowed = [
		`bash ${planList}`,
		`${planList}`,
		`cd ${tmpRoot}/skills/orchestrator/plan-tracking && bash scripts/plan-list.sh`,
		`/bin/bash ${planList}`,
	];

	for (const command of allowed) {
		test(`allows ${command}`, () => {
			assert.equal(
				allSegmentsAreSkillScripts(command, new Set<number>(), dirs, tmpRoot, NO_RULES, "bash"),
				true,
				command,
			);
		});
	}

	const denied = [
		`bash ${ORCH_DIR}/evil.sh`,
		"bash /tmp/skills/orchestrator/plan-tracking/scripts/evil.sh",
		"bash /repo/skills/planner/task-decomposition/scripts/x.sh",
		// A slash-form interpreter look-alike must deny the segment, even when the
		// script token itself is a real skill script.
		`/tmp/x/bash ${planList}`,
		`${evilBash} ${planList}`,
		// A directory named like a script inside a real scripts dir is not a file.
		`bash ${dirNamedScript}`,
	];

	for (const command of denied) {
		test(`denies ${command}`, () => {
			assert.equal(
				allSegmentsAreSkillScripts(command, new Set<number>(), dirs, tmpRoot, NO_RULES, "bash"),
				false,
				command,
			);
		});
	}

	const adversarial = [
		// Escaped `..`: bash strips the backslashes and runs the outside file.
		`bash ${scriptsDir}/\\..\\..\\..\\..\\tmp/evil.sh`,
		// A raw backslash in a Windows-style path.
		`bash ${scriptsDir}\\..\\..\\outside\\evil.sh`,
		// Variable expansion: the token keeps `$`, so it is not a plain path.
		"bash $DIR/plan-list.sh",
		// A quoted path: the quotes are not a plain path.
		`bash "${planList}"`,
		`bash '${planList}'`,
		// A symlink inside the real scripts dir that points outside.
		`bash ${symlinkScript}`,
	];

	for (const command of adversarial) {
		test(`denies ${command}`, () => {
			assert.equal(
				allSegmentsAreSkillScripts(command, new Set<number>(), dirs, tmpRoot, NO_RULES, "bash"),
				false,
				command,
			);
		});
	}

	test("denies a bare script name with no path", () => {
		assert.equal(isAllowedSkillScript("plan-mark.sh x --status done", dirs, tmpRoot), false);
	});

	test("denies a non-.sh script", () => {
		assert.equal(isAllowedSkillScript(`bash ${scriptsDir}/evil.bash`, dirs, tmpRoot), false);
	});

	test("denies rm of a skill script (first token is rm)", () => {
		assert.equal(isAllowedSkillScript(`rm ${planList}`, dirs, tmpRoot), false);
	});

	test("denies an interpreter flag form (bash -x script.sh)", () => {
		assert.equal(isAllowedSkillScript(`bash -x ${planList}`, dirs, tmpRoot), false);
	});

	test("a cd base resolves a relative script path", () => {
		assert.equal(
			isAllowedSkillScript(
				`cd ${tmpRoot}/skills/orchestrator/plan-tracking && bash scripts/plan-list.sh`,
				dirs,
				tmpRoot,
			),
			true,
		);
	});

	test("without a regex allow rule a mixed command still falls through", () => {
		assert.equal(
			allSegmentsAreSkillScripts(
				`echo hi && bash ${planList}`,
				new Set<number>(),
				dirs,
				tmpRoot,
				NO_RULES,
				"bash",
			),
			false,
		);
	});
});

describe("skill scripts: mixed regex-allowed and skill-script segments", () => {
	const echoAllow: RuleSets = { ...NO_RULES, agentAllow: [{ tool: "bash", match: "^echo\\b" }] };

	test("a regex-allowed first segment may mix with a skill script", () => {
		assert.equal(
			allSegmentsAreSkillScripts(
				`echo hi && bash ${planList}`,
				new Set<number>(),
				dirs,
				tmpRoot,
				echoAllow,
				"bash",
			),
			true,
		);
	});

	test("a non-script segment without an allow rule still blocks the mix", () => {
		assert.equal(
			allSegmentsAreSkillScripts(
				`printf hi && bash ${planList}`,
				new Set<number>(),
				dirs,
				tmpRoot,
				echoAllow,
				"bash",
			),
			false,
		);
	});

	test("a user-approved segment may mix with a skill script", () => {
		assert.equal(
			allSegmentsAreSkillScripts(
				`printf hi && bash ${planList}`,
				new Set<number>([0]),
				dirs,
				tmpRoot,
				NO_RULES,
				"bash",
			),
			true,
		);
	});

	test("a session-allowed segment may mix with a skill script", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentAsk: [{ tool: "bash", match: "^printf\\b" }] };
		const isSessionAllowed = (rule: RawRule): boolean => rule.match === "^printf\\b";
		assert.equal(
			allSegmentsAreSkillScripts(
				`printf hi && bash ${planList}`,
				new Set<number>(),
				dirs,
				tmpRoot,
				ruleSets,
				"bash",
				isSessionAllowed,
			),
			true,
		);
	});

	test("a segment with no session allow still blocks the mix", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentAsk: [{ tool: "bash", match: "^printf\\b" }] };
		assert.equal(
			allSegmentsAreSkillScripts(
				`printf hi && bash ${planList}`,
				new Set<number>(),
				dirs,
				tmpRoot,
				ruleSets,
				"bash",
				() => false,
			),
			false,
		);
	});
});

describe("skill scripts: deny and ask precedence", () => {
	const command = `bash ${planList} x --status done`;

	test("an agent deny rule beats the structural allow", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentDeny: [{ tool: "bash", match: "plan-list\\.sh" }] };
		assert.equal(
			evaluateCommandRules(command, true, ruleSets, "deny-by-default", "bash", "orchestrator").kind,
			"deny",
		);
		assert.equal(verdict(ruleSets, command, dirs), "deny");
	});

	test("an agent ask rule beats the structural allow", () => {
		const ruleSets: RuleSets = { ...NO_RULES, agentAsk: [{ tool: "bash", match: "\\bsudo\\b" }] };
		const cmd = `bash ${planList} --by sudo`;
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

// ---------------------------------------------------------------------------
// Integration: drive the real gate handler, not a mirror of it.
// The handler is `tool_call` from `installPermissionGate`; a fresh gate loads an
// isolated (empty) global permissions file so the repo file cannot interfere.
// ---------------------------------------------------------------------------

const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "skill-gate-")),
	"permissions.json",
);
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

type ToolCallEvent = { toolName: string; input: Record<string, unknown> };
type ToolCallContext = { cwd: string; hasUI: boolean };
type ToolCallResult = { block?: boolean; reason?: string } | undefined;
type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ToolCallContext,
) => ToolCallResult | Promise<ToolCallResult>;

/** Install the real gate and return its captured `tool_call` handler. */
function installGateHandler(allow: PermissionRule[], deny: PermissionRule[] = []): ToolCallHandler {
	let captured: ToolCallHandler | null = null;
	const pi = {
		on(name: string, handler: ToolCallHandler): void {
			if (name === "tool_call") captured = handler;
		},
		events: { emit: (): void => {} },
	};
	const agent: AgentConfig = {
		name: "orchestrator",
		description: "integration test agent",
		systemPrompt: "",
		source: "package",
		filePath: "",
		skills: ["orchestrator/*", "common/simplified-technical-english"],
		permissions: { mode: "deny-by-default", allow, deny },
	};
	installPermissionGate(pi as unknown as ExtensionAPI, () => agent);
	assert.ok(captured, "the gate must register a tool_call handler");
	return captured;
}

function runHandler(handler: ToolCallHandler, command: string): ToolCallResult | Promise<ToolCallResult> {
	return handler({ toolName: "bash", input: { command } }, { cwd: repoRoot, hasUI: false });
}

describe("skill scripts: real gate handler", () => {
	const realScripts = fs.realpathSync(path.join(repoRoot, "skills/orchestrator/plan-tracking/scripts"));
	const realPlanList = path.join(realScripts, "plan-list.sh");
	const realPlanReport = path.join(realScripts, "plan-report.sh");
	const gitAllow: PermissionRule = {
		tool: "bash",
		match: "^(?:cd\\s+\\S+\\s*&&\\s*)?git(?:\\s+-C\\s+\\S+)?\\s+(status|log|diff|show|branch)\\b",
	};
	const mkdirAllow: PermissionRule = {
		tool: "bash",
		match: "^(cat|head|tail|sort|uniq|wc|grep|rg|ls|stat|od|pwd|date|echo|diff|cut|seq|mkdir|which|command -v|jq|bash -n)\\b",
	};

	test("a bare skill script is allowed", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `bash ${realPlanList}`);
		assert.notEqual(result?.block, true, JSON.stringify(result));
	});

	test("/bin/bash running a real skill script is allowed", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `/bin/bash ${realPlanList}`);
		assert.notEqual(result?.block, true, JSON.stringify(result));
	});

	test("a slash-form interpreter look-alike is blocked", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `/tmp/x/bash ${realPlanList}`);
		assert.equal(result?.block, true, JSON.stringify(result));
	});

	test("git status && plan-list.sh is allowed (regex-allowed first segment)", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `git status && bash ${realPlanList}`);
		assert.notEqual(result?.block, true, JSON.stringify(result));
	});

	test("mkdir && plan-report.sh is allowed", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(
			handler,
			`mkdir -p out && bash ${realPlanReport} --output out/r.md`,
		);
		assert.notEqual(result?.block, true, JSON.stringify(result));
	});

	test("an escaped .. traversal is blocked", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `bash ${realScripts}/\\..\\..\\..\\..\\tmp/evil.sh`);
		assert.equal(result?.block, true, JSON.stringify(result));
	});

	test("a variable path is blocked", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, "bash $DIR/plan-list.sh");
		assert.equal(result?.block, true, JSON.stringify(result));
	});

	test("a quoted path is blocked", async () => {
		const handler = installGateHandler([gitAllow, mkdirAllow]);
		const result = await runHandler(handler, `bash "${realPlanList}"`);
		assert.equal(result?.block, true, JSON.stringify(result));
	});

	test("a deny segment still blocks a mixed command", async () => {
		const handler = installGateHandler([gitAllow], [{ tool: "bash", match: "\\brm\\s+-rf\\b" }]);
		const result = await runHandler(handler, `rm -rf /tmp/x && bash ${realPlanList}`);
		assert.equal(result?.block, true, JSON.stringify(result));
	});
});
