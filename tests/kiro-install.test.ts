/**
 * The Kiro adapter installer (platforms/kiro/install.ts and install.sh).
 *
 * Every test installs into a temporary KIRO_HOME. No test starts kiro-cli and
 * no test reads the owner's notes.
 *
 * Run: node --experimental-strip-types --test tests/kiro-install.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_NAMES,
	MIN_VERSION,
	SKILL_MARKER,
	install,
	packageVersion,
	parseVersion,
	preflight,
	skillFolders,
	versionAtLeast,
} from "../platforms/kiro/install.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const installerScript = path.join(repoRoot, "platforms", "kiro", "install.ts");
const shellScript = path.join(repoRoot, "install.sh");
const FIXED = new Date(2026, 10, 20, 12, 0, 0);

interface Temp {
	root: string;
	home: string;
	kiro: string;
}

function withTemp(fn: (temp: Temp) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-install-"));
	try {
		fn({ root, home: path.join(root, "home"), kiro: path.join(root, "kiro") });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function fresh(temp: Temp): ReturnType<typeof install> {
	return install({ root: repoRoot, kiroHome: temp.kiro, now: FIXED });
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Every file under a folder, keyed by relative path. */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (relative: string): void => {
		for (const name of fs.readdirSync(path.join(dir, relative))) {
			const rel = relative ? `${relative}/${name}` : name;
			const full = path.join(dir, rel);
			if (fs.statSync(full).isDirectory()) walk(rel);
			else out[rel] = fs.readFileSync(full, "utf8");
		}
	};
	if (fs.existsSync(dir)) walk("");
	return out;
}

