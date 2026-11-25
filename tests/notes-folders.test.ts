/**
 * The project notes folders: `tasks/` for task notes and `session-logs/` for
 * session logs. The old `sessions/` and `journal/` folders are not read. The
 * session-log cases run against the shared module and the Claude Code CLI
 * that re-exports it.
 *
 * Run: node --experimental-strip-types --test tests/notes-folders.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as shared from "../platforms/shared/notes/session-log.ts";
import * as claude from "../platforms/claude/scripts/session-log.mjs";
import { activeTaskNotes, openTaskNotes, startupContext } from "../platforms/shared/notes/notes.ts";
import { writtenTaskNotes } from "../platforms/shared/notes/session-log-net.ts";

function withNotes(fn: (notes: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-folders-"));
	try {
		fn(path.join(root, "notes"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

const openTask = (session: string) => `# Task\n\n- **Status:** open\n- **Sessions:** ${session}\n`;

for (const [name, impl] of [["shared", shared], ["claude", claude]] as const) {
	const { entryPath, findEntry, recentEntries } = impl;

	describe(`notes folders (${name}): session logs live in session-logs/ only`, () => {
		test("a new session log lands under session-logs/", () => {
			withNotes((notes) => {
				const now = new Date(2026, 10, 24, 9, 5);
				assert.equal(entryPath(notes, "s1", now), path.join(notes, "session-logs", "2026-11-24", "0905-s1.md"));
			});
		});

		test("an entry left in the old journal/ folder is not found", () => {
			withNotes((notes) => {
				write(path.join(notes, "journal", "2026-11-24", "0800-s1.md"), "# old\n");
				assert.equal(findEntry(notes, "s1", ["2026-11-24"]), "");
			});
		});

		test("recent entries come from session-logs/ only", () => {
			withNotes((notes) => {
				const fresh = path.join(notes, "session-logs", "2026-11-24", "0900-b.md");
				write(path.join(notes, "journal", "2026-11-23", "0800-a.md"), "# a\n");
				write(fresh, "# b\n");
				assert.deepEqual(recentEntries(notes, 3), [fresh]);
			});
		});
	});
}

describe("notes folders: task notes live in tasks/ only", () => {
	test("open task notes come from tasks/, not the old sessions/", () => {
		withNotes((notes) => {
			const fresh = path.join(notes, "tasks", "2026-11-24-new.md");
			write(fresh, openTask("s1"));
			write(path.join(notes, "sessions", "2026-11-20-old.md"), openTask("s0"));
			assert.deepEqual(openTaskNotes(notes), [fresh]);
		});
	});

	test("the active task notes are not found in the old sessions/ folder", () => {
		withNotes((notes) => {
			write(path.join(notes, "sessions", "2026-11-20-old.md"), openTask("s0"));
			assert.equal(activeTaskNotes(notes, "s0", []), "");
		});
	});

	test("only a write under tasks/ counts as task notes the session wrote", () => {
		withNotes((notes) => {
			const call = (file: string) => ({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: file } }] },
			});
			const fresh = path.join(notes, "tasks", "a.md");
			const old = path.join(notes, "sessions", "b.md");
			assert.deepEqual(writtenTaskNotes([call(fresh), call(old), call(path.join(notes, "summary.md"))], notes), [fresh]);
		});
	});
});

describe("notes folders: the startup read list uses the new names", () => {
	test("it lists session logs and open task notes", () => {
		withNotes((notes) => {
			write(path.join(notes, "session-logs", shared.dayOf(new Date()), "0900-s.md"), "# s\n");
			write(path.join(notes, "tasks", "t.md"), openTask("s"));
			const text = startupContext(notes, "demo");
			assert.match(text, /session logs of the last \d+ days/);
			assert.match(text, /Open task notes \(read each; offer to resume or close it\):\n- .*tasks\/t\.md/);
			assert.doesNotMatch(text, /journal|session notes/i);
		});
	});
});
