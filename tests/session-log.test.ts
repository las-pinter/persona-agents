/**
 * Checks the session-log scripts: the per-session entry path (session-log.mjs)
 * and the session-end safety net (session-log-end.mjs). A fake claude binary stands in for
 * the writer model; no test starts the real one.
 *
 * Run: node --experimental-strip-types --test tests/session-log.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dayOf, entryPath, findEntry, LEGACY_SESSION_LOGS, recentEntries, SESSION_LOGS } from "../platforms/claude/scripts/session-log.mjs";
import * as folders from "../platforms/shared/notes/folders.ts";
import { conversationTail, writerPrompt, writtenTaskNotes } from "../platforms/claude/scripts/session-log-end.mjs";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms", "claude", "scripts");
const sessionLogScript = path.join(scripts, "session-log.mjs");
const endScript = path.join(scripts, "session-log-end.mjs");

interface Env {
	tmp: string;
	home: string;
	cwd: string;
	notes: string;
	data: string;
}

function withEnv(fn: (env: Env) => void | Promise<void>): Promise<void> {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-session-log-")));
	const env = {
		tmp,
		home: path.join(tmp, "home"),
		cwd: path.join(tmp, "work"),
		notes: path.join(tmp, "home", "agent-notes", "project-notes", "common"),
		data: path.join(tmp, "data"),
	};
	fs.mkdirSync(env.cwd, { recursive: true });
	return Promise.resolve(fn(env)).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** A fake claude: prints a fixed entry, and records its arguments and stdin. */
