/**
 * Checks the companion startup hook (startup.mjs): the read list it sends at
 * session start.
 *
 * Run: node --experimental-strip-types --test tests/claude-startup.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openSessionNotes, recentJournal, startupContext, unfinishedStudies } from "../platforms/claude/scripts/startup.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms", "claude", "scripts", "startup.mjs");

/** A temp home with a non-git working folder; the project is "common". */
function withNotes(fn: (paths: { home: string; cwd: string; dir: string }) => void): void {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-startup-")));
	try {
		const home = path.join(tmp, "home");
		const cwd = path.join(tmp, "work");
		fs.mkdirSync(cwd, { recursive: true });
		fn({ home, cwd, dir: path.join(home, "agent-notes", "project-notes", "common") });
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

describe("startup hook: read list", () => {
	test("a project with no notes folder still gets a read list that says so", () => {
		withNotes(({ home, cwd }) => {
			const text = startupContext(cwd, home);
			assert.match(text, /Project: common/);
			assert.match(text, /does not exist yet/);
		});
	});

	test("rules come in file-name order, then the summary", () => {
		withNotes(({ home, cwd, dir }) => {
			write(path.join(dir, "rules", "b-rule.md"), "# b");
			write(path.join(dir, "rules", "a-rule.md"), "# a");
			write(path.join(dir, "summary.md"), "# s");
			const text = startupContext(cwd, home);
			const a = text.indexOf("a-rule.md");
			const b = text.indexOf("b-rule.md");
			const s = text.indexOf("summary.md");
			assert.ok(a > 0 && a < b && b < s, text);
		});
	});

	test("the journal list holds the entries of the last three day folders only", () => {
		withNotes(({ dir }) => {
			for (const day of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
				write(path.join(dir, "journal", day, "0900-s1.md"), "x");
			}
			write(path.join(dir, "journal", "2026-01-04", "1000-s2.md"), "x");
			write(path.join(dir, "journal", "notes.txt"), "not a day");
			const entries = recentJournal(dir).map((file) => path.relative(dir, file));
			assert.deepEqual(entries, [
				path.join("journal", "2026-01-02", "0900-s1.md"),
				path.join("journal", "2026-01-03", "0900-s1.md"),
				path.join("journal", "2026-01-04", "0900-s1.md"),
				path.join("journal", "2026-01-04", "1000-s2.md"),
			]);
		});
	});

	test("only session notes with an open status are listed", () => {
		withNotes(({ dir }) => {
			write(path.join(dir, "sessions", "2026-01-01-open.md"), "# a\n\n- **Status:** open\n");
			write(path.join(dir, "sessions", "2026-01-01-done.md"), "# b\n\n- **Status:** done\n");
			assert.deepEqual(
				openSessionNotes(dir).map((file) => path.basename(file)),
				["2026-01-01-open.md"],
			);
		});
	});

	test("only draft, ready, and in-progress studies are listed", () => {
		withNotes(({ dir }) => {
			write(
				path.join(dir, "studies", "index.md"),
				[
					"| Study | Stage | Updated | Path |",
					"|-------|-------|---------|------|",
					"| Alpha | in-progress | 2026-01-02 | `studies/2026-01-01-alpha/` |",
					"| Beta | done | 2026-01-02 | `studies/2026-01-01-beta/` |",
					"| Gamma | draft | 2026-01-02 | `studies/2026-01-01-gamma/` |",
				].join("\n"),
			);
			const rows = unfinishedStudies(dir);
			assert.equal(rows.length, 2);
			assert.match(rows[0], /^Alpha \(in-progress\): .*alpha/);
			assert.match(rows[1], /^Gamma \(draft\)/);
		});
	});
});

describe("startup hook: process", () => {
	const run = (input: Record<string, unknown>, home = os.tmpdir()) =>
		spawnSync(process.execPath, [script, `--home=${home}`], { input: JSON.stringify(input), encoding: "utf8" });

	test("the companion gets SessionStart additional context under the cap", () => {
		withNotes(({ home, cwd, dir }) => {
			write(path.join(dir, "summary.md"), "# s");
			const result = run({ hook_event_name: "SessionStart", source: "startup", agent_type: "persona-agents:companion", cwd }, home);
			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
			assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
			assert.match(output.hookSpecificOutput.additionalContext, /^# Session start: read list/);
			assert.ok(output.hookSpecificOutput.additionalContext.includes(path.join(dir, "summary.md")));
			assert.ok(output.hookSpecificOutput.additionalContext.length < 10_000);
		});
	});

	test("another agent and a plain session get no output", () => {
		for (const agent of [undefined, "persona-agents:reviewer", "Explore"]) {
			const result = run({ hook_event_name: "SessionStart", source: "startup", agent_type: agent, cwd: os.tmpdir() });
			assert.equal(result.status, 0);
			assert.equal(result.stdout, "", String(agent));
		}
	});
});
