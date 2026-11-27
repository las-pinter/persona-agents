/**
 * Checks install.sh: the merge of the recommended settings into the user
 * settings file.
 *
 * Run: node --experimental-strip-types --test tests/install-sh.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "install.sh");
const snippet = JSON.parse(fs.readFileSync(path.join(repoRoot, "platforms", "claude", "settings", "recommended.json"), "utf8")) as {
	env: Record<string, string>;
	permissions: { allow: string[]; ask: string[]; additionalDirectories: string[] };
};

interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

function withConfig(fn: (dir: string, home: string) => void): void {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-install-"));
	try {
		const dir = path.join(tmp, "config");
		const home = path.join(tmp, "home");
		fs.mkdirSync(home);
		fn(dir, home);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * The environment of one hermetic run: the home, its config folder, and no
 * Dandelion override inherited from the machine running the tests.
 */
function hermeticEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...extra };
	if (!("DANDELION_PLUGINS_DIR" in extra)) delete env.DANDELION_PLUGINS_DIR;
	return env;
}

/** The Claude merge alone; the Kiro adapter has its own test file. */
function install(dir: string, home: string, ...args: string[]): Run {
	const result = spawnSync("bash", [script, "--claude", ...args], {
		env: hermeticEnv(home, { CLAUDE_CONFIG_DIR: dir }),
		encoding: "utf8",
	});
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const settingsOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));

describe("install.sh: settings merge", () => {
	test("--dry-run prints the merge and writes nothing", () => {
		withConfig((dir, home) => {
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "settings.json"), '{"model":"opus"}');
			const run = install(dir, home, "--dry-run");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /CLAUDE_AUTOCOMPACT_PCT_OVERRIDE/);
			assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), '{"model":"opus"}');
			assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
		});
	});

	test("a real run keeps every existing key and adds the snippet without duplicates", () => {
		withConfig((dir, home) => {
			fs.mkdirSync(dir);
			const before = {
				model: "opus",
				env: { KEEP: "1" },
				permissions: { allow: ["Bash(ls:*)", snippet.permissions.allow[0]], deny: ["Bash(rm -rf /:*)"] },
				hooks: { Stop: [] },
			};
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(before));
			const run = install(dir, home);
			assert.equal(run.status, 0, run.stderr);
			const after = settingsOf(dir);
			assert.equal(after.model, "opus");
			assert.deepEqual(after.hooks, { Stop: [] });
			assert.equal(after.env.KEEP, "1");
			assert.equal(after.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, snippet.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
			assert.deepEqual(after.permissions.deny, ["Bash(rm -rf /:*)"]);
			assert.deepEqual(after.permissions.allow, ["Bash(ls:*)", ...snippet.permissions.allow]);
			assert.deepEqual(after.permissions.ask, snippet.permissions.ask);
			assert.deepEqual(after.permissions.additionalDirectories, [path.join(home, "agent-notes")]);
			assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.bak-")), "a backup exists");
		});
	});

	test("an update drops the gh ask rules the snippet retired and keeps the user's own", () => {
		withConfig((dir, home) => {
			fs.mkdirSync(dir);
			const before = { permissions: { ask: ["Bash(gh pr:*)", "Bash(gh run:*)", "Bash(gh release:*)", "Bash(gh pr view:*)"] } };
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(before));
			const run = install(dir, home);
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(settingsOf(dir).permissions.ask, ["Bash(gh pr view:*)", ...snippet.permissions.ask]);
		});
	});

	test("a second run changes nothing", () => {
		withConfig((dir, home) => {
			assert.equal(install(dir, home).status, 0);
			const first = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
			const run = install(dir, home);
			assert.equal(run.status, 0);
			assert.match(run.stdout, /already up to date/);
			assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), first);
		});
	});

	test("a missing settings file is created", () => {
		withConfig((dir, home) => {
			assert.equal(install(dir, home).status, 0);
			assert.equal(settingsOf(dir).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, snippet.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
		});
	});

	test("a settings file that is not a JSON object stops the run and is left as it was", () => {
		withConfig((dir, home) => {
			fs.mkdirSync(dir);
			for (const body of ["{ not json", "[]"]) {
				fs.writeFileSync(path.join(dir, "settings.json"), body);
				const run = install(dir, home);
				assert.equal(run.status, 1, body);
				assert.match(run.stderr, /not a JSON object/);
				assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), body);
			}
		});
	});

	test("an unknown option exits 2", () => {
		withConfig((dir, home) => {
			assert.equal(install(dir, home, "--nope").status, 2);
		});
	});
});

