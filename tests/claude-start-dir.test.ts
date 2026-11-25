/**
 * Checks that the Claude Code scripts pick the project notes folder from the
 * folder the session started in, not from the folder a later `cd` left the
 * session in. The start folder is a git repository named "proj"; the later
 * folder is outside any repository, whose project would be "common".
 *
 * Run: node --experimental-strip-types --test tests/claude-start-dir.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findTranscript, startDir } from "../platforms/claude/scripts/transcript.ts";
import { dayOf, findEntry } from "../platforms/claude/scripts/session-log.mjs";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms", "claude", "scripts");
const STRIP = ["--experimental-strip-types", "--no-warnings"];
const COMPANION = "companion-agents:companion";
const SESSION = "s-1";

interface Env {
	tmp: string;
	home: string;
	/** The folder the session started in: a git repository named "proj". */
	start: string;
	/** A folder outside any repository that a later `cd` moved to. */
	moved: string;
	/** The notes folder of "proj". */
	notes: string;
	/** The Claude config folder; the transcript lives under its projects/. */
	config: string;
	transcript: string;
	data: string;
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** A transcript whose first `cwd` is the start folder and whose later `cwd` moved. */
function transcriptLines(env: Env, extra: Record<string, unknown>[] = []): string {
	const lines = [
		{ type: "mode", cwd: null },
		{ type: "user", cwd: env.start, message: { content: "hi" } },
		{ type: "assistant", cwd: env.moved, message: { content: [] } },
		...extra,
	];
	return lines.map((line) => JSON.stringify(line)).join("\n");
}

function withEnv(fn: (env: Env) => void | Promise<void>): Promise<void> {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-start-dir-")));
	const home = path.join(tmp, "home");
	const config = path.join(tmp, "config");
	const env: Env = {
		tmp,
		home,
		start: path.join(tmp, "proj"),
		moved: path.join(tmp, "elsewhere"),
		notes: path.join(home, "agent-notes", "project-notes", "proj"),
		config,
		transcript: path.join(config, "projects", "-proj", `${SESSION}.jsonl`),
		data: path.join(tmp, "data"),
	};
	fs.mkdirSync(env.moved, { recursive: true });
	fs.mkdirSync(env.start, { recursive: true });
	assert.equal(spawnSync("git", ["init", "-q"], { cwd: env.start }).status, 0);
	write(env.transcript, transcriptLines(env));
	return Promise.resolve(fn(env)).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

function hook(script: string, args: string[], input: Record<string, unknown>, env: Env) {
	return spawnSync(process.execPath, [...STRIP, path.join(scripts, script), ...args, `--home=${env.home}`], {
		input: JSON.stringify({ session_id: SESSION, agent_type: COMPANION, cwd: env.moved, transcript_path: env.transcript, ...input }),
		env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data },
		cwd: env.moved,
		encoding: "utf8",
	});
}

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return check();
}

describe("start folder: transcript helpers", () => {
	test("the first main-chain cwd wins over a later one and over a sidechain line", () =>
		withEnv((env) => {
			write(env.transcript, [{ type: "user", isSidechain: true, cwd: env.moved }, { type: "user", cwd: env.start }, { type: "user", cwd: env.moved }].map((line) => JSON.stringify(line)).join("\n"));
			assert.equal(startDir(env.transcript, "/fallback"), env.start);
		}));

	test("a missing transcript or one with no cwd gives the fallback", () =>
		withEnv((env) => {
			assert.equal(startDir(path.join(env.tmp, "none.jsonl"), "/fallback"), "/fallback");
			write(env.transcript, JSON.stringify({ type: "mode" }));
			assert.equal(startDir(env.transcript, "/fallback"), "/fallback");
		}));

	test("a session transcript is found by id; a path-shaped id finds nothing", () =>
		withEnv((env) => {
			assert.equal(findTranscript(env.config, SESSION), env.transcript);
			assert.equal(findTranscript(env.config, "s-missing"), "");
			assert.equal(findTranscript(env.config, `../-proj/${SESSION}`), "");
		}));
});

describe("start folder: scripts after a cd out of the project", () => {
	test("the wrap-up path command names the start folder's project", () =>
		withEnv((env) => {
			const run = spawnSync(process.execPath, [...STRIP, path.join(scripts, "session-log.mjs"), "path", `--session=${SESSION}`, `--home=${env.home}`], {
				cwd: env.moved,
				env: { ...process.env, CLAUDE_CONFIG_DIR: env.config },
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.ok(run.stdout.startsWith(path.join(env.notes, "session-logs")), run.stdout);
		}));

	test("an explicit --cwd still decides the project", () =>
		withEnv((env) => {
			const run = spawnSync(process.execPath, [...STRIP, path.join(scripts, "session-log.mjs"), "path", `--session=${SESSION}`, `--cwd=${env.moved}`, `--home=${env.home}`], {
				env: { ...process.env, CLAUDE_CONFIG_DIR: env.config },
				encoding: "utf8",
			});
			assert.ok(run.stdout.includes(path.join("project-notes", "common", "session-logs")), run.stdout);
		}));

	test("the startup hook lists the start folder's notes", () =>
		withEnv((env) => {
			write(path.join(env.notes, "summary.md"), "# s");
			const run = hook("startup.mjs", [], { hook_event_name: "SessionStart", source: "compact" }, env);
			assert.equal(run.status, 0, run.stderr);
			assert.ok(run.stdout.includes(path.join(env.notes, "summary.md")), run.stdout);
		}));

	test("the pre-compact hook finds the task notes in the start folder's notes", () =>
		withEnv((env) => {
			const notesFile = path.join(env.notes, "tasks", "2026-01-01-task.md");
			write(notesFile, "# Task\n\n- **Status:** open\n- **Study:** none\n\n## Pinned\n\n- none\n");
			const use = { type: "assistant", cwd: env.moved, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: notesFile } }] } };
			write(env.transcript, transcriptLines(env, [use]));
			const run = hook("compact.mjs", ["pre"], { hook_event_name: "PreCompact", trigger: "auto" }, env);
			assert.equal(run.status, 0, run.stderr);
			assert.ok(run.stdout.includes(notesFile), run.stdout);
		}));

	test("the session-end writer puts the entry in the start folder's notes", () =>
		withEnv(async (env) => {
			const claude = path.join(env.tmp, "fake-claude.sh");
			write(claude, `#!/usr/bin/env bash\ncat > /dev/null\nprintf '# 2026-01-02 09:00 — x\\n'\n`);
			fs.chmodSync(claude, 0o755);
			const run = hook("session-log-end.mjs", ["hook", `--claude=${claude}`], { hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, env);
			assert.equal(run.status, 0, run.stderr);
			assert.ok(await waitFor(() => findEntry(env.notes, SESSION, [dayOf(new Date())]) !== ""), "no entry in the start folder's notes");
		}));
});
