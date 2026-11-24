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
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-install-"));
	try {
		const dir = path.join(tmp, "config");
		const home = path.join(tmp, "home");
		fs.mkdirSync(home);
		fn(dir, home);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/** The Claude merge alone; the Kiro adapter has its own test file. */
function install(dir: string, home: string, ...args: string[]): Run {
	const result = spawnSync("bash", [script, "--claude", ...args], {
		env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: home },
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
