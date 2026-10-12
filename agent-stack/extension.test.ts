/**
 * Extension skill-injection tests (study task T12, finding F18).
 *
 * The pi `before_agent_start` handler injects two payloads:
 *   - `alwaysLoad` — the full skill body (mandatory, budgeted); and
 *   - `skills:` — an on-demand index of name, description, and path.
 *
 * These tests drive the real extension factory with a fake pi, so they fail if
 * the index contract drifts back to full-body injection for `skills:`.
 *
 * Fixtures are written to a temp dir at run time and removed after. The test is
 * hermetic: it never reads or writes the operator's agent-notes tree.
 *
 * Run: npm test
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";
import type { AgentConfig } from "./resolver.ts";
import { setActiveAgent, setActivePersona } from "./state.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
}

/** A fake pi that records `on` handlers; every other method is a no-op. */
function makePi(): Harness {
	const handlers = new Map<string, Handler[]>();
	const noop = (): void => {};
	const pi: Record<string, unknown> = {
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
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

/** Run every `before_agent_start` handler and return the final prompt. */
async function promptFor(harness: Harness, cwd: string): Promise<string> {
	let prompt = "BASE";
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		const result = (await handler({ systemPrompt: prompt }, { cwd })) as
			| { systemPrompt?: string }
			| undefined;
		if (result?.systemPrompt) prompt = result.systemPrompt;
	}
	return prompt;
}

function testAgent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		name: "test-agent",
		description: "test agent",
		systemPrompt: "PROFESSION BODY",
		source: "package",
		filePath: "",
		...overrides,
	};
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ext-skill-injection-"));
const skillsRoot = path.join(tmpRoot, ".pi", "skills");

/** Write a fixture skill with a unique body marker. `bodyBytes` pads the body. */
function writeSkill(name: string, description: string, bodyMarker: string, bodyBytes = 0): string {
	const dir = path.join(skillsRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	const padding = bodyBytes > 0 ? `\n${"x".repeat(bodyBytes)}` : "";
	const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${bodyMarker}${padding}\n`;
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, content);
	return file;
}

const indexSkillPath = writeSkill("fixture-index", "Index fixture description.", "INDEX_BODY_MARKER");
writeSkill("fixture-mandatory", "Mandatory fixture description.", "MANDATORY_BODY_MARKER");
writeSkill("fixture-both", "Both-lists fixture description.", "BOTH_BODY_MARKER");
writeSkill("fixture-overcap-a", "Overcap fixture A.", "OVERCAP_A", 13_000);
writeSkill("fixture-overcap-b", "Overcap fixture B.", "OVERCAP_B", 13_000);

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("skills: injects an on-demand index of name, description, and path", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ skills: ["fixture-index"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Agent skills for "test-agent" \(on-demand index\)/);
	assert.match(prompt, /Read a skill file when the task matches its description/);
	assert.match(prompt, /- fixture-index: Index fixture description\./);
	assert.ok(prompt.includes(`path: ${indexSkillPath}`), "the index must carry the skill path");
	assert.doesNotMatch(prompt, /INDEX_BODY_MARKER/, "the skill body must not be injected");
});

test("alwaysLoad: still injects the full skill body", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-mandatory"], skills: ["fixture-index"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Mandatory skill: fixture-mandatory/);
	assert.match(prompt, /MANDATORY_BODY_MARKER/, "the mandatory body must be injected");
	assert.match(prompt, /on-demand index/, "the on-demand index still injects alongside");
	assert.doesNotMatch(prompt, /INDEX_BODY_MARKER/);
});

test("a skill in both lists is injected once, as a full mandatory body", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-both"], skills: ["fixture-both"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Mandatory skill: fixture-both/);
	assert.match(prompt, /BOTH_BODY_MARKER/);
	assert.doesNotMatch(prompt, /on-demand index/, "alwaysLoad wins and the skill is not indexed");
	assert.doesNotMatch(prompt, /- fixture-both:/, "the deduped skill is not an index entry");
});

test("missing alwaysLoad entries warn and leave a visible marker", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-does-not-exist"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /MISSING skill for alwaysLoad entry: fixture-does-not-exist/);
});

test("alwaysLoad bodies stay under the 12 KB cap and the 24 KB budget", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-overcap-a", "fixture-overcap-b"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, />> SKILL TRUNCATED: fixture-overcap-a/);
	assert.match(prompt, />> SKILL TRUNCATED: fixture-overcap-b/);
	// Two 13 KB bodies would be ~26 KB; the budget forces the second body out.
	assert.ok(prompt.length < 24 * 1024, `prompt length ${prompt.length} must stay under the budget`);
});
