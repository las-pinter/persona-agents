/**
 * Checks for the Claude Code context hook (context.mjs).
 *
 * The hook reads the companion profession and the persona from content/ at run time.
 * These tests run the hook and keep every hook string under Claude Code's
 * 10,000-character cap, so no profession or persona is cut to a preview.
 *
 * Run: node --experimental-strip-types --test tests/claude-plugin.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const manifestFile = path.join(repoRoot, ".claude-plugin", "plugin.json");
const contextScript = path.join(repoRoot, "platforms", "claude", "scripts", "context.mjs");

/** Claude Code replaces a longer hook string with a 2,000-character preview. */
const HOOK_STRING_CAP = 10_000;

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

interface HookRun {
	context: string | null;
	eventName: string | null;
	stderr: string;
	status: number;
}

/** Raw text for the settings files of one hook run; a missing entry means no file. */
interface SettingsFiles {
	user?: string;
	managed?: string;
	/** Files in the managed-settings.d directory next to the managed file, by file name. */
	dropIns?: Record<string, string>;
	/** Subdirectories to make in the managed-settings.d directory, by name. */
	dropInDirs?: string[];
	/** Leave CLAUDE_CONFIG_DIR unset, so the hook uses the .claude folder under HOME. */
	noConfigDir?: boolean;
	/** Extra node arguments before the script, such as an --import preload. */
	nodeArgs?: string[];
}

