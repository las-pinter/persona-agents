/**
 * Checks for the Claude Code subagent model hook (subagent-model.mjs).
 *
 * The PreToolUse hook on the Agent tool sets the model of every
 * persona-agents subagent except the orchestrator from the subagent_model
 * option. It reads the option live from the settings files, in the same order
 * as the theme lookup in context.mjs.
 *
 * Run: node --experimental-strip-types --test tests/claude-subagent-model.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { modelSettings } from "./plugin-options-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "platforms", "claude", "scripts", "subagent-model.mjs");

interface ModelRun {
	/** The parsed stdout, or null when the hook printed nothing. */
	output: { hookSpecificOutput: Record<string, unknown> } | null;
	stdout: string;
	status: number;
}

/** Raw text for the settings files of one hook run; a missing entry means no file. */
interface SettingsFiles {
	user?: string;
	managed?: string;
	/** Files in the managed-settings.d directory next to the managed file, by file name. */
	dropIns?: Record<string, string>;
	/** Extra env vars for the run; the value "<tmp>" at the start is replaced by the temp dir. */
	env?: Record<string, string>;
	/** The working directory, relative to the temp dir (default "work"); it is made when missing. */
	cwd?: string;
	/** Extra files to write, by path relative to the temp dir. */
	files?: Record<string, string>;
	/** Extra node arguments before the script, such as an --import preload. */
	nodeArgs?: string[];
}

