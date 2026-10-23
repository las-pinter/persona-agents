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
import { inProject, managedOption, realHome, settingsOption, userConfigDir } from "../platforms/claude/scripts/plugin-options.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(repoRoot, ".claude-plugin", "plugin.json");
const hooksFile = path.join(repoRoot, "platforms", "claude", "hooks", "hooks.json");
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

/** A settings file body that selects a subagent model, the way /config writes it. */
function modelSettings(model: string): string {
	return JSON.stringify({
		pluginConfigs: { "persona-agents@persona-agents": { options: { subagent_model: model } } },
	});
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

describe("claude plugin: subagent model option and hook entry", () => {
	test("the manifest offers the subagent_model option with default sonnet", () => {
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
			userConfig: Record<string, { type: string; title: string; options: string[]; default: string }>;
		};
		const option = manifest.userConfig.subagent_model;
		assert.ok(option, "plugin.json userConfig must have subagent_model");
		assert.equal(option.type, "string");
		assert.equal(option.title, "Subagent model");
		assert.deepEqual(option.options, ["sonnet", "opus", "haiku", "inherit"]);
		assert.equal(option.default, "sonnet");
	});

	test("hooks.json runs the script on the Agent and Task tools, in exec form", () => {
		const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as {
			hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; args: string[] }> }> };
		};
		const group = hooks.hooks.PreToolUse.find((entry) => entry.matcher === "^(Agent|Task)$");
		assert.ok(group, "PreToolUse must have an ^(Agent|Task)$ entry");
		const matcher = new RegExp(group.matcher);
		assert.ok(matcher.test("Agent") && matcher.test("Task") && !matcher.test("AgentX"));
		assert.equal(group.hooks.length, 1);
		assert.equal(group.hooks[0].command, "node");
		assert.deepEqual(group.hooks[0].args, ["${CLAUDE_PLUGIN_ROOT}/platforms/claude/scripts/subagent-model.mjs"]);
		const doctrine = hooks.hooks.PreToolUse.find((entry) => entry.matcher === "^(Bash|Edit|Write|NotebookEdit)$");
		assert.ok(doctrine, "the doctrine entry must stay");
	});
});

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

	test("a model the caller passed is overwritten", () => {
		const run = runHook(agentInput({ ...implementerCall, model: "opus" }), undefined, { user: modelSettings("haiku") });
		assert.equal(modelOf(run), "haiku");
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

		const unsetManaged: Record<string, unknown> = { "an empty string": "", "a number": 7, null: null, "an object": {} };
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

describe("plugin-options: explicit-path readers", () => {
	const withTmp = (fn: (tmp: string) => void) => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-options-"));
		try {
			fn(tmp);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	};

	test("settingsOption reads one key and gives '' for a missing, bad, or non-string value", () => {
		withTmp((tmp) => {
			const file = path.join(tmp, "s.json");
			assert.equal(settingsOption(file, "subagent_model"), "");
			fs.writeFileSync(file, modelSettings("haiku"));
			assert.equal(settingsOption(file, "subagent_model"), "haiku");
			assert.equal(settingsOption(file, "theme"), "");
			fs.writeFileSync(file, "{ not json");
			assert.equal(settingsOption(file, "subagent_model"), "");
			fs.writeFileSync(file, JSON.stringify({ pluginConfigs: { "persona-agents@persona-agents": { options: { x: 1 } } } }));
			assert.equal(settingsOption(file, "x"), "");
		});
	});

	test("managedOption: the last drop-in that sets the value wins, else the managed file", () => {
		withTmp((tmp) => {
			const managed = path.join(tmp, "managed-settings.json");
			const dir = path.join(tmp, "managed-settings.d");
			assert.equal(managedOption(managed, "subagent_model"), "");
			fs.writeFileSync(managed, modelSettings("opus"));
			assert.equal(managedOption(managed, "subagent_model"), "opus");
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "10-a.json"), modelSettings("haiku"));
			fs.writeFileSync(path.join(dir, "20-b.json"), modelSettings(""));
			fs.writeFileSync(path.join(dir, ".hidden.json"), modelSettings("sonnet"));
			assert.equal(managedOption(managed, "subagent_model"), "haiku");
		});
	});

	test("userConfigDir ignores a CLAUDE_CONFIG_DIR inside the project or the working directory", () => {
		withTmp((tmp) => {
			const project = path.join(tmp, "repo");
			const outside = path.join(tmp, "config");
			assert.equal(userConfigDir({ CLAUDE_CONFIG_DIR: outside }, project), outside);
			assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: path.join(project, ".c") }, project), path.join(project, ".c"));
			assert.notEqual(
				userConfigDir({ CLAUDE_CONFIG_DIR: path.join(project, "x"), CLAUDE_PROJECT_DIR: project }, outside),
				path.join(project, "x"),
			);
			assert.ok(inProject(project, {}, project));
			assert.ok(!inProject(path.join(tmp, "repo2"), {}, project), "a sibling with a shared prefix is outside");
		});
	});

	// A home dir made in a temp dir, injected as the passwd home: a project dir there, or above it,
	// must not hide a custom config dir under home.
	const withHome = (fn: (home: string, tmp: string) => void) =>
		withTmp((tmp) => {
			const home = path.join(tmp, "parent", "home");
			fs.mkdirSync(home, { recursive: true });
			fn(home, tmp);
		});

	test("userConfigDir keeps a custom CLAUDE_CONFIG_DIR under home when the cwd is home", () => {
		withHome((home) => {
			const workDir = path.join(home, ".claude-work");
			assert.equal(userConfigDir({ CLAUDE_CONFIG_DIR: workDir }, home, home), workDir);
		});
	});

	test("userConfigDir keeps a custom CLAUDE_CONFIG_DIR under home when CLAUDE_PROJECT_DIR is home", () => {
		withHome((home, tmp) => {
			const workDir = path.join(home, ".claude-work");
			assert.equal(userConfigDir({ CLAUDE_CONFIG_DIR: workDir, CLAUDE_PROJECT_DIR: home }, tmp, home), workDir);
		});
	});

	test("userConfigDir keeps a custom CLAUDE_CONFIG_DIR under home when the cwd is a parent of home", () => {
		withHome((home) => {
			const workDir = path.join(home, ".claude-work");
			assert.equal(userConfigDir({ CLAUDE_CONFIG_DIR: workDir }, path.dirname(home), home), workDir);
		});
	});

	test("a normal project dir still blocks a CLAUDE_CONFIG_DIR inside it", () => {
		withHome((home, tmp) => {
			const project = path.join(tmp, "repo");
			const planted = path.join(project, ".claude");
			assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: planted }, project, home), planted);
			assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: planted, CLAUDE_PROJECT_DIR: project }, home, home), planted);
		});
	});

	test("with a failing home lookup, HOME applies and the home exemption is off", () => {
		withHome((home) => {
			const workDir = path.join(home, ".claude-work");
			// No passwd home: a project at home blocks a config dir in it.
			assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: workDir }, home, ""), workDir);
			assert.ok(inProject(workDir, {}, home, ""));
		});
	});

	test("with a failing home lookup, a HOME inside the project gives no user config dir", () => {
		withTmp((tmp) => {
			const project = path.join(tmp, "repo");
			const outside = path.join(tmp, "outside");
			fs.mkdirSync(project, { recursive: true });
			const savedHome = process.env.HOME;
			try {
				process.env.HOME = project;
				assert.equal(userConfigDir({}, project, ""), "");
				assert.equal(userConfigDir({ CLAUDE_PROJECT_DIR: project }, outside, ""), "");
				// A planted CLAUDE_CONFIG_DIR does not bring the project back either.
				assert.equal(userConfigDir({ CLAUDE_CONFIG_DIR: path.join(project, ".claude") }, project, ""), "");
				process.env.HOME = outside;
				assert.equal(userConfigDir({}, project, ""), path.join(outside, ".claude"));
			} finally {
				if (savedHome === undefined) delete process.env.HOME;
				else process.env.HOME = savedHome;
			}
		});
	});

	test("realHome gives a string and does not throw", () => {
		assert.equal(typeof realHome(), "string");
	});

	// Runs only where the file system ignores case (detected at run time, not from the OS name).
	const caseInsensitive = (() => {
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-Case-"));
		try {
			return fs.existsSync(path.join(path.dirname(probe), path.basename(probe).toLowerCase()));
		} finally {
			fs.rmSync(probe, { recursive: true, force: true });
		}
	})();

	test(
		"a CLAUDE_CONFIG_DIR with other letter case inside the project is ignored",
		{ skip: caseInsensitive ? false : "the file system is case-sensitive" },
		() => {
			withTmp((tmp) => {
				const project = path.join(tmp, "Repo");
				fs.mkdirSync(path.join(project, ".cfg"), { recursive: true });
				const planted = path.join(tmp, "repo", ".cfg");
				assert.ok(inProject(planted, {}, project, ""));
				assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: planted }, project, ""), planted);
			});
		},
	);
});
