/**
 * Child prompt text: the profession body, the always-load skill bodies, and the
 * persona body travel with the child, because the child loads no extension and
 * its start hook never runs.
 *
 * The skill fixture is the package's own `common/shell-discipline`, so a case
 * proves the real body reaches the prompt.
 *
 * Run: npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { childRoleText, childTaskPrompt } from "./child-prompt.ts";
import { type AgentConfig, type PersonaConfig, discoverSkills, matchSkills } from "./resolver.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The agent body a case looks for in the prompt. */
const AGENT_BODY = "PROFESSION-BODY: implementer rules live here.";

/** The persona body a case looks for in the prompt. */
const PERSONA_BODY = "PERSONA-BODY: short, plain words, hands on the tools.";

/** One agent with a distinctive body and one always-load pattern. */
function agentOf(alwaysLoad: string[]): AgentConfig {
	return {
		name: "implementer",
		description: "child prompt fixture",
		systemPrompt: AGENT_BODY,
		alwaysLoad,
		source: "package",
		filePath: "",
		permissionClass: "worker",
	};
}

/** One persona with a distinctive body. */
const PERSONA: PersonaConfig = {
	name: "grubnik",
	theme: "goblin",
	body: PERSONA_BODY,
	filePath: "",
	fileNameStem: "grubnik",
};

test("prompt: the child carries the profession, the skill bodies, and the persona", () => {
	const agent = agentOf(["common/shell-discipline"]);
	const discovered = discoverSkills(REPO_ROOT);
	const alwaysLoad = matchSkills(agent.alwaysLoad ?? [], discovered);
	assert.equal(alwaysLoad.length, 1, "the package skill resolves from the repository");

	const text = childTaskPrompt(childRoleText({ agent, persona: PERSONA, alwaysLoad }), "do the task");

	assert.match(text, new RegExp(AGENT_BODY), "the profession body is in the prompt");
	assert.ok(text.includes(alwaysLoad[0].body), "the whole mandatory skill body is in the prompt");
	assert.match(text, /## Mandatory skill: common\/shell-discipline/);
	assert.match(text, new RegExp(PERSONA_BODY), "the persona text is in the prompt");
	assert.match(text, /Task: do the task/, "the task follows the role text");
});

test("prompt: an always-load pattern that resolves to no skill is marked", () => {
	const agent = agentOf(["common/no-such-skill"]);
	const discovered = discoverSkills(REPO_ROOT);
	const text = childRoleText({
		agent,
		persona: null,
		alwaysLoad: matchSkills(agent.alwaysLoad ?? [], discovered),
		missingPatterns: ["common/no-such-skill"],
	});

	assert.match(text, /MISSING skill for alwaysLoad entry: common\/no-such-skill/);
});