describe("install.sh: the Dandelion visuals collection", () => {
	const ID = "companion-agents-visuals";
	const pluginsOf = (home: string) => path.join(home, ".config", "dandelion", "plugins");
	const manifestOf = (plugins: string) => JSON.parse(fs.readFileSync(path.join(plugins, `${ID}.json`), "utf8"));

	/** A machine where Dandelion is installed: its config folder exists. */
	const withDandelion = (home: string) => fs.mkdirSync(path.join(home, ".config", "dandelion"), { recursive: true });

	test("with no Dandelion on the machine, nothing is written", () => {
		withConfig((dir, home) => {
			const run = install(dir, home);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Dandelion not found/);
			assert.equal(fs.existsSync(path.join(home, ".config", "dandelion")), false);
		});
	});

	test("with Dandelion, the manifest declares the visuals tree and its root exists", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			const run = install(dir, home);
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(fs.readdirSync(pluginsOf(home)), [`${ID}.json`]);
			const manifest = manifestOf(pluginsOf(home));
			assert.equal(manifest.schema, 1);
			assert.equal(manifest.name, "Agent visuals");
			assert.equal(manifest.icon, "chart");
			assert.equal(manifest.id, ID, "the id equals the file stem");
			assert.match(manifest.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
			assert.equal(manifest.root, "~/agent-notes/project-notes");
			assert.deepEqual(manifest.include, ["{project}/visuals/{day}/**/*.{html,md}"]);
			assert.deepEqual(manifest.group, ["project", "day"]);
			for (const name of manifest.group) assert.ok(manifest.include[0].includes(`{${name}}`), `${name} is captured`);
			assert.ok(fs.statSync(path.join(home, "agent-notes", "project-notes")).isDirectory());
		});
	});

	test("a second run leaves the manifest as it is", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0);
			const first = fs.readFileSync(path.join(pluginsOf(home), `${ID}.json`), "utf8");
			const run = install(dir, home);
			assert.match(run.stdout, /visuals collection already up to date/);
			assert.equal(fs.readFileSync(path.join(pluginsOf(home), `${ID}.json`), "utf8"), first);
		});
	});

	test("a re-run recreates a missing root even when the manifest matches", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0);
			fs.rmSync(path.join(home, "agent-notes"), { recursive: true, force: true });
			const run = install(dir, home);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /visuals collection already up to date/);
			assert.ok(fs.statSync(path.join(home, "agent-notes", "project-notes")).isDirectory());
		});
	});

	test("DANDELION_PLUGINS_DIR picks the plugins folder", () => {
		withConfig((dir, home) => {
			const plugins = path.join(home, "custom-plugins");
			const run = spawnSync("bash", [script, "--claude"], {
				env: hermeticEnv(home, { CLAUDE_CONFIG_DIR: dir, DANDELION_PLUGINS_DIR: plugins }),
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.equal(manifestOf(plugins).id, ID);
			assert.equal(fs.existsSync(path.join(home, ".config", "dandelion")), false);
		});
	});

	test("a run with no adapter flag registers it too", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			const run = spawnSync("bash", [script, "--kiro-cli=/nonexistent/kiro-cli"], {
				env: hermeticEnv(home, { CLAUDE_CONFIG_DIR: dir }),
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.equal(manifestOf(pluginsOf(home)).id, ID);
		});
	});

	test("--dry-run writes no manifest", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			const run = install(dir, home, "--dry-run");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, new RegExp(`${ID}\\.json would become`));
			assert.equal(fs.existsSync(pluginsOf(home)), false);
		});
	});

	test("--dry-run reports the root a first run would create", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			const run = install(dir, home, "--dry-run");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Dry run: would create .*agent-notes\/project-notes/);
			assert.equal(fs.existsSync(path.join(home, "agent-notes")), false);
		});
	});

	test("--dry-run reports a missing root it would create", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0);
			fs.rmSync(path.join(home, "agent-notes"), { recursive: true, force: true });
			const run = install(dir, home, "--dry-run");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Dry run: would create .*agent-notes\/project-notes/);
			assert.equal(fs.existsSync(path.join(home, "agent-notes")), false);
		});
	});

	test("--no-dandelion with --dry-run keeps the manifest", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0);
			const run = install(dir, home, "--no-dandelion", "--dry-run");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /would remove the Dandelion visuals collection/);
			assert.equal(manifestOf(pluginsOf(home)).id, ID);
		});
	});

	test("--no-dandelion removes only this manifest", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0);
			fs.writeFileSync(path.join(pluginsOf(home), "other-tool.json"), "{}");
			const run = install(dir, home, "--no-dandelion");
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Removed the Dandelion visuals collection/);
			assert.deepEqual(fs.readdirSync(pluginsOf(home)), ["other-tool.json"]);
		});
	});

	test("--no-dandelion with no manifest is a quiet no-op", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			const run = install(dir, home, "--no-dandelion");
			assert.equal(run.status, 0, run.stderr);
			assert.doesNotMatch(run.stdout, /Removed the Dandelion/);
			assert.equal(fs.existsSync(pluginsOf(home)), false);
			assert.equal(fs.existsSync(path.join(home, "agent-notes")), false);
		});
	});

	test("--no-dandelion removes through DANDELION_PLUGINS_DIR", () => {
		withConfig((dir, home) => {
			const plugins = path.join(home, "custom-plugins");
			const env = hermeticEnv(home, { CLAUDE_CONFIG_DIR: dir, DANDELION_PLUGINS_DIR: plugins });
			const first = spawnSync("bash", [script, "--claude"], { env, encoding: "utf8" });
			assert.equal(first.status, 0, first.stderr);
			assert.equal(manifestOf(plugins).id, ID);
			const run = spawnSync("bash", [script, "--claude", "--no-dandelion"], { env, encoding: "utf8" });
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Removed the Dandelion visuals collection/);
			assert.equal(fs.existsSync(path.join(plugins, `${ID}.json`)), false);
		});
	});

	test("--no-dandelion removes even when an adapter step fails afterward", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			assert.equal(install(dir, home).status, 0, "the manifest is written");
			fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
			const run = install(dir, home, "--no-dandelion");
			assert.equal(run.status, 1, "the Claude merge fails");
			assert.match(run.stderr, /not a JSON object/);
			assert.equal(fs.existsSync(path.join(pluginsOf(home), `${ID}.json`)), false, "the manifest is removed first");
		});
	});

	test("a failing adapter suppresses the manifest write", () => {
		withConfig((dir, home) => {
			withDandelion(home);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
			const run = install(dir, home);
			assert.equal(run.status, 1, "the Claude merge fails");
			assert.equal(fs.existsSync(path.join(pluginsOf(home), `${ID}.json`)), false, "no manifest is written");
			assert.equal(fs.existsSync(path.join(home, "agent-notes")), false, "no notes root is created");
		});
	});
});
