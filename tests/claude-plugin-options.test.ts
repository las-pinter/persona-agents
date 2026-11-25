/**
 * Checks the explicit-path readers in plugin-options.mjs: the settings option,
 * the managed option, and the user config dir.
 *
 * Run: node --experimental-strip-types --test tests/claude-plugin-options.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inProject, managedOption, realHome, settingsOption, userConfigDir } from "../platforms/claude/scripts/plugin-options.mjs";

/** A settings file body that sets one sample option, the way /config writes a plugin option. */
function optionSettings(value: string): string {
	return JSON.stringify({ pluginConfigs: { "companion-agents@companion-agents": { options: { sample_option: value } } } });
}

describe("plugin-options: explicit-path readers", () => {
	const withTmp = (fn: (tmp: string) => void) => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-options-"));
		try {
			fn(tmp);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	};

	test("settingsOption reads one key and gives '' for a missing, bad, or non-string value", () => {
		withTmp((tmp) => {
			const file = path.join(tmp, "s.json");
			assert.equal(settingsOption(file, "sample_option"), "");
			fs.writeFileSync(file, optionSettings("haiku"));
			assert.equal(settingsOption(file, "sample_option"), "haiku");
			assert.equal(settingsOption(file, "theme"), "");
			fs.writeFileSync(file, "{ not json");
			assert.equal(settingsOption(file, "sample_option"), "");
			fs.writeFileSync(file, JSON.stringify({ pluginConfigs: { "companion-agents@companion-agents": { options: { x: 1 } } } }));
			assert.equal(settingsOption(file, "x"), "");
		});
	});

	test("managedOption: the last drop-in that sets the value wins, else the managed file", () => {
		withTmp((tmp) => {
			const managed = path.join(tmp, "managed-settings.json");
			const dir = path.join(tmp, "managed-settings.d");
			assert.equal(managedOption(managed, "sample_option"), "");
			fs.writeFileSync(managed, optionSettings("opus"));
			assert.equal(managedOption(managed, "sample_option"), "opus");
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "10-a.json"), optionSettings("haiku"));
			fs.writeFileSync(path.join(dir, "20-b.json"), optionSettings(""));
			fs.writeFileSync(path.join(dir, ".hidden.json"), optionSettings("sonnet"));
			assert.equal(managedOption(managed, "sample_option"), "haiku");
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

	test("a CLAUDE_CONFIG_DIR inside the project with another letter case is ignored", () => {
		withTmp((tmp) => {
			const project = path.join(tmp, "Repo");
			const planted = path.join(tmp, "repo", ".cfg");
			fs.mkdirSync(path.join(project, ".cfg"), { recursive: true });
			// A case-folding disk supplies this fold on macOS; this stub supplies it here.
			const native = fs.realpathSync.native;
			try {
				fs.realpathSync.native = ((p) => native(String(p).replace(`${path.sep}repo${path.sep}`, `${path.sep}Repo${path.sep}`))) as typeof native;
				assert.ok(inProject(planted, {}, project, ""));
				assert.notEqual(userConfigDir({ CLAUDE_CONFIG_DIR: planted }, project, ""), planted);
			} finally {
				fs.realpathSync.native = native;
			}
		});
	});
});
