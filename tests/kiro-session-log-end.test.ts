/**
 * The Kiro session-log safety net (platforms/kiro/scripts/session-log-end.ts).
 *
 * A fixture V3 session store and notes tree stand in for a real session. The
 * writer command is a fake executable, so no Kiro process and no model starts.
 *
 * Run: node --experimental-strip-types --test tests/kiro-session-log-end.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPayload,
	payloadFile,
	runHook,
	writeEntry,
	WRITER_AGENT,
} from "../platforms/kiro/scripts/session-log-end.ts";
import { entryPath } from "../platforms/shared/notes/session-log.ts";
import { projectDir } from "../platforms/shared/notes/notes-paths.ts";
import { readSession } from "../platforms/kiro/scripts/session-store.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const writerScript = path.join(repoRoot, "platforms", "kiro", "scripts", "session-log-end.ts");
const sessionId = "sess_99999999-8888-7777-6666-555555555555";

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-kiro-session-log-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

interface Fixture {
	kiro: string;
	home: string;
	cwd: string;
	notes: string;
	taskNotes: string;
}

/** A session that wrote task notes and said something after them. */
function fixture(root: string): Fixture {
	const kiro = path.join(root, "kiro");
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	const notes = projectDir(cwd, home);
	fs.mkdirSync(path.join(notes, "tasks"), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const taskNotes = path.join(notes, "tasks", "2026-11-20-task.md");
	fs.writeFileSync(taskNotes, "# Task\n\n## Plan\n\n- [x] one\n");
	const dir = path.join(kiro, "sessions", "hash", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const payloads = [
		{ type: "tool_call", toolName: "fs_write", args: { path: taskNotes, text: "# Task" } },
		{ type: "assistant", content: "I finished the task and committed it." },
	];
	fs.writeFileSync(path.join(dir, "messages.jsonl"), `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`);
	return { kiro, home, cwd, notes, taskNotes };
}

/** A fake Kiro executable that prints a valid entry and records its arguments. */
function fakeWriter(root: string): { command: string; argsFile: string } {
	const command = path.join(root, "fake-kiro.sh");
	const argsFile = path.join(root, "args.txt");
	fs.writeFileSync(
		command,
		`#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat <<'EOF'\n# 2026-11-20 10:00 — Test session\n\n- **Session:** ${sessionId}\n- **Task notes:** none\n\n## Done\n\n- one\n\n## Decisions\n\n- none\n\n## Open\n\n- none\n\n## Lessons\n\n- none\nEOF\n`,
	);
	fs.chmodSync(command, 0o755);
	return { command, argsFile };
}

const at = new Date(2026, 10, 20, 10, 0);

describe("kiro session-log net: the payload", () => {
	test("the payload names the entry and carries the writer prompt", () => {
		withTemp((root) => {
			const f = fixture(root);
			const session = readSession(f.kiro, sessionId);
			assert.ok(session);
			const payload = buildPayload(session.entries, f.notes, sessionId, at, f.kiro, "kiro-cli");
			assert.ok(payload);
			assert.equal(payload.entry, entryPath(f.notes, sessionId, at));
			assert.match(payload.prompt, /# 2026-11-20 10:00/);
			assert.match(payload.prompt, /TASK NOTES/);
			assert.match(payload.prompt, new RegExp(f.taskNotes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(payload.prompt, /I finished the task/);
		});
	});

	test("no material or an existing entry means no payload", () => {
		withTemp((root) => {
			const f = fixture(root);
			assert.equal(buildPayload([], f.notes, sessionId, at, f.kiro, "kiro-cli"), null);
			const entry = entryPath(f.notes, sessionId, at);
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.writeFileSync(entry, "# entry\n");
			const session = readSession(f.kiro, sessionId);
			assert.equal(buildPayload(session?.entries ?? [], f.notes, sessionId, at, f.kiro, "kiro-cli"), null);
		});
	});
});

describe("kiro session-log net: the hook", () => {
	test("the hook saves a payload and starts the detached writer", () => {
		withTemp((root) => {
			const f = fixture(root);
			const calls: { command: string; args: string[] }[] = [];
			const result = runHook(
				{ session_id: sessionId, cwd: f.cwd, reason: "quit" },
				{ home: f.home, kiroHome: f.kiro, kiroCli: "kiro-cli", now: at, spawn: (command, args) => calls.push({ command, args }) },
			);
			assert.equal(result.spawned, true);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].command, process.execPath);
			assert.ok(calls[0].args.includes("write"));
			assert.ok(calls[0].args.some((arg) => arg.startsWith("--kiro-cli=")));
			const file = payloadFile(path.join(f.kiro, "companion-agents", "state"), sessionId);
			assert.ok(fs.existsSync(file));
			const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { session: string; prompt: string };
			assert.equal(saved.session, sessionId);
			assert.ok(saved.prompt.length > 0);
		});
	});

	test("an existing entry or an empty session starts nothing", () => {
		withTemp((root) => {
			const f = fixture(root);
			const entry = entryPath(f.notes, sessionId, at);
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.writeFileSync(entry, "# entry\n");
			let spawned = false;
			const existing = runHook(
				{ session_id: sessionId, cwd: f.cwd },
				{ home: f.home, kiroHome: f.kiro, kiroCli: "kiro-cli", now: at, spawn: () => (spawned = true) },
			);
			assert.equal(existing.payload, null);
			assert.equal(spawned, false);
			const empty = runHook(
				{ session_id: "sess_missing", cwd: f.cwd },
				{ home: f.home, kiroHome: f.kiro, kiroCli: "kiro-cli", now: at, spawn: () => (spawned = true) },
			);
			assert.equal(empty.payload, null);
			assert.equal(spawned, false);
		});
	});
});

describe("kiro session-log net: the writer", () => {
	test("a valid entry is written, and the fake command gets the agent and the prompt", () => {
		withTemp((root) => {
			const f = fixture(root);
			const { command, argsFile } = fakeWriter(root);
			const session = readSession(f.kiro, sessionId);
			const payload = buildPayload(session?.entries ?? [], f.notes, sessionId, at, f.kiro, command);
			assert.ok(payload);
			const file = path.join(root, "payload.json");
			fs.writeFileSync(file, JSON.stringify(payload));
			assert.equal(writeEntry(file), true);
			assert.ok(fs.existsSync(payload.entry));
			assert.match(fs.readFileSync(payload.entry, "utf8"), /^# 2026-11-20 10:00/);
			const args = fs.readFileSync(argsFile, "utf8").split("\n");
			assert.ok(args.includes("chat"));
			assert.ok(args.includes(WRITER_AGENT));
			assert.ok(args.includes("--no-interactive"));
			assert.equal(fs.existsSync(file), false, "the payload is removed");
		});
	});

	test("a failed or malformed writer writes nothing", () => {
		withTemp((root) => {
			const f = fixture(root);
			const session = readSession(f.kiro, sessionId);
			const payload = buildPayload(session?.entries ?? [], f.notes, sessionId, at, f.kiro, "true");
			assert.ok(payload);
			const file = path.join(root, "payload.json");
			fs.writeFileSync(file, JSON.stringify(payload));
			assert.equal(writeEntry(file), false);
			assert.equal(fs.existsSync(payload.entry), false);

			const bad = path.join(root, "bad.sh");
			fs.writeFileSync(bad, "#!/bin/sh\necho not an entry\n");
			fs.chmodSync(bad, 0o755);
			const payload2 = { ...payload, kiroCli: bad };
			const file2 = path.join(root, "payload2.json");
			fs.writeFileSync(file2, JSON.stringify(payload2));
			assert.equal(writeEntry(file2), false);
			assert.equal(fs.existsSync(payload.entry), false);
		});
	});

	test("an existing entry is not overwritten and the command does not run", () => {
		withTemp((root) => {
			const f = fixture(root);
			const marker = path.join(root, "ran.txt");
			const command = path.join(root, "marker.sh");
			fs.writeFileSync(command, `#!/bin/sh\ntouch "${marker}"\necho "# new"\n`);
			fs.chmodSync(command, 0o755);
			const session = readSession(f.kiro, sessionId);
			const payload = buildPayload(session?.entries ?? [], f.notes, sessionId, at, f.kiro, command);
			assert.ok(payload);
			fs.mkdirSync(path.dirname(payload.entry), { recursive: true });
			fs.writeFileSync(payload.entry, "# original\n");
			const file = path.join(root, "payload.json");
			fs.writeFileSync(file, JSON.stringify(payload));
			assert.equal(writeEntry(file), false);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.readFileSync(payload.entry, "utf8"), "# original\n");
		});
	});

	test("the write CLI runs the fake command", () => {
		withTemp((root) => {
			const f = fixture(root);
			const { command } = fakeWriter(root);
			const session = readSession(f.kiro, sessionId);
			const payload = buildPayload(session?.entries ?? [], f.notes, sessionId, at, f.kiro, command);
			assert.ok(payload);
			const file = path.join(root, "payload.json");
			fs.writeFileSync(file, JSON.stringify(payload));
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", writerScript, "write", file], {
				encoding: "utf8",
			});
			assert.equal(run.status, 0, run.stderr);
			assert.ok(fs.existsSync(payload.entry));
		});
	});
});