/** A fake kiro-cli that prints one version line. */
function fakeCli(temp: Temp, output = "kiro-cli 3.5.0"): string {
	const bin = path.join(temp.root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const file = path.join(bin, "kiro-cli");
	fs.writeFileSync(file, `#!/usr/bin/env bash\necho ${JSON.stringify(output)}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

function runInstaller(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
	const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", installerScript, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return { status: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

function runShell(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
	const run = spawnSync("bash", [shellScript, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
	return { status: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

describe("kiro install: a fresh install", () => {
	test("the payload, the config, the three agents, and every skill land in the kiro home", () => {
		withTemp((temp) => {
			const result = fresh(temp);
			assert.ok(result.ok, result.error);
			const payload = path.join(temp.kiro, "persona-agents");
			assert.ok(fs.existsSync(path.join(payload, "content", "professions", "companion.md")));
			assert.ok(fs.existsSync(path.join(payload, "platforms", "shared", "context", "context.ts")));
			assert.ok(fs.existsSync(path.join(payload, "platforms", "kiro", "scripts", "gate.ts")));
			assert.ok(!fs.existsSync(path.join(payload, "platforms", "claude")), "the payload holds no other adapter");
			assert.deepEqual(readJson(path.join(payload, "config.json")), { theme: "goblin" });
			for (const name of AGENT_NAMES) {
				assert.ok(fs.existsSync(path.join(temp.kiro, "agents", `${name}.json`)), `${name} exists`);
			}
			const installed = fs.readdirSync(path.join(temp.kiro, "skills")).sort();
			assert.deepEqual(installed, skillFolders(contentDir));
			for (const name of installed) {
				assert.deepEqual(readJson(path.join(temp.kiro, "skills", name, SKILL_MARKER)), {
					name: "persona-agents",
					version: packageVersion(repoRoot),
				});
			}
		});
	});

	test("pa-companion carries the persona prompt, the skills, and every inline hook", () => {
		withTemp((temp) => {
			assert.ok(fresh(temp).ok);
			const agent = readJson(path.join(temp.kiro, "agents", "pa-companion.json"));
			assert.match(String(agent.prompt), /^# Companion\n/);
			assert.deepEqual(agent.tools, ["read", "write", "shell", "web", "subagent/pa-reviewer"]);
			assert.equal((agent.resources as string[]).length, skillFolders(contentDir).length);
			assert.ok((agent.resources as string[]).every((resource) => resource.includes(`/skills/`) && resource.endsWith("/SKILL.md")));
			const triggers = (agent.hooks as Array<Record<string, unknown>>).map((hook) => hook.trigger);
			for (const trigger of ["SessionStart", "PermissionRequest", "Stop", "PreCompact", "PostCompact", "SessionEnd"]) {
				assert.ok(triggers.includes(trigger), `${trigger} hook`);
			}
			const end = (agent.hooks as Array<Record<string, unknown>>).find((hook) => hook.trigger === "SessionEnd");
			const command = String((end?.action as Record<string, unknown>).command);
			assert.match(command, /journal-end\.ts/);
			assert.match(command, /--kiro-home=/);
			assert.match(command, /--kiro-cli=/);
			const rules = (agent.permissions as { rules: Array<Record<string, unknown>> }).rules;
			assert.equal(rules[0].effect, "deny", "a deny rule comes first");
			const shell = rules.find((rule) => rule.capability === "shell");
			assert.ok((shell?.match as string[]).includes("node *"), "the companion may run the adapter scripts");
		});
	});

	test("pa-reviewer is read-only and gated; pa-writer has no tools", () => {
		withTemp((temp) => {
			assert.ok(fresh(temp).ok);
			const reviewer = readJson(path.join(temp.kiro, "agents", "pa-reviewer.json"));
			assert.match(String(reviewer.prompt), /^You are an independent code reviewer\./);
			assert.deepEqual(reviewer.tools, ["read", "web", "shell"]);
			const hooks = reviewer.hooks as Array<Record<string, unknown>>;
			assert.equal(hooks.length, 1);
			assert.equal(hooks[0].trigger, "PreToolUse");
			assert.match(String((hooks[0].action as Record<string, unknown>).command), /pretool.*reviewer/);
			const rules = (reviewer.permissions as { rules: Array<Record<string, unknown>> }).rules;
			assert.ok(rules.some((rule) => rule.capability === "fs_write" && rule.effect === "deny"));
			const shell = rules.find((rule) => rule.capability === "shell");
			assert.ok(!(shell?.match as string[]).includes("node *"), "the reviewer keeps the narrow test commands");
			assert.ok((shell?.match as string[]).includes("npm test"));
			assert.ok(!(shell?.match as string[]).includes("npm run *"), "the reviewer may not run an arbitrary project script");
			const writer = readJson(path.join(temp.kiro, "agents", "pa-writer.json"));
			assert.deepEqual(writer.tools, []);
		});
	});

	test("the skill tokens are substituted with the installed paths", () => {
		withTemp((temp) => {
			assert.ok(fresh(temp).ok);
			const skills = path.join(temp.kiro, "skills");
			const branch = fs.readFileSync(path.join(skills, "review", "SKILL.md"), "utf8");
			assert.ok(
				branch.includes(path.join(temp.kiro, "persona-agents", "platforms", "kiro", "scripts", "review.ts")),
				"the branch names the installed script",
			);
			assert.ok(branch.includes("references/kiro.md"), "the branch names the reference");
			for (const [file, text] of Object.entries(tree(skills))) {
				if (!file.endsWith(".md")) continue;
				assert.ok(!text.includes("{{PERSONA_AGENTS_KIRO_"), `${file} keeps no token`);
			}
			const wrap = fs.readFileSync(path.join(skills, "wrap-up", "references", "kiro.md"), "utf8");
			assert.ok(wrap.includes(path.join(temp.kiro, "persona-agents", "platforms", "kiro", "scripts", "journal.ts")));
		});
	});
});

describe("kiro install: the second run and the theme", () => {
	test("a second run changes no file and adds no backup", () => {
		withTemp((temp) => {
			assert.ok(fresh(temp).ok);
			const before = tree(temp.kiro);
			assert.ok(fresh(temp).ok);
			assert.deepEqual(tree(temp.kiro), before);
			assert.ok(!Object.keys(tree(temp.kiro)).some((file) => file.includes(".bak-")), "no backup on an unchanged run");
		});
	});

	test("--theme writes the config and the matching persona details", () => {
		withTemp((temp) => {
			assert.ok(install({ root: repoRoot, kiroHome: temp.kiro, theme: "cyberpunk", now: FIXED }).ok);
			assert.equal(readJson(path.join(temp.kiro, "persona-agents", "config.json")).theme, "cyberpunk");
			const agent = readJson(path.join(temp.kiro, "agents", "pa-companion.json"));
			assert.equal(typeof agent.welcomeMessage, "string");
			assert.ok(String(agent.description).length > 0);
		});
	});

	test("the next run keeps the theme unless another is named", () => {
		withTemp((temp) => {
			assert.ok(install({ root: repoRoot, kiroHome: temp.kiro, theme: "cyberpunk", now: FIXED }).ok);
			assert.ok(fresh(temp).ok);
			assert.equal(readJson(path.join(temp.kiro, "persona-agents", "config.json")).theme, "cyberpunk");
		});
	});

	test("an unknown theme is refused before any write", () => {
		withTemp((temp) => {
			const result = install({ root: repoRoot, kiroHome: temp.kiro, theme: "no-such-theme", now: FIXED });
			assert.equal(result.ok, false);
			assert.ok(!fs.existsSync(temp.kiro));
		});
	});

	test("the state folder survives an update", () => {
		withTemp((temp) => {
			assert.ok(fresh(temp).ok);
			const state = path.join(temp.kiro, "persona-agents", "state");
			fs.mkdirSync(state, { recursive: true });
			fs.writeFileSync(path.join(state, "keep.txt"), "keep\n");
			assert.ok(fresh(temp).ok);
			assert.equal(fs.readFileSync(path.join(state, "keep.txt"), "utf8"), "keep\n");
		});
	});
});

describe("kiro install: dry run and conflicts", () => {
	test("--dry-run writes nothing and names the plan", () => {
		withTemp((temp) => {
			const result = install({ root: repoRoot, kiroHome: temp.kiro, dryRun: true, now: FIXED });
			assert.ok(result.ok, result.error);
			assert.ok(result.actions.some((action) => action.startsWith("payload: ")));
			assert.ok(result.actions.some((action) => action === `skills: ${skillFolders(contentDir).length}`));
			assert.ok(!fs.existsSync(temp.kiro));
		});
	});

	test("an unowned skill folder stops the install before any write", () => {
		withTemp((temp) => {
			const foreign = path.join(temp.kiro, "skills", "review");
			fs.mkdirSync(foreign, { recursive: true });
			fs.writeFileSync(path.join(foreign, "SKILL.md"), "# someone else's review\n");
			const result = fresh(temp);
			assert.equal(result.ok, false);
			assert.match(result.error, /not owned by persona-agents/);
			assert.match(result.error, /--force/);
			assert.ok(!fs.existsSync(path.join(temp.kiro, "persona-agents")));
			assert.ok(!fs.existsSync(path.join(temp.kiro, "agents")));
			assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "# someone else's review\n");
		});
	});

	test("--force backs up an unowned folder and replaces it", () => {
		withTemp((temp) => {
			const foreign = path.join(temp.kiro, "skills", "review");
			fs.mkdirSync(foreign, { recursive: true });
			fs.writeFileSync(path.join(foreign, "SKILL.md"), "# someone else's review\n");
			const checked = preflight({ root: repoRoot, kiroHome: temp.kiro, force: true });
			assert.ok(checked.plan);
			const result = install({ root: repoRoot, kiroHome: temp.kiro, force: true, now: FIXED });
			assert.ok(result.ok, result.error);
			assert.ok(fs.existsSync(path.join(temp.kiro, "skills", "review", SKILL_MARKER)));
			const backups = fs.readdirSync(path.join(temp.kiro, "skills")).filter((name) => name.startsWith("review.bak-"));
			assert.equal(backups.length, 1);
			assert.equal(fs.readFileSync(path.join(temp.kiro, "skills", backups[0], "SKILL.md"), "utf8"), "# someone else's review\n");
		});
	});
});

describe("kiro install: the owner's settings", () => {
	test("chat.defaultAgent is warned about, never rewritten", () => {
		withTemp((temp) => {
			const settings = path.join(temp.kiro, "settings");
			fs.mkdirSync(settings, { recursive: true });
			const body = `${JSON.stringify({ "chat.defaultAgent": "goblin-orchestrator", theme: "dark" })}\n`;
			fs.writeFileSync(path.join(settings, "cli.json"), body);
			const result = fresh(temp);
			assert.ok(result.ok, result.error);
			assert.equal(fs.readFileSync(path.join(settings, "cli.json"), "utf8"), body);
			assert.equal(result.plan?.warnings.length, 1);
			assert.match(result.plan?.warnings[0] ?? "", /goblin-orchestrator/);
		});
	});

	test("a default that names an installed agent needs no warning", () => {
		withTemp((temp) => {
			const settings = path.join(temp.kiro, "settings");
			fs.mkdirSync(settings, { recursive: true });
			fs.writeFileSync(path.join(settings, "cli.json"), `${JSON.stringify({ "chat.defaultAgent": "pa-companion" })}\n`);
			const checked = preflight({ root: repoRoot, kiroHome: temp.kiro });
			assert.equal(checked.plan?.warnings.length, 0);
		});
	});
});

describe("kiro install: the version check", () => {
	test("a version is read from the kiro-cli line and compared with the minimum", () => {
		assert.deepEqual(parseVersion("kiro-cli 3.5.0 (build abc)"), [3, 5, 0]);
		assert.deepEqual(parseVersion("3.4.0"), [3, 4, 0]);
		assert.equal(parseVersion("no digits"), null);
		assert.equal(versionAtLeast([3, 4, 0]), true);
		assert.equal(versionAtLeast([4, 0, 0]), true);
		assert.equal(versionAtLeast([3, 3, 9]), false);
		assert.deepEqual(MIN_VERSION, [3, 4, 0]);
	});

	test("the CLI installs with a current kiro-cli and writes only on the real run", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const dry = runInstaller([`--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`, "--dry-run"]);
			assert.equal(dry.status, 0, dry.stderr);
			assert.match(dry.stdout, /Dry run: payload:/);
			assert.ok(!fs.existsSync(temp.kiro));
			const real = runInstaller([`--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`]);
			assert.equal(real.status, 0, real.stderr);
			assert.match(real.stdout, /kiro-cli 3\.5\.0/);
			assert.match(real.stdout, /--agent pa-companion/);
			assert.ok(fs.existsSync(path.join(temp.kiro, "agents", "pa-companion.json")));
		});
	});

	test("a kiro-cli below the minimum is refused before any write", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp, "kiro-cli 3.3.9");
			const run = runInstaller([`--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`]);
			assert.equal(run.status, 1);
			assert.match(run.stderr, /below the required 3\.4\.0/);
			assert.ok(!fs.existsSync(temp.kiro));
		});
	});

	test("a missing kiro-cli is refused", () => {
		withTemp((temp) => {
			const run = runInstaller([`--kiro-home=${temp.kiro}`, `--kiro-cli=${path.join(temp.root, "missing")}`]);
			assert.equal(run.status, 1);
			assert.match(run.stderr, /cannot run/);
			assert.ok(!fs.existsSync(temp.kiro));
		});
	});

	test("--dry-run previews without a working kiro-cli", () => {
		withTemp((temp) => {
			const run = runInstaller([`--kiro-home=${temp.kiro}`, `--kiro-cli=${path.join(temp.root, "missing")}`, "--dry-run"]);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Dry run: payload:/);
			assert.match(run.stderr, /a real install would refuse/);
			assert.ok(!fs.existsSync(temp.kiro));
		});
	});

	test("a root or home kiro home is refused", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			for (const home of ["/", temp.home]) {
				const run = runInstaller([`--kiro-home=${home}`, `--kiro-cli=${cli}`], { HOME: temp.home });
				assert.equal(run.status, 1, home);
				assert.match(run.stderr, /must be an absolute path/);
			}
			assert.ok(!fs.existsSync(path.join(temp.home, "agents")), "nothing was written into the home");
		});
	});
});

describe("install.sh: the adapter flags", () => {
	test("--kiro --dry-run writes nothing", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const run = runShell(["--kiro", "--dry-run", `--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`], { HOME: temp.home });
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Dry run: payload:/);
			assert.ok(!fs.existsSync(temp.kiro));
			assert.ok(!fs.existsSync(path.join(temp.home, ".kiro")));
		});
	});

	test("--kiro installs the adapter alone", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const run = runShell(["--kiro", `--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`], { HOME: temp.home });
			assert.equal(run.status, 0, run.stderr);
			assert.ok(fs.existsSync(path.join(temp.kiro, "agents", "pa-reviewer.json")));
			assert.ok(!fs.existsSync(path.join(temp.home, ".claude", "settings.json")));
		});
	});

	test("the default run installs both adapters", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const config = path.join(temp.root, "config");
			const run = runShell([`--kiro-cli=${cli}`], { HOME: temp.home, CLAUDE_CONFIG_DIR: config });
			assert.equal(run.status, 0, run.stderr);
			assert.ok(fs.existsSync(path.join(config, "settings.json")));
			assert.ok(fs.existsSync(path.join(temp.home, ".kiro", "agents", "pa-companion.json")));
			assert.equal(fs.readdirSync(path.join(temp.home, ".kiro", "skills")).length, skillFolders(contentDir).length);
		});
	});

	test("--claude leaves the kiro home alone", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const config = path.join(temp.root, "config");
			const run = runShell(["--claude", `--kiro-cli=${cli}`], { HOME: temp.home, CLAUDE_CONFIG_DIR: config });
			assert.equal(run.status, 0, run.stderr);
			assert.ok(fs.existsSync(path.join(config, "settings.json")));
			assert.ok(!fs.existsSync(path.join(temp.home, ".kiro")));
		});
	});

	test("an absent kiro-cli is skipped with a message in the default run", () => {
		withTemp((temp) => {
			const config = path.join(temp.root, "config");
			const run = runShell([`--kiro-cli=${path.join(temp.root, "missing")}`], { HOME: temp.home, CLAUDE_CONFIG_DIR: config });
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /skipping the Kiro adapter/);
			assert.ok(!fs.existsSync(path.join(temp.home, ".kiro")));
		});
	});

	test("an old kiro-cli is skipped with a message in the default run", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp, "kiro-cli 3.3.0");
			const config = path.join(temp.root, "config");
			const run = runShell([`--kiro-cli=${cli}`], { HOME: temp.home, CLAUDE_CONFIG_DIR: config });
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /below 3\.4\.0; skipping/);
			assert.ok(fs.existsSync(path.join(config, "settings.json")));
			assert.ok(!fs.existsSync(path.join(temp.home, ".kiro")));
		});
	});

	test("--kiro with an absent kiro-cli fails", () => {
		withTemp((temp) => {
			const run = runShell(["--kiro", `--kiro-cli=${path.join(temp.root, "missing")}`], { HOME: temp.home });
			assert.equal(run.status, 1);
			assert.match(run.stderr, /cannot run/);
		});
	});

	test("--kiro with an old kiro-cli fails", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp, "kiro-cli 3.3.0");
			const run = runShell(["--kiro", `--kiro-cli=${cli}`], { HOME: temp.home });
			assert.equal(run.status, 1);
			assert.match(run.stderr, /below the required 3\.4\.0/);
		});
	});

	test("--theme reaches the Kiro install", () => {
		withTemp((temp) => {
			const cli = fakeCli(temp);
			const run = runShell(["--kiro", "--theme", "cyberpunk", `--kiro-home=${temp.kiro}`, `--kiro-cli=${cli}`], { HOME: temp.home });
			assert.equal(run.status, 0, run.stderr);
			assert.equal(readJson(path.join(temp.kiro, "persona-agents", "config.json")).theme, "cyberpunk");
		});
	});
});
