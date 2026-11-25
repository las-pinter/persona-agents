/**
 * The Kiro installer over a 5.x install made under the old name
 * (platforms/kiro/legacy.ts). Remove with that module.
 *
 * Every test installs into a temporary KIRO_HOME. No test starts kiro-cli.
 *
 * Run: node --experimental-strip-types --test tests/kiro-legacy.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAMES, SKILL_MARKER, install } from "../platforms/kiro/install.ts";
import { LEGACY_AGENTS, LEGACY_MARKER, LEGACY_NAME } from "../platforms/kiro/legacy.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED = new Date(2026, 10, 25, 12, 0, 0);

function withKiro(fn: (kiro: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-kiro-legacy-"));
	try {
		fn(path.join(root, "kiro"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** A Kiro home as a 5.x install left it: payload, theme, state, marked skills, agents, default agent. */
function oldInstall(kiro: string): void {
	const payload = path.join(kiro, LEGACY_NAME);
	write(path.join(payload, "config.json"), `${JSON.stringify({ theme: "cyberpunk" })}\n`);
	write(path.join(payload, "state", "reviews.json"), "{}\n");
	write(path.join(payload, "platforms", "kiro", "scripts", "gate.ts"), "// old\n");
	for (const name of ["review", "session-notes"]) {
		write(path.join(kiro, "skills", name, "SKILL.md"), "old\n");
		write(path.join(kiro, "skills", name, LEGACY_MARKER), "{}\n");
	}
	for (const name of LEGACY_AGENTS) write(path.join(kiro, "agents", `${name}.json`), "{}\n");
	write(path.join(kiro, "settings", "cli.json"), `${JSON.stringify({ "chat.defaultAgent": "pa-companion" })}\n`);
}

describe("kiro install: a 5.x install under the old name", () => {
	test("the install adopts it with no --force: payload, theme, and state carry over; old agents and markers go", () => {
		withKiro((kiro) => {
			oldInstall(kiro);
			const result = install({ root: repoRoot, kiroHome: kiro, now: FIXED });
			assert.ok(result.ok, result.error);
			const payload = path.join(kiro, "companion-agents");
			assert.equal(fs.existsSync(path.join(kiro, LEGACY_NAME)), false, "the old payload is gone");
			assert.equal(fs.readFileSync(path.join(payload, "state", "reviews.json"), "utf8"), "{}\n");
			assert.equal(JSON.parse(fs.readFileSync(path.join(payload, "config.json"), "utf8")).theme, "cyberpunk");
			for (const name of LEGACY_AGENTS) {
				assert.equal(fs.existsSync(path.join(kiro, "agents", `${name}.json`)), false, `${name} is removed`);
				assert.equal(fs.readFileSync(path.join(kiro, "agents", `${name}.json.bak-20261125T120000`), "utf8"), "{}\n", `${name} is backed up`);
			}
			for (const name of AGENT_NAMES) assert.ok(fs.existsSync(path.join(kiro, "agents", `${name}.json`)), `${name} exists`);
			assert.ok(fs.existsSync(path.join(kiro, "skills", "review", SKILL_MARKER)));
			assert.equal(fs.existsSync(path.join(kiro, "skills", "review", LEGACY_MARKER)), false);
			assert.equal(fs.existsSync(path.join(kiro, "skills", "session-notes")), false, "a retired skill with the old marker is removed");
		});
	});

	test("a default agent with the old name is warned about, never rewritten", () => {
		withKiro((kiro) => {
			oldInstall(kiro);
			const before = fs.readFileSync(path.join(kiro, "settings", "cli.json"), "utf8");
			const result = install({ root: repoRoot, kiroHome: kiro, now: FIXED });
			assert.ok(result.ok, result.error);
			assert.ok(result.plan?.warnings.some((warning) => warning.includes('"pa-companion"') && warning.includes('"ca-companion"')), result.plan?.warnings.join("\n"));
			assert.equal(fs.readFileSync(path.join(kiro, "settings", "cli.json"), "utf8"), before);
		});
	});

	test("a default naming an old agent whose file is already gone gets only the missing-agent warning", () => {
		withKiro((kiro) => {
			oldInstall(kiro);
			fs.rmSync(path.join(kiro, "agents", "pa-companion.json"));
			const result = install({ root: repoRoot, kiroHome: kiro, dryRun: true, now: FIXED });
			assert.ok(result.ok, result.error);
			const named = result.plan?.warnings.filter((warning) => warning.includes('"pa-companion"')) ?? [];
			assert.equal(named.length, 1, named.join("\n"));
			assert.match(named[0], /no agent file or built-in provides/);
		});
	});

	test("--dry-run names the migration and writes nothing", () => {
		withKiro((kiro) => {
			oldInstall(kiro);
			const result = install({ root: repoRoot, kiroHome: kiro, dryRun: true, now: FIXED });
			assert.ok(result.ok, result.error);
			assert.ok(result.actions.some((action) => action.startsWith("migrate: move ")), result.actions.join("\n"));
			assert.equal(result.actions.filter((action) => action.startsWith("migrate: back up and remove old agent")).length, LEGACY_AGENTS.length);
			assert.ok(fs.existsSync(path.join(kiro, LEGACY_NAME, "config.json")));
			assert.equal(fs.existsSync(path.join(kiro, "companion-agents")), false);
		});
	});

	test("an old payload beside a new one stays, with a warning", () => {
		withKiro((kiro) => {
			oldInstall(kiro);
			write(path.join(kiro, "companion-agents", "config.json"), `${JSON.stringify({ theme: "goblin" })}\n`);
			const result = install({ root: repoRoot, kiroHome: kiro, now: FIXED });
			assert.ok(result.ok, result.error);
			assert.ok(fs.existsSync(path.join(kiro, LEGACY_NAME, "state", "reviews.json")), "the old payload is kept");
			assert.equal(JSON.parse(fs.readFileSync(path.join(kiro, "companion-agents", "config.json"), "utf8")).theme, "goblin", "the new config wins");
			assert.ok(result.plan?.warnings.some((warning) => warning.includes("stays beside the new one")), result.plan?.warnings.join("\n"));
		});
	});
});