/** A node --import argument for a preload module given as source text. */
function preload(source: string): string {
	return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

/** Preload source that makes os.userInfo() throw, as for a uid with no passwd entry. */
const failingUserInfo = [
	'import os from "node:os";',
	'import { syncBuiltinESMExports } from "node:module";',
	'os.userInfo = () => { throw new Error("no passwd entry"); };',
	"syncBuiltinESMExports();",
].join("\n");

/** realHome() as a child node process sees it under the given node arguments. */
function childRealHome(nodeArgs: string[]): string {
	const moduleUrl = pathToFileURL(path.join(repoRoot, "platforms", "claude", "scripts", "plugin-options.mjs")).href;
	const source = `import { realHome } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(realHome()));`;
	const run = spawnSync(process.execPath, [...nodeArgs, "--input-type=module", "-e", source], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout) as string;
}

/**
 * Run the hook the way Claude Code does: JSON on stdin, options in env.
 * The home, config dir, and managed file point into a temp dir, so the real settings never leak in.
 */
function runHook(stdin: string, envModel?: string, settings: SettingsFiles = {}): ModelRun {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-model-"));
	let result: SpawnSyncReturns<string>;
	try {
		const managedFile = path.join(tmp, "managed-settings.json");
		const configDir = path.join(tmp, ".claude");
		fs.mkdirSync(configDir);
		if (settings.user !== undefined) fs.writeFileSync(path.join(configDir, "settings.json"), settings.user);
		if (settings.managed !== undefined) fs.writeFileSync(managedFile, settings.managed);
		if (settings.dropIns !== undefined) {
			const dropInDir = path.join(tmp, "managed-settings.d");
			fs.mkdirSync(dropInDir);
			for (const [name, body] of Object.entries(settings.dropIns)) {
				fs.writeFileSync(path.join(dropInDir, name), body);
			}
		}
		for (const [rel, body] of Object.entries(settings.files ?? {})) {
			fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
			fs.writeFileSync(path.join(tmp, rel), body);
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PLUGIN_ROOT: repoRoot,
			HOME: tmp,
			CLAUDE_CONFIG_DIR: configDir,
		};
		delete env.CLAUDE_PLUGIN_OPTION_SUBAGENT_MODEL;
		delete env.CLAUDE_PROJECT_DIR;
		if (envModel !== undefined) env.CLAUDE_PLUGIN_OPTION_SUBAGENT_MODEL = envModel;
		for (const [key, value] of Object.entries(settings.env ?? {})) env[key] = value.replace(/^<tmp>/, tmp);
		// The default working dir is a sibling of HOME/.claude, not a parent of it.
		const cwd = path.join(tmp, settings.cwd ?? "work");
		fs.mkdirSync(cwd, { recursive: true });
		// The test seam: a hook argument, which a settings env block cannot set.
		result = spawnSync(process.execPath, [...(settings.nodeArgs ?? []), script, `--managed-settings=${managedFile}`], {
			input: stdin,
			env,
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	const stdout = result.stdout ?? "";
	return {
		output: stdout.trim() ? (JSON.parse(stdout) as ModelRun["output"]) : null,
		stdout,
		status: result.status ?? 1,
	};
}

/** A PreToolUse input for one Agent call. */
function agentInput(toolInput: Record<string, unknown>): string {
	return JSON.stringify({
		session_id: "s1",
		hook_event_name: "PreToolUse",
		tool_name: "Agent",
		tool_input: toolInput,
		tool_use_id: "t1",
	});
}

const implementerCall = { subagent_type: "persona-agents:implementer", description: "Fix it", prompt: "Fix the bug" };

/** The model the hook set, or null when it printed nothing. */
function modelOf(run: ModelRun): unknown {
	const updated = run.output?.hookSpecificOutput.updatedInput as Record<string, unknown> | undefined;
	return updated ? updated.model : null;
}

describe("claude plugin: subagent model hook", () => {
	for (const model of ["sonnet", "opus", "haiku"]) {
		test(`${model} sets the model, with no permission decision`, () => {
			const run = runHook(agentInput(implementerCall), undefined, { user: modelSettings(model) });
			assert.equal(run.status, 0);
			assert.deepEqual(run.output, {
				hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...implementerCall, model } },
			});
		});
	}

	test("inherit gives no output", () => {
		const run = runHook(agentInput({ ...implementerCall, model: "opus" }), undefined, {
			user: modelSettings("inherit"),
		});
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	});

	test("no option set means sonnet", () => {
		assert.equal(modelOf(runHook(agentInput(implementerCall))), "sonnet");
	});

	for (const bad of ["gpt-5", "Opus", "claude-opus-5-5"]) {
		test(`a bad value falls back to sonnet: ${bad}`, () => {
			assert.equal(modelOf(runHook(agentInput(implementerCall), undefined, { user: modelSettings(bad) })), "sonnet");
			assert.equal(modelOf(runHook(agentInput(implementerCall), bad, { user: "{}" })), "sonnet");
		});
	}

	test("every non-orchestrator persona-agents subagent gets the model", () => {
		for (const profession of ["implementer", "researcher", "tester", "reviewer", "planner", "mascot"]) {
			const run = runHook(agentInput({ ...implementerCall, subagent_type: `persona-agents:${profession}` }), undefined, {
				user: modelSettings("haiku"),
			});
			assert.equal(modelOf(run), "haiku", profession);
		}
	});

	test("the orchestrator gets no output", () => {
		const run = runHook(agentInput({ ...implementerCall, subagent_type: "persona-agents:orchestrator" }), undefined, {
			user: modelSettings("opus"),
		});
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	});

	test("a foreign or missing subagent_type gets no output", () => {
		for (const subagentType of ["Explore", "general-purpose", "other:persona-agents:implementer", 7, undefined]) {
			const run = runHook(agentInput({ ...implementerCall, subagent_type: subagentType }), undefined, {
				user: modelSettings("opus"),
			});
			assert.equal(run.status, 0);
			assert.equal(run.stdout, "", String(subagentType));
		}
	});

	test("a caller model is kept", () => {
		const run = runHook(agentInput({ ...implementerCall, model: "opus" }), undefined, { user: modelSettings("haiku") });
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	});

	test("a caller model equal to the selected model gives no output", () => {
		const run = runHook(agentInput({ ...implementerCall, model: "haiku" }), undefined, { user: modelSettings("haiku") });
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	});

	test("an empty or null caller model counts as absent", () => {
		for (const empty of ["", null]) {
			const run = runHook(agentInput({ ...implementerCall, model: empty }), undefined, { user: modelSettings("haiku") });
			assert.equal(modelOf(run), "haiku", String(empty));
		}
	});

	test("all other input fields are kept unchanged", () => {
		const call = {
			...implementerCall,
			run_in_background: true,
			isolation: "worktree",
			name: "fixer",
			extra: { nested: [1, "two", null] },
		};
		const run = runHook(agentInput(call), undefined, { user: modelSettings("opus") });
		assert.deepEqual(run.output?.hookSpecificOutput.updatedInput, { ...call, model: "opus" });
	});

	test("a throw in the option read exits 0 with no output", () => {
		// process.cwd() is a default argument of the user config lookup, so the option read throws.
		const run = runHook(agentInput(implementerCall), undefined, {
			user: modelSettings("opus"),
			nodeArgs: [preload('process.cwd = () => { throw new Error("no cwd"); };')],
		});
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
	});

	test("a failing passwd lookup still reads the user settings under HOME", () => {
		// Sanity check: the preload must make realHome() give "".
		assert.equal(childRealHome([preload(failingUserInfo)]), "");
		const run = runHook(agentInput(implementerCall), undefined, {
			user: modelSettings("opus"),
			env: { CLAUDE_CONFIG_DIR: "" },
			nodeArgs: [preload(failingUserInfo)],
		});
		assert.equal(modelOf(run), "opus");
	});

	test("malformed stdin exits 0 with no output", () => {
		for (const stdin of ["", "{ not json", "null", "[]", JSON.stringify({ tool_input: null })]) {
			const run = runHook(stdin, undefined, { user: modelSettings("opus") });
			assert.equal(run.status, 0, stdin);
			assert.equal(run.stdout, "", stdin);
		}
	});

	describe("option lookup at hook run time", () => {
		test("the user settings value wins over the env var", () => {
			const run = runHook(agentInput(implementerCall), "opus", { user: modelSettings("haiku") });
			assert.equal(modelOf(run), "haiku");
		});

		// A project .claude/settings.json env block can set the env var, so the hook does not read it.
		test("the env var is ignored; with no settings value the default applies", () => {
			assert.equal(modelOf(runHook(agentInput(implementerCall), "opus", { user: "{}" })), "sonnet");
			assert.equal(modelOf(runHook(agentInput(implementerCall), "inherit")), "sonnet");
		});

		test("the managed settings value wins over the user settings value", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				managed: modelSettings("opus"),
				user: modelSettings("haiku"),
			});
			assert.equal(modelOf(run), "opus");
		});

		test("a drop-in value wins over the managed-settings.json value", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				managed: modelSettings("opus"),
				dropIns: { "10-model.json": modelSettings("haiku") },
			});
			assert.equal(modelOf(run), "haiku");
		});

		test("of two drop-ins, the later one in alphabetical order wins", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				user: modelSettings("sonnet"),
				dropIns: { "20-b.json": modelSettings("haiku"), "10-a.json": modelSettings("opus") },
			});
			assert.equal(modelOf(run), "haiku");
		});

		test("a managed inherit gives no output over a user model", () => {
			const run = runHook(agentInput(implementerCall), "opus", {
				managed: modelSettings("inherit"),
				user: modelSettings("haiku"),
			});
			assert.equal(run.stdout, "");
		});

		test("a bad managed file falls through to the user settings value", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				managed: "{ not json",
				user: modelSettings("opus"),
			});
			assert.equal(modelOf(run), "opus");
		});

		const unsetManaged: Record<string, unknown> = { "an empty string": "", "a number": 7 };
		for (const [label, value] of Object.entries(unsetManaged)) {
			test(`a managed value that is ${label} falls through to the user value`, () => {
				const body = JSON.stringify({
					pluginConfigs: { "persona-agents@persona-agents": { options: { subagent_model: value } } },
				});
				const run = runHook(agentInput(implementerCall), undefined, {
					managed: body,
					dropIns: { "10-x.json": body },
					user: modelSettings("opus"),
				});
				assert.equal(modelOf(run), "opus");
			});
		}
	});

	describe("project env cannot redirect the settings files", () => {
		test("PERSONA_AGENTS_MANAGED_SETTINGS from the env is ignored", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				user: modelSettings("opus"),
				files: { "repo/managed-settings.json": modelSettings("haiku") },
				env: { PERSONA_AGENTS_MANAGED_SETTINGS: "<tmp>/repo/managed-settings.json" },
			});
			assert.equal(modelOf(run), "opus");
		});

		// The user settings stay under HOME/.claude (the temp dir); the planted dir sets another model.
		const planted = { "repo/.claude/settings.json": modelSettings("haiku") };

		test("a CLAUDE_CONFIG_DIR inside the working directory is ignored", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				user: modelSettings("opus"),
				files: planted,
				cwd: "repo",
				env: { CLAUDE_CONFIG_DIR: "<tmp>/repo/.claude" },
			});
			assert.equal(modelOf(run), "opus");
		});

		test("a CLAUDE_CONFIG_DIR inside CLAUDE_PROJECT_DIR is ignored", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				user: modelSettings("opus"),
				files: planted,
				env: { CLAUDE_PROJECT_DIR: "<tmp>/repo", CLAUDE_CONFIG_DIR: "<tmp>/repo/.claude" },
			});
			assert.equal(modelOf(run), "opus");
		});

		test("a CLAUDE_CONFIG_DIR outside the project still applies", () => {
			const run = runHook(agentInput(implementerCall), undefined, {
				user: modelSettings("opus"),
				files: planted,
				cwd: "work",
				env: { CLAUDE_PROJECT_DIR: "<tmp>/work", CLAUDE_CONFIG_DIR: "<tmp>/repo/.claude" },
			});
			assert.equal(modelOf(run), "haiku");
		});
	});

	test("a prompt of about 1 MB comes back whole", () => {
		const call = { ...implementerCall, prompt: "x".repeat(1024 * 1024) };
		const run = runHook(agentInput(call), undefined, { user: modelSettings("opus") });
		assert.equal(run.status, 0);
		assert.deepEqual(run.output?.hookSpecificOutput.updatedInput, { ...call, model: "opus" });
	});
});