/** A node --import argument for a preload module given as source text. */
function preload(source: string): string {
	return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

/** A settings file body that selects a theme, the way /config writes it. */
function themeSettings(theme: string): string {
	return JSON.stringify({ pluginConfigs: { "persona-agents@persona-agents": { options: { theme } } } });
}

/**
 * Run the context hook the way Claude Code does: JSON on stdin, options in env.
 * The home, config dir, and managed file point into a temp dir, so the real settings never leak in.
 */
function runContext(
	part: string,
	input: Record<string, unknown>,
	theme?: string,
	settings: SettingsFiles = {},
): HookRun {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-context-"));
	let result: SpawnSyncReturns<string>;
	try {
		const managedFile = path.join(tmp, "managed-settings.json");
		// The default config dir under HOME, so a run without CLAUDE_CONFIG_DIR finds the same file.
		const configDir = path.join(tmp, ".claude");
		fs.mkdirSync(configDir);
		if (settings.user !== undefined) fs.writeFileSync(path.join(configDir, "settings.json"), settings.user);
		if (settings.managed !== undefined) fs.writeFileSync(managedFile, settings.managed);
		if (settings.dropIns !== undefined || settings.dropInDirs !== undefined) {
			const dropInDir = path.join(tmp, "managed-settings.d");
			fs.mkdirSync(dropInDir);
			for (const [name, body] of Object.entries(settings.dropIns ?? {})) {
				fs.writeFileSync(path.join(dropInDir, name), body);
			}
			for (const name of settings.dropInDirs ?? []) fs.mkdirSync(path.join(dropInDir, name));
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PLUGIN_ROOT: repoRoot,
			HOME: tmp,
			CLAUDE_CONFIG_DIR: configDir,
		};
		delete env.CLAUDE_PLUGIN_OPTION_THEME;
		delete env.PERSONA_AGENTS_DEBUG;
		if (settings.noConfigDir) delete env.CLAUDE_CONFIG_DIR;
		if (theme !== undefined) env.CLAUDE_PLUGIN_OPTION_THEME = theme;
		// The test seam: a hook argument, which a settings env block cannot set.
		// The hook imports shared TypeScript, so it runs exactly as hooks.json does.
		const args = ["--experimental-strip-types", "--no-warnings", ...(settings.nodeArgs ?? []), contextScript, part, `--managed-settings=${managedFile}`];
		result = spawnSync(process.execPath, args, {
			input: JSON.stringify(input),
			env,
			encoding: "utf8",
		});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
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

/** A companion SessionStart input; compaction restarts the session with source "compact". */
function companionInput(source = "startup"): Record<string, unknown> {
	return { hook_event_name: "SessionStart", source, agent_type: "persona-agents:companion", session_id: "sess-1" };
}

describe("claude plugin: context hook", () => {
	test("the content holds the companion and the reviewer professions", () => {
		assert.deepEqual(professions, ["companion", "reviewer"]);
	});

	test("the profession part is the file, verbatim, under the cap", () => {
		const run = runContext("profession", companionInput());
		const file = fs.readFileSync(path.join(contentDir, "professions", "companion.md"), "utf8").trim();
		assert.equal(run.context, file);
		assert.equal(run.eventName, "SessionStart");
		assert.ok(file.length < HOOK_STRING_CAP, `companion.md is ${file.length} characters`);
	});

	test("every theme persona part fits under the cap", () => {
		for (const theme of themes) {
			const run = runContext("persona", companionInput(), theme);
			assert.ok(run.context, `${theme}: no persona context`);
			assert.match(run.context, new RegExp(`persona theme: ${theme}\\)`));
			assert.ok(run.context.length < HOOK_STRING_CAP, `${theme}: ${run.context.length} characters`);
		}
	});

	test("every part comes back after a compaction", () => {
		for (const part of ["profession", "persona", "session"]) {
			assert.ok(runContext(part, companionInput("compact")).context, part);
		}
	});

	test("the session part names the id on every session source", () => {
		for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
			const run = runContext("session", companionInput(source));
			assert.equal(run.context, "Session id: sess-1", source);
			assert.ok((run.context ?? "").length < HOOK_STRING_CAP);
		}
	});

	test("the session part is silent without a session id", () => {
		const run = runContext("session", { hook_event_name: "SessionStart", source: "startup", agent_type: "persona-agents:companion" });
		assert.equal(run.status, 0);
		assert.equal(run.context, null);
	});

	test("no option set means the goblin theme", () => {
		assert.match(runContext("persona", companionInput()).context ?? "", /persona theme: goblin\)/);
	});

	test("a plain session and a foreign agent get no output", () => {
		for (const input of [
			{ hook_event_name: "SessionStart", source: "startup" },
			{ hook_event_name: "SessionStart", source: "startup", agent_type: "Explore" },
			{ hook_event_name: "SessionStart", source: "startup", agent_type: "persona-agents:reviewer" },
		]) {
			for (const part of ["profession", "persona", "session"]) {
				const run = runContext(part, input);
				assert.equal(run.status, 0);
				assert.equal(run.context, null, `${part}: ${JSON.stringify(input)}`);
			}
		}
	});

	describe("theme lookup at hook run time", () => {
		const [themeA, themeB] = themes.filter((theme) => theme !== manifest.userConfig.theme.default);
		const themeOf = (run: HookRun) => /persona theme: ([^)]+)\)/.exec(run.context ?? "")?.[1];

		test("there are two non-default themes to tell apart", () => {
			assert.ok(themeA && themeB);
		});

		test("the user settings theme wins over the env var", () => {
			const run = runContext("persona", companionInput(), themeB, { user: themeSettings(themeA) });
			assert.equal(themeOf(run), themeA);
		});

		test("the env var applies when no settings file exists", () => {
			assert.equal(themeOf(runContext("persona", companionInput(), themeB)), themeB);
		});

		test("a settings file with bad JSON falls back to the env var", () => {
			const run = runContext("persona", companionInput(), themeB, { user: "{ not json" });
			assert.equal(run.status, 0);
			assert.equal(themeOf(run), themeB);
		});

		const wrongTypeBodies: Record<string, unknown> = {
			"theme is a number": { pluginConfigs: { "persona-agents@persona-agents": { options: { theme: 7 } } } },
			"options is null": { pluginConfigs: { "persona-agents@persona-agents": { options: null } } },
			"pluginConfigs is an array": { pluginConfigs: [] },
			"the file holds JSON null": null,
		};
		for (const [label, body] of Object.entries(wrongTypeBodies)) {
			test(`a wrong-type settings body falls back to the env var: ${label}`, () => {
				const run = runContext("persona", companionInput(), themeB, { user: JSON.stringify(body) });
				assert.equal(run.status, 0);
				assert.equal(themeOf(run), themeB);
			});
		}

		test("a bad managed file falls through to the user settings theme", () => {
			const run = runContext("persona", companionInput(), themeB, {
				managed: "{ not json",
				user: themeSettings(themeA),
			});
			assert.equal(themeOf(run), themeA);
		});

		test("without CLAUDE_CONFIG_DIR the hook reads .claude/settings.json under HOME", () => {
			const run = runContext("persona", companionInput(), themeB, {
				user: themeSettings(themeA),
				noConfigDir: true,
			});
			assert.equal(themeOf(run), themeA);
		});

		test("a failing passwd lookup still gives the theme from the settings under HOME", () => {
			// os.userInfo() throws for a uid with no passwd entry (for example a container user).
			const failingUserInfo = [
				'import os from "node:os";',
				'import { syncBuiltinESMExports } from "node:module";',
				'os.userInfo = () => { throw new Error("no passwd entry"); };',
				"syncBuiltinESMExports();",
			].join("\n");
			// Sanity check: the preload must make realHome() give "".
			const moduleUrl = pathToFileURL(path.join(repoRoot, "platforms", "claude", "scripts", "plugin-options.mjs")).href;
			const probe = spawnSync(
				process.execPath,
				[
					preload(failingUserInfo),
					"--input-type=module",
					"-e",
					`import { realHome } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(realHome()));`,
				],
				{ encoding: "utf8" },
			);
			assert.equal(probe.status, 0, probe.stderr);
			assert.equal(JSON.parse(probe.stdout), "");
			const run = runContext("persona", companionInput(), themeB, {
				user: themeSettings(themeA),
				noConfigDir: true,
				nodeArgs: [preload(failingUserInfo)],
			});
			assert.equal(run.status, 0);
			assert.equal(themeOf(run), themeA);
		});

		test("a settings file without the plugin key falls back to the default", () => {
			const run = runContext("persona", companionInput(), undefined, { user: "{}" });
			assert.equal(themeOf(run), manifest.userConfig.theme.default);
		});

		test("the managed settings theme wins over the user settings theme", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeB),
				user: themeSettings(themeA),
			});
			assert.equal(themeOf(run), themeB);
		});

		test("a managed-settings.d drop-in theme wins over the managed-settings.json theme", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeA),
				dropIns: { "10-theme.json": themeSettings(themeB) },
			});
			assert.equal(themeOf(run), themeB);
		});

		test("a drop-in theme wins over the user settings theme without managed-settings.json", () => {
			const run = runContext("persona", companionInput(), undefined, {
				user: themeSettings(themeA),
				dropIns: { "10-theme.json": themeSettings(themeB) },
			});
			assert.equal(themeOf(run), themeB);
		});

		test("of two drop-ins, the later one in alphabetical order wins", () => {
			const run = runContext("persona", companionInput(), undefined, {
				dropIns: { "20-b.json": themeSettings(themeB), "10-a.json": themeSettings(themeA) },
			});
			assert.equal(themeOf(run), themeB);
		});

		test("a later drop-in without the plugin key does not hide an earlier drop-in theme", () => {
			const run = runContext("persona", companionInput(), undefined, {
				dropIns: { "10-a.json": themeSettings(themeA), "20-b.json": "{}" },
			});
			assert.equal(themeOf(run), themeA);
		});

		test("a drop-in with bad JSON falls through to the next source", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeA),
				dropIns: { "10-bad.json": "{ not json" },
			});
			assert.equal(run.status, 0);
			assert.equal(themeOf(run), themeA);
		});

		test("a hidden drop-in and a non-json drop-in are ignored", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeA),
				dropIns: { ".x.json": themeSettings(themeB), "x.json.bak": themeSettings(themeB) },
			});
			assert.equal(themeOf(run), themeA);
		});

		test("a drop-in with an empty theme does not hide the managed-settings.json theme", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeA),
				dropIns: { "50-reset.json": themeSettings("") },
			});
			assert.equal(themeOf(run), themeA);
		});

		test("a later drop-in with an empty options object does not hide an earlier drop-in theme", () => {
			const run = runContext("persona", companionInput(), undefined, {
				dropIns: {
					"10-a.json": themeSettings(themeA),
					"20-b.json": JSON.stringify({ pluginConfigs: { "persona-agents@persona-agents": { options: {} } } }),
				},
			});
			assert.equal(themeOf(run), themeA);
		});

		test("a subdirectory named like a drop-in is skipped", () => {
			const run = runContext("persona", companionInput(), undefined, {
				managed: themeSettings(themeA),
				dropInDirs: ["x.json"],
			});
			assert.equal(run.status, 0);
			assert.equal(themeOf(run), themeA);
		});

		test("an unknown theme from the settings file still warns and keeps the persona-free rule", () => {
			const run = runContext("persona", companionInput(), themeA, { user: themeSettings("nosuch") });
			assert.equal(run.status, 0);
			assert.match(run.context ?? "", /persona-free-documents/);
			assert.match(run.stderr, /no nosuch persona for the companion/);
		});
	});

	test("an unknown theme warns and still sends the profession", () => {
		const persona = runContext("persona", companionInput(), "nosuch");
		assert.equal(persona.status, 0);
		assert.match(persona.context ?? "", /persona-free-documents/);
		assert.match(persona.stderr, /no nosuch persona for the companion/);
		assert.ok(runContext("profession", companionInput(), "nosuch").context);
	});
});
