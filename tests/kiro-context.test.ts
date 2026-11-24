/**
 * The Kiro context, paths, and session-log CLI (platforms/kiro/scripts/context.ts,
 * paths.ts, session-log.ts).
 *
 * The tests build a hermetic home and notes tree, and run the CLI entry points
 * as child processes where the argument seam matters. They never read the
 * owner's real notes folder or Kiro home.
 *
 * Run: node --experimental-strip-types --test tests/kiro-context.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { contextFor, platformNote, sessionContext, startupText } from "../platforms/kiro/scripts/context.ts";
import { sessionLogPath } from "../platforms/kiro/scripts/session-log.ts";
import { kiroHome, readTheme } from "../platforms/kiro/scripts/paths.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const script = (name: string): string => path.join(repoRoot, "platforms", "kiro", "scripts", name);

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-context-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("kiro paths: the global folder and the theme", () => {
	test("KIRO_HOME is used when absolute and outside the home folder", () => {
		const home = "/home/dev";
		assert.equal(kiroHome({ KIRO_HOME: "/tmp/kiro" }, home), "/tmp/kiro");
		assert.equal(kiroHome({}, home), "/home/dev/.kiro");
		assert.equal(kiroHome({ KIRO_HOME: "relative" }, home), "/home/dev/.kiro");
		assert.equal(kiroHome({ KIRO_HOME: "/" }, home), "/home/dev/.kiro");
		assert.equal(kiroHome({ KIRO_HOME: "/home" }, home), "/home/dev/.kiro");
		assert.equal(kiroHome({ KIRO_HOME: "/home/dev" }, home), "/home/dev/.kiro");
	});

	test("the theme comes from config.json, with goblin as the fallback", () => {
		withTemp((root) => {
			assert.equal(readTheme(root), "goblin");
			fs.mkdirSync(path.join(root, "persona-agents"), { recursive: true });
			fs.writeFileSync(path.join(root, "persona-agents", "config.json"), '{"theme":"pub"}');
			assert.equal(readTheme(root), "pub");
			fs.writeFileSync(path.join(root, "persona-agents", "config.json"), "not json");
			assert.equal(readTheme(root), "goblin");
			fs.writeFileSync(path.join(root, "persona-agents", "config.json"), '{"theme":""}');
			assert.equal(readTheme(root), "goblin");
		});
	});
});

describe("kiro context: the persona and the platform note", () => {
	test("the platform note names the Kiro shapes and the session id", () => {
		const note = platformNote("sess_1");
		assert.match(note, /^## Running in Kiro CLI/);
		assert.match(note, /load_resource/);
		assert.match(note, /skill::<name>/);
		assert.match(note, /sess_1/);
	});

	test("the session text carries the theme, the persona, and the note", () => {
		const text = sessionContext(contentDir, "goblin", "sess_1");
		assert.match(text, /^## Running in Kiro CLI \(persona theme: goblin\)/);
		assert.match(text, /Bossnik/);
		assert.match(text, /profession rules take precedence/);
		assert.match(text, /sess_1/);
	});

	test("an unknown theme drops the persona and reports the reason", () => {
		withTemp((root) => {
			fs.mkdirSync(path.join(root, "persona-agents"), { recursive: true });
			fs.writeFileSync(path.join(root, "persona-agents", "config.json"), '{"theme":"nosuch"}');
			const result = contextFor("session", { session_id: "sess_1" }, { contentDir, home: root, kiroHome: root });
			assert.ok(result);
			assert.match(result.text, /Running in Kiro CLI/);
			assert.doesNotMatch(result.text, /Bossnik/);
			assert.match(result.warning ?? "", /unknown persona theme/);
		});
	});

	test("a missing session id produces no output", () => {
		assert.equal(contextFor("session", {}, { contentDir, home: "/tmp", kiroHome: "/tmp" }), null);
	});
});

describe("kiro context: the startup read list", () => {
	test("the read list names the rules, the summary, the session logs, the open task notes, and the unfinished studies", () => {
		withTemp((root) => {
			const notes = path.join(root, "agent-notes", "project-notes", "common");
			fs.mkdirSync(path.join(notes, "rules"), { recursive: true });
			fs.writeFileSync(path.join(notes, "rules", "one.md"), "# One\n");
			fs.writeFileSync(path.join(notes, "summary.md"), "# Summary\n");
			for (const day of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]) {
				fs.mkdirSync(path.join(notes, "session-logs", day), { recursive: true });
				fs.writeFileSync(path.join(notes, "session-logs", day, "1200-sess_1.md"), `# ${day}\n`);
			}
			fs.mkdirSync(path.join(notes, "tasks"), { recursive: true });
			fs.writeFileSync(path.join(notes, "tasks", "open.md"), "- **Status:** open\n");
			fs.writeFileSync(path.join(notes, "tasks", "done.md"), "- **Status:** done\n");
			fs.mkdirSync(path.join(notes, "studies", "2026-11-20-one"), { recursive: true });
			fs.writeFileSync(
				path.join(notes, "studies", "index.md"),
				"| Study | Stage | Updated | Path |\n|-------|-------|---------|------|\n| One | draft | 2026-11-20 | `studies/2026-11-20-one/` |\n| Two | done | 2026-11-19 | `studies/2026-11-19-two/` |\n",
			);
			const text = startupText(path.join(root, "work"), root, "sess_1");
			assert.match(text, /Session id: `sess_1`/);
			assert.match(text, /rules\/one\.md/);
			assert.match(text, /summary\.md/);
			assert.match(text, /session-logs\/2026-11-18/);
			assert.match(text, /session-logs\/2026-11-19/);
			assert.match(text, /session-logs\/2026-11-20/);
			assert.doesNotMatch(text, /session-logs\/2026-11-17/);
			assert.match(text, /tasks\/open\.md/);
			assert.doesNotMatch(text, /tasks\/done\.md/);
			assert.match(text, /One \(draft\)/);
			assert.doesNotMatch(text, /Two \(done\)/);
		});
	});
});

describe("kiro session log: the entry path", () => {
	test("the path is under the project notes and reuses today or yesterday", () => {
		withTemp((root) => {
			const home = path.join(root, "home");
			const cwd = path.join(root, "work");
			fs.mkdirSync(home, { recursive: true });
			fs.mkdirSync(cwd, { recursive: true });
			const now = new Date(2026, 10, 20, 15, 30);
			const first = sessionLogPath(cwd, home, "sess/1", now);
			assert.match(first.replace(/\\/g, "/"), /agent-notes\/project-notes\/common\/session-logs\/2026-11-20\/1530-sess_1\.md$/);
			fs.mkdirSync(path.dirname(first), { recursive: true });
			fs.writeFileSync(first, "# entry\n");
			assert.equal(sessionLogPath(cwd, home, "sess/1", new Date(2026, 10, 20, 18, 0)), first);
			assert.equal(sessionLogPath(cwd, home, "sess/1", new Date(2026, 10, 21, 9, 0)), first);
		});
	});

	test("the CLI creates the day folder and prints the path", () => {
		withTemp((root) => {
			const home = path.join(root, "home");
			const cwd = path.join(root, "work");
			fs.mkdirSync(home, { recursive: true });
			fs.mkdirSync(cwd, { recursive: true });
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", script("session-log.ts"), "path", "--session=sess_1", `--cwd=${cwd}`, `--home=${home}`],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			const file = run.stdout.trim();
			// The day folder is created; the entry itself is written later by wrap-up.
			assert.ok(fs.existsSync(path.dirname(file)));
			assert.match(file, /sess_1\.md$/);
		});
	});
});

describe("kiro context: the CLI", () => {
	test("the startup hook reads its event from stdin", () => {
		withTemp((root) => {
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", script("context.ts"), "startup", `--home=${root}`, `--content=${contentDir}`],
				{ input: JSON.stringify({ session_id: "sess_1", cwd: root, hook_event_name: "SessionStart" }), encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Session id: `sess_1`/);
			assert.match(run.stdout, /Session start: read list/);
		});
	});
});