function fakeClaude(env: Env, entry: string): string {
	const file = path.join(env.tmp, "fake-claude.sh");
	write(file, `#!/usr/bin/env bash\necho "$@" > "${env.tmp}/claude-args"\ncat > "${env.tmp}/claude-stdin"\nprintf '%s\\n' ${JSON.stringify(entry)}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return check();
}

describe("session log: entry path", () => {
	test("a new entry is <day>/<HHMM>-<session>.md; the same session gets the same file again", () =>
		withEnv(({ notes }) => {
			const now = new Date(2026, 0, 2, 9, 5);
			const first = entryPath(notes, "s-1", now);
			assert.equal(first, path.join(notes, "session-logs", "2026-01-02", "0905-s-1.md"));
			write(first, "# entry");
			assert.equal(entryPath(notes, "s-1", new Date(2026, 0, 2, 17, 30)), first);
		}));

	test("an entry from yesterday is reused after midnight; two sessions get two files", () =>
		withEnv(({ notes }) => {
			const late = entryPath(notes, "s-1", new Date(2026, 0, 2, 23, 50));
			write(late, "# entry");
			assert.equal(entryPath(notes, "s-1", new Date(2026, 0, 3, 0, 10)), late);
			assert.notEqual(entryPath(notes, "s-2", new Date(2026, 0, 2, 23, 50)), late);
		}));

	test("a session id with path characters stays one file name", () =>
		withEnv(({ notes }) => {
			const file = entryPath(notes, "../evil/x", new Date(2026, 0, 2, 9, 0));
			assert.equal(path.dirname(file), path.join(notes, "session-logs", "2026-01-02"));
		}));

	test("two parallel sessions write two complete entries on the same day", () =>
		withEnv(async (env) => {
			const one = (session: string) =>
				new Promise<string>((resolve, reject) => {
					const child = spawn(process.execPath, [sessionLogScript, "path", `--session=${session}`, `--cwd=${env.cwd}`, `--home=${env.home}`]);
					let out = "";
					child.stdout.on("data", (chunk) => (out += chunk));
					child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
				});
			const [a, b] = await Promise.all([one("s-a"), one("s-b")]);
			assert.notEqual(a, b);
			fs.writeFileSync(a, "# A\n");
			fs.writeFileSync(b, "# B\n");
			const entries = recentEntries(env.notes, 3);
			assert.equal(entries.length, 2);
			assert.deepEqual(entries.map((file) => fs.readFileSync(file, "utf8")).sort(), ["# A\n", "# B\n"]);
		}));

	test("read prints the recent entries, oldest first", () =>
		withEnv((env) => {
			write(path.join(env.notes, "session-logs", "2026-01-01", "0900-a.md"), "# first");
			write(path.join(env.notes, "session-logs", "2026-01-02", "0900-b.md"), "# second");
			const out = spawnSync(process.execPath, [sessionLogScript, "read", `--cwd=${env.cwd}`, `--home=${env.home}`], { encoding: "utf8" }).stdout;
			assert.ok(out.indexOf("# first") < out.indexOf("# second"), out);
		}));

	test("path without a session exits 2", () => {
		assert.equal(spawnSync(process.execPath, [sessionLogScript, "path"], { encoding: "utf8" }).status, 2);
	});
});

describe("session log: safety-net sources", () => {
	const use = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

	test("the task notes written by the session are found, once each", () => {
		const notes = "/n";
		const entries = [use("Write", { file_path: "/n/tasks/a.md" }), use("Edit", { file_path: "/n/tasks/a.md" }), use("Write", { file_path: "/src/x.ts" })];
		assert.deepEqual(writtenTaskNotes(entries, notes), ["/n/tasks/a.md"]);
	});

	test("the conversation tail starts after the last compaction and skips meta lines", () => {
		const entries = [
			{ type: "user", message: { content: "before" } },
			{ type: "system", subtype: "compact_boundary" },
			{ type: "user", message: { content: "after" } },
			{ type: "user", isMeta: true, message: { content: "meta" } },
			{ type: "assistant", message: { content: [{ type: "text", text: "reply" }] } },
		];
		assert.equal(conversationTail(entries), "user: after\n\nassistant: reply");
	});

	test("the writer prompt names the session and carries every source", () => {
		const prompt = writerPrompt({ session: "s-1", day: "2026-01-02", time: "09:00" }, { notes: [{ path: "/n/a.md", text: "PLAN" }], summaries: "SUM", tail: "TAIL" });
		for (const part of ["s-1", "2026-01-02 09:00", "/n/a.md", "PLAN", "SUM", "TAIL", "safety net"]) assert.ok(prompt.includes(part), part);
	});
});

describe("session log: session-end hook", () => {
	const hookInput = (env: Env, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: "s-9", cwd: env.cwd, agent_type: "persona-agents:companion", ...extra });
	const runHook = (env: Env, input: string, claude: string) =>
		spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", endScript, "hook", `--home=${env.home}`, `--claude=${claude}`], {
			input,
			env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data },
			encoding: "utf8",
		});

	test("a session with no entry gets one from the background writer", () =>
		withEnv(async (env) => {
			const transcript = path.join(env.tmp, "t.jsonl");
			write(transcript, JSON.stringify({ type: "user", message: { content: "please fix the parser" } }));
			const claude = fakeClaude(env, "# 2026-01-02 09:00 — parser fix\n\n## Done\n\n- fixed");
			const run = runHook(env, hookInput(env, { transcript_path: transcript }), claude);
			assert.equal(run.status, 0, run.stderr);
			const today = path.join(env.notes, "session-logs", dayOf(new Date()));
			assert.ok(await waitFor(() => fs.existsSync(today) && fs.readdirSync(today).some((name) => name.endsWith("-s-9.md"))), "no entry was written");
			const file = findEntry(env.notes, "s-9", [dayOf(new Date())]);
			assert.match(fs.readFileSync(file, "utf8"), /parser fix/);
			assert.match(fs.readFileSync(path.join(env.tmp, "claude-stdin"), "utf8"), /please fix the parser/);
			assert.match(fs.readFileSync(path.join(env.tmp, "claude-args"), "utf8"), /--tools\s+--no-session-persistence/);
		}));

	test("the detached writer loads the shared parser with type stripping off by default", () =>
		withEnv(async (env) => {
			const transcript = path.join(env.tmp, "t.jsonl");
			write(transcript, JSON.stringify({ type: "user", message: { content: "please fix the parser" } }));
			const claude = fakeClaude(env, "# 2026-01-02 09:00 — parser fix\n\n## Done\n\n- fixed");
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", endScript, "hook", `--home=${env.home}`, `--claude=${claude}`], {
				input: hookInput(env, { transcript_path: transcript }),
				env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data, NODE_OPTIONS: "--no-experimental-strip-types" },
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.ok(await waitFor(() => findEntry(env.notes, "s-9", [dayOf(new Date())]) !== ""), "the writer child did not run");
		}));

	test("a malformed payload is removed, not left in the state folder", () =>
		withEnv((env) => {
			const payload = path.join(env.data, "compact", "session-log-s-bad.json");
			write(payload, "{ truncated");
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", endScript, "write", payload, `--claude=${fakeClaude(env, "# x")}`], { encoding: "utf8" });
			assert.notEqual(run.status, 0, "the parse error still surfaces");
			assert.equal(fs.existsSync(payload), false);
		}));

	test("a session that already has an entry gets no second one", () =>
		withEnv(async (env) => {
			const existing = entryPath(env.notes, "s-9");
			write(existing, "# wrapped\n");
			const claude = fakeClaude(env, "# second");
			const run = runHook(env, hookInput(env, { transcript_path: path.join(env.tmp, "none.jsonl") }), claude);
			assert.equal(run.status, 0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(fs.readFileSync(existing, "utf8"), "# wrapped\n");
			assert.equal(fs.existsSync(path.join(env.tmp, "claude-args")), false);
		}));

	test("another agent or a writer session starts nothing", () =>
		withEnv(async (env) => {
			const claude = fakeClaude(env, "# x");
			runHook(env, hookInput(env, { agent_type: "Explore" }), claude);
			spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", endScript, "hook", `--home=${env.home}`, `--claude=${claude}`], {
				input: hookInput(env),
				env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data, PERSONA_AGENTS_SESSION_LOG_WRITER: "1" },
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(fs.existsSync(path.join(env.data, "compact")), false);
			assert.equal(fs.existsSync(path.join(env.tmp, "claude-args")), false);
		}));

	test("a writer reply that is not an entry writes nothing", () =>
		withEnv(async (env) => {
			const transcript = path.join(env.tmp, "t.jsonl");
			write(transcript, JSON.stringify({ type: "user", message: { content: "hello" } }));
			const claude = fakeClaude(env, "Sorry, I cannot help with that.");
			runHook(env, hookInput(env, { transcript_path: transcript }), claude);
			await waitFor(() => fs.existsSync(path.join(env.tmp, "claude-args")));
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(findEntry(env.notes, "s-9", [dayOf(new Date())]), "");
		}));
});

describe("session log: the plain-node copy of the folder names", () => {
	test("session-log.mjs names the same folders as the shared module", () => {
		assert.equal(SESSION_LOGS, folders.SESSION_LOGS);
		assert.equal(LEGACY_SESSION_LOGS, folders.LEGACY_SESSION_LOGS);
	});
});
