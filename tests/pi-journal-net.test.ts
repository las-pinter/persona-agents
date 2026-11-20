/**
 * The journal safety net (platforms/shared/notes/journal-net.ts and
 * journal-writer.ts).
 *
 * The writer runs end to end here with a stub `pi` command, so the suite never
 * starts a real model: it proves the payload, the caps, the entry path, and the
 * "never overwrite, never leave a payload behind" rules.
 *
 * Run: node --experimental-strip-types --test tests/pi-journal-net.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CAP_NOTES,
	compactionSummaries,
	conversationTail,
	hasMaterial,
	sources,
	writerPrompt,
	writtenSessionNotes,
	type EntryLike,
	type Payload,
} from "../platforms/shared/notes/journal-net.ts";
import { entryPath } from "../platforms/shared/notes/journal.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const writer = path.join(repoRoot, "platforms", "pi", "scripts", "journal-writer.ts");

function assistant(...calls: { name: string; args: Record<string, unknown> }[]): EntryLike {
	return {
		type: "message",
		message: { role: "assistant", content: calls.map((call, index) => ({ type: "toolCall", id: `c${index}`, name: call.name, arguments: call.args })) },
	};
}

const text = (role: string, value: string): EntryLike => ({ type: "message", message: { role, content: value } });
const compaction = (summary: string): EntryLike => ({ type: "compaction", summary });

function notesTree(): { root: string; notesDir: string; sessionNotes: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-net-"));
	const notesDir = path.join(root, "agent-notes", "project-notes", "demo");
	const sessionNotes = path.join(notesDir, "sessions", "2026-01-01-gate.md");
	fs.mkdirSync(path.dirname(sessionNotes), { recursive: true });
	fs.writeFileSync(sessionNotes, "# Gate task\n\n- **Status:** open\n");
	return { root, notesDir, sessionNotes, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("pi journal net: the material", () => {
	test("the session notes the session wrote are found once, in order", () => {
		const box = notesTree();
		try {
			const second = path.join(box.notesDir, "sessions", "2026-01-02-later.md");
			fs.writeFileSync(second, "# Later\n");
			const entries = [assistant({ name: "write", args: { path: box.sessionNotes } }), assistant({ name: "edit", args: { path: second } }), assistant({ name: "edit", args: { path: box.sessionNotes } })];
			assert.deepEqual(writtenSessionNotes(entries, box.notesDir), [box.sessionNotes, second]);
		} finally {
			box.cleanup();
		}
	});

	test("only the text after the last compaction is the conversation tail", () => {
		const entries = [text("user", "before"), compaction("summary"), text("user", "after the cut"), text("assistant", "done"), text("user", "<system>ignored")];
		assert.equal(conversationTail(entries), "user: after the cut\n\nassistant: done");
	});

	test("summaries come from the compaction entries", () => {
		assert.deepEqual(compactionSummaries([compaction("one"), text("user", "x"), compaction("two")]), ["one", "two"]);
	});

	test("the sources are capped, and a session with nothing has no material", () => {
		const box = notesTree();
		try {
			fs.writeFileSync(box.sessionNotes, "x".repeat(CAP_NOTES + 500));
			const material = sources([assistant({ name: "write", args: { path: box.sessionNotes } })], box.notesDir);
			assert.equal(material.notes.length, 1);
			assert.ok(material.notes[0].text.length < CAP_NOTES + 100);
			assert.match(material.notes[0].text, /\[\.\.\.cut\.\.\.\]/);
			assert.equal(hasMaterial(sources([], box.notesDir)), false);
		} finally {
			box.cleanup();
		}
	});

	test("the prompt carries the date, the session, the attribution, and the sections", () => {
		const box = notesTree();
		try {
			const payload: Payload = { session: "s1", notesDir: box.notesDir, at: new Date(2026, 0, 2, 15, 4).toISOString(), sources: sources([], box.notesDir) };
			const prompt = writerPrompt(payload, { notes: [{ path: box.sessionNotes, text: "# Gate\n" }], summaries: "", tail: "" });
			assert.match(prompt, /^# 2026-01-02 15:04 — <short title of the session>/m);
			assert.match(prompt, /- \*\*Session:\*\* s1/);
			assert.match(prompt, /session-end safety net \(no wrap-up\)/);
			assert.match(prompt, /## Done\n## Decisions\n## Open/);
			assert.match(prompt, /Use '- none' for an empty section/);
			assert.ok(prompt.includes(box.sessionNotes));
		} finally {
			box.cleanup();
		}
	});
});

describe("pi journal net: the detached writer", () => {
	/** A stub `pi` that prints an entry and records its arguments. */
	function stubPi(root: string, body: string): { path: string; args: string } {
		const file = path.join(root, "stub-pi.sh");
		const argsFile = path.join(root, "args.txt");
		fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\ncat <<'EOF'\n${body}\nEOF\n`, { mode: 0o755 });
		return { path: file, args: argsFile };
	}

	function run(payloadFile: string, piBin: string): void {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", writer, payloadFile, `--pi=${piBin}`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}

	test("an entry is written at the session's path, and the payload is removed", () => {
		const box = notesTree();
		try {
			const at = new Date(2026, 0, 2, 9, 30);
			const stub = stubPi(box.root, "# 2026-01-02 09:30 — stub session\n\n## Done\n\n- one thing");
			const payload: Payload = {
				session: "sess-1",
				notesDir: box.notesDir,
				at: at.toISOString(),
				sources: { notes: [{ path: box.sessionNotes, text: "# Gate\n" }], summaries: "", tail: "" },
			};
			const payloadFile = path.join(box.root, "payload.json");
			fs.writeFileSync(payloadFile, JSON.stringify(payload));
			run(payloadFile, stub.path);
			const expected = entryPath(box.notesDir, "sess-1", at);
			assert.equal(fs.existsSync(expected), true);
			assert.match(fs.readFileSync(expected, "utf8"), /stub session/);
			assert.equal(fs.existsSync(payloadFile), false, "the payload is cleaned up");
			// The child request is headless and tool-less.
			assert.match(fs.readFileSync(stub.args, "utf8"), /-p\n-nt\n--no-session/);
		} finally {
			box.cleanup();
		}
	});

	test("an existing entry is never overwritten", () => {
		const box = notesTree();
		try {
			const at = new Date(2026, 0, 2, 10, 0);
			const existing = entryPath(box.notesDir, "sess-2", at);
			fs.mkdirSync(path.dirname(existing), { recursive: true });
			fs.writeFileSync(existing, "# the real wrap-up\n");
			const stub = stubPi(box.root, "# stub\n");
			const payloadFile = path.join(box.root, "payload.json");
			fs.writeFileSync(payloadFile, JSON.stringify({ session: "sess-2", notesDir: box.notesDir, at: at.toISOString(), sources: { notes: [{ path: box.sessionNotes, text: "x" }], summaries: "", tail: "" } }));
			run(payloadFile, stub.path);
			assert.equal(fs.readFileSync(existing, "utf8"), "# the real wrap-up\n");
			assert.equal(fs.existsSync(path.join(box.root, "args.txt")), false, "the model is not called at all");
		} finally {
			box.cleanup();
		}
	});

	test("no material means no call, and a malformed payload is silent", () => {
		const box = notesTree();
		try {
			const stub = stubPi(box.root, "# stub\n");
			const empty = path.join(box.root, "empty.json");
			fs.writeFileSync(empty, JSON.stringify({ session: "s", notesDir: box.notesDir, at: new Date().toISOString(), sources: { notes: [], summaries: "", tail: "" } }));
			run(empty, stub.path);
			assert.equal(fs.existsSync(path.join(box.root, "args.txt")), false);
			assert.equal(fs.existsSync(empty), false);
			const broken = path.join(box.root, "broken.json");
			fs.writeFileSync(broken, "{ not json");
			run(broken, stub.path);
			assert.equal(fs.existsSync(broken), false);
		} finally {
			box.cleanup();
		}
	});
});
