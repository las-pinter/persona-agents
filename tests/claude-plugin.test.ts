/**
 * Checks for the Claude Code plugin (.claude-plugin/ + platforms/claude/).
 *
 * The plugin copies no content: each agent file is frontmatter only, and the
 * context hook reads the profession and the persona from content/ at run time.
 * These tests keep the manifest in step with content/ and keep every hook
 * string under Claude Code's 10,000-character cap, so no profession or persona
 * is ever cut to a preview.
 *
 * Run: node --experimental-strip-types --test tests/claude-plugin.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const manifestFile = path.join(repoRoot, ".claude-plugin", "plugin.json");
const hooksFile = path.join(repoRoot, "platforms", "claude", "hooks", "hooks.json");
const contextScript = path.join(repoRoot, "platforms", "claude", "scripts", "context.mjs");

/** Claude Code replaces a longer hook string with a 2,000-character preview. */
const HOOK_STRING_CAP = 10_000;

/** Skills the plugin leaves out on purpose, with the reason. */
const EXCLUDED_SKILLS: Record<string, string> = {
	"orchestrator/retro": "reads pi session files only",
};

interface Manifest {
	name: string;
	agents: string[];
	skills: string[];
	hooks: string;
	userConfig: { theme: { options: string[]; default: string } };
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
const registry = JSON.parse(fs.readFileSync(path.join(contentDir, "agents.json"), "utf8")) as Record<
	string,
	Record<string, unknown>
>;
const professions = fs
	.readdirSync(path.join(contentDir, "professions"))
	.filter((name) => name.endsWith(".md"))
	.map((name) => name.replace(/\.md$/, ""))
	.sort();
const themes = Object.keys(registry).sort();

/** A manifest path ("./x/y") as an absolute path. */
function fromManifest(rel: string): string {
	return path.join(repoRoot, rel);
}

interface HookRun {
	context: string | null;
	eventName: string | null;
	stderr: string;
	status: number;
}

/** Run the context hook the way Claude Code does: JSON on stdin, options in env. */
function runContext(part: string, input: Record<string, unknown>, theme?: string): HookRun {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: repoRoot };
	delete env.CLAUDE_PLUGIN_OPTION_THEME;
	delete env.PERSONA_AGENTS_DEBUG;
	if (theme !== undefined) env.CLAUDE_PLUGIN_OPTION_THEME = theme;
	const result = spawnSync(process.execPath, [contextScript, part], {
		input: JSON.stringify(input),
		env,
		encoding: "utf8",
	});
	const stdout = result.stdout ?? "";
	const output = stdout.trim()
		? (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } })
		: null;
	return {
		context: output?.hookSpecificOutput.additionalContext ?? null,
		eventName: output?.hookSpecificOutput.hookEventName ?? null,
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

function subagentInput(profession: string): Record<string, unknown> {
	return { hook_event_name: "SubagentStart", agent_type: `persona-agents:${profession}`, agent_id: "a1" };
}

describe("claude plugin: agents", () => {
	test("one agent per profession, no more, no less", () => {
		const listed = manifest.agents.map((rel) => path.basename(rel, ".md")).sort();
		assert.deepEqual(listed, professions);
	});

	for (const rel of manifest.agents) {
		test(`${rel} is frontmatter only and names itself`, () => {
			const text = fs.readFileSync(fromManifest(rel), "utf8");
			const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
			assert.ok(match, "the file must be one frontmatter block");
			// A non-empty body would replace Claude Code's system prompt and copy content.
			assert.equal(match[2].trim(), "", "the agent body must be empty");
			assert.match(match[1], new RegExp(`^name: ${path.basename(rel, ".md")}$`, "m"));
			assert.match(match[1], /^description: \S/m);
		});
	}
});

describe("claude plugin: skills", () => {
	const listed = new Set(manifest.skills.map((rel) => path.relative(path.join(contentDir, "skills"), fromManifest(rel))));
	const all = fs
		.readdirSync(path.join(contentDir, "skills"))
		.flatMap((group) =>
			fs.readdirSync(path.join(contentDir, "skills", group)).map((name) => `${group}/${name}`),
		)
		.filter((rel) => fs.existsSync(path.join(contentDir, "skills", rel, "SKILL.md")));

	test("every skill is listed or excluded on purpose", () => {
		const missing = all.filter((rel) => !listed.has(rel) && !(rel in EXCLUDED_SKILLS));
		assert.deepEqual(missing, [], "add the skill to plugin.json skills, or to EXCLUDED_SKILLS with a reason");
	});

	test("no excluded skill is listed", () => {
		assert.deepEqual(
			Object.keys(EXCLUDED_SKILLS).filter((rel) => listed.has(rel)),
			[],
		);
	});

	test("every listed skill folder holds a SKILL.md", () => {
		for (const rel of manifest.skills) {
			assert.ok(fs.existsSync(path.join(fromManifest(rel), "SKILL.md")), rel);
		}
	});
});

describe("claude plugin: theme option and hooks", () => {
	test("the theme picker offers exactly the agents.json themes", () => {
		assert.deepEqual([...manifest.userConfig.theme.options].sort(), themes);
		assert.ok(themes.includes(manifest.userConfig.theme.default), "the default theme must exist");
	});

	test("both start events run the profession and the persona part", () => {
		assert.equal(fromManifest(manifest.hooks), hooksFile);
		const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as {
			hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ args: string[] }> }>>;
		};
		for (const event of ["SessionStart", "SubagentStart"]) {
			const parts = hooks.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.args.at(-1)));
			assert.deepEqual(parts.sort(), ["persona", "profession"], event);
		}
		assert.equal(hooks.hooks.SubagentStart[0].matcher, "^persona-agents:");
	});
});

