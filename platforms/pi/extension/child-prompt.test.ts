/**
 * Child prompt text: the profession body, the always-load skill bodies, and the
 * persona body travel with the child, because the child loads no extension and
 * its start hook never runs.
 *
 * The skill fixture is the package's own `common/shell-discipline`, so a case
 * proves the real body reaches the prompt.
 *
 * One case drives the real extension factory, so the root prompt and the child
 * prompt must carry the same persona block. One case reads the two callers'
 * source, so a pasted copy of the block turns it red.
 *
 * Run: npm test
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childRoleText, childTaskPrompt } from "./child-prompt.ts";
import extension from "./extension.ts";
import { PERSONA_HEADING, formatPersonaId, personaBlock, personaLabel } from "./persona-text.ts";
import { type AgentConfig, type PersonaConfig } from "./resolver.ts";
import { discoverSkills, matchSkills } from "./skill-discovery.ts";
import { setActiveAgent, setActivePersona } from "./state.ts";

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

after(() => {
	// The factory writes module state, so this file leaves none of it behind.
	setActiveAgent(null);
	setActivePersona(null);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The root prompt the real extension factory builds for one active persona. */
async function rootPromptFor(persona: PersonaConfig): Promise<string> {
	const handlers = new Map<string, Handler[]>();
	const noop = (): void => {};
	const fake: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: noop,
		registerTool: noop,
		registerFlag: noop,
		getFlag: () => undefined,
		getSettings: () => ({}),
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	extension(fake as unknown as ExtensionAPI);
	setActiveAgent(null);
	setActivePersona(persona);
	let prompt = "BASE";
	for (const handler of handlers.get("before_agent_start") ?? []) {
		const result = (await handler({ systemPrompt: prompt }, { cwd: REPO_ROOT })) as
			| { systemPrompt?: string }
			| undefined;
		if (result?.systemPrompt) prompt = result.systemPrompt;
	}
	return prompt;
}

test("prompt: the root and the child carry one and the same persona block", async () => {
	const block = personaBlock(PERSONA);
	const child = childRoleText({ agent: agentOf([]), persona: PERSONA, alwaysLoad: [] });
	const root = await rootPromptFor(PERSONA);

	assert.ok(block.startsWith(`\n\n${PERSONA_HEADING}`), "the block opens with the heading");
	assert.ok(block.includes(PERSONA_BODY), "the block carries the persona body");
	assert.ok(child.endsWith(block), "the child prompt ends with the one block");
	assert.ok(root.endsWith(block), "the root prompt ends with the same block");
});

test("source: only persona-text.ts holds the persona block literal", () => {
	for (const file of ["extension.ts", "child-prompt.ts"]) {
		const source = fs.readFileSync(path.join(REPO_ROOT, "platforms", "pi", "extension", file), "utf-8");
		assert.ok(!source.includes(PERSONA_HEADING), `${file} must not hold the persona heading literal`);
		assert.ok(
			!source.includes("Ignore any earlier plain-voice context"),
			`${file} must not hold the persona rule literal`,
		);
	}
	// The builder holds the literal, so the two cases above cannot pass by luck.
	const owner = fs.readFileSync(path.join(REPO_ROOT, "platforms", "pi", "extension", "persona-text.ts"), "utf-8");
	assert.ok(owner.includes(PERSONA_HEADING), "the builder owns the literal");
});

test("label: a persona with no theme still yields one label", () => {
	assert.equal(personaLabel("goblin", "grubnik"), "goblin/grubnik");
	assert.equal(personaLabel(undefined, "grubnik"), "grubnik", "no theme yields the bare name");
	assert.equal(personaLabel("goblin", "grubnik"), formatPersonaId(PERSONA));
});

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