describe("claude plugin: context hook", () => {
	for (const profession of professions) {
		test(`${profession}: the profession part is the file, verbatim, under the cap`, () => {
			const run = runContext("profession", subagentInput(profession));
			const file = fs.readFileSync(path.join(contentDir, "professions", `${profession}.md`), "utf8").trim();
			assert.equal(run.context, file);
			assert.equal(run.eventName, "SubagentStart");
			assert.ok(file.length < HOOK_STRING_CAP, `${profession}.md is ${file.length} characters`);
		});
	}

	test("every theme × profession persona part fits under the cap", () => {
		for (const theme of themes) {
			for (const profession of professions) {
				const run = runContext("persona", subagentInput(profession), theme);
				assert.ok(run.context, `${theme}/${profession}: no persona context`);
				assert.match(run.context, new RegExp(`persona theme: ${theme}\\)`));
				assert.ok(
					run.context.length < HOOK_STRING_CAP,
					`${theme}/${profession}: ${run.context.length} characters`,
				);
			}
		}
	});

	test("the main session gets the same parts through SessionStart", () => {
		const input = { hook_event_name: "SessionStart", source: "startup", agent_type: "persona-agents:orchestrator" };
		const run = runContext("profession", input);
		assert.equal(run.eventName, "SessionStart");
		assert.match(run.context ?? "", /^# Orchestrator/);
	});

	test("no option set means the goblin theme", () => {
		assert.match(runContext("persona", subagentInput("implementer")).context ?? "", /persona theme: goblin\)/);
	});

	test("a plain session and a foreign agent get no output", () => {
		for (const input of [
			{ hook_event_name: "SessionStart", source: "startup" },
			{ hook_event_name: "SubagentStart", agent_type: "Explore", agent_id: "a2" },
		]) {
			for (const part of ["profession", "persona"]) {
				const run = runContext(part, input);
				assert.equal(run.status, 0);
				assert.equal(run.context, null, `${part}: ${JSON.stringify(input)}`);
			}
		}
	});

	test("an unknown theme warns and still sends the profession", () => {
		const persona = runContext("persona", subagentInput("tester"), "nosuch");
		assert.equal(persona.status, 0);
		assert.equal(persona.context, null);
		assert.match(persona.stderr, /no nosuch persona for tester/);
		assert.ok(runContext("profession", subagentInput("tester"), "nosuch").context);
	});
});
