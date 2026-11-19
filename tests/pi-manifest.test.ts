/**
 * The compaction manifest (platforms/shared/compaction/manifest.ts).
 *
 * A compaction must not lose the plan. The manifest names the skills the
 * session used, the session notes file, and the documents to re-read; the
 * summary focus tells Pi's summarizer to keep the task and the plan step.
 *
 * Run: node --experimental-strip-types --test tests/pi-manifest.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest, reloadContext, skillOfPath, summaryInstructions, type EntryLike } from "../platforms/shared/compaction/manifest.ts";

/** An assistant message holding the given tool calls, in pi's block shape. */
function toolCalls(...calls: { name: string; args: Record<string, unknown> }[]): EntryLike {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: calls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, name: call.name, arguments: call.args })),
		},
	};
}

function userText(text: string): EntryLike {
	return { type: "message", message: { role: "user", content: text } };
}

/** A project notes tree with rules, a summary, one session notes file, and a study. */
function fixture(): { root: string; notesDir: string; sessionNotes: string; study: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-manifest-"));
	const notesDir = path.join(root, "agent-notes", "project-notes", "demo");
	const study = path.join(notesDir, "studies", "live", "study.md");
	const sessionNotes = path.join(notesDir, "sessions", "2026-01-01-gate.md");
	for (const dir of [path.join(notesDir, "rules"), path.join(notesDir, "sessions"), path.join(notesDir, "studies", "live")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(path.join(notesDir, "rules", "house.md"), "# House rules\n");
	fs.writeFileSync(path.join(notesDir, "summary.md"), "# Summary\n");
	fs.writeFileSync(study, "# Study\n");
	fs.writeFileSync(
		sessionNotes,
		[
			"# Gate task",
			"",
			"- **Status:** open",
			`- **Study:** ${study}`,
			"",
			"## Plan",
			"",
			"- [x] build the floor",
			"- [ ] wire the reload list  ← current",
			"",
			"## Pinned",
			"",
			`- ${path.join(notesDir, "pinned", "api.md")}`,
			"",
		].join("\n"),
	);
	return { root, notesDir, sessionNotes, study, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("pi manifest: what to reload", () => {
	test("the skills, the session notes, and the documents are collected", () => {
		const box = fixture();
		try {
			const entries: EntryLike[] = [
				userText("/skill:interview settle the policy format"),
				toolCalls({ name: "read", args: { path: "/pkg/content/skills/review/SKILL.md" } }),
				toolCalls({ name: "read", args: { path: path.join(box.notesDir, "rules", "house.md") } }),
				toolCalls({ name: "write", args: { path: box.sessionNotes } }),
				// Not reloaded: working source, and a journal entry.
				toolCalls({ name: "read", args: { path: "/repo/src/gate.ts" } }),
				toolCalls({ name: "read", args: { path: path.join(box.notesDir, "journal", "2026-01-01", "1200-s1.md") } }),
			];
			const manifest = buildManifest(entries, box.notesDir);
			assert.equal(manifest.sessionNotes, box.sessionNotes);
			assert.deepEqual(manifest.skills, ["review", "interview"]);
			assert.deepEqual(manifest.docs, [
				path.join(box.notesDir, "rules", "house.md"),
				path.join(box.notesDir, "summary.md"),
				box.study,
				path.join(box.notesDir, "pinned", "api.md"),
			]);
			assert.equal(manifest.docs.includes(box.sessionNotes), false, "the session notes are step 1, not a doc");
		} finally {
			box.cleanup();
		}
	});

	test("a last-write session notes file wins, and a second session file is not stale", () => {
		const box = fixture();
		try {
			const second = path.join(box.notesDir, "sessions", "2026-01-02-other.md");
			fs.writeFileSync(second, "# Other\n");
			const manifest = buildManifest(
				[toolCalls({ name: "write", args: { path: box.sessionNotes } }), toolCalls({ name: "edit", args: { path: second } })],
				box.notesDir,
			);
			assert.equal(manifest.sessionNotes, second);
		} finally {
			box.cleanup();
		}
	});

	test("an empty branch still gives a usable manifest", () => {
		const box = fixture();
		try {
			const manifest = buildManifest([], box.notesDir);
			assert.equal(manifest.sessionNotes, "");
			assert.deepEqual(manifest.skills, []);
			assert.deepEqual(manifest.docs, [path.join(box.notesDir, "rules", "house.md"), path.join(box.notesDir, "summary.md")]);
			const text = reloadContext(manifest);
			assert.match(text, /No session notes file was found/);
			assert.match(text, /- none/);
		} finally {
			box.cleanup();
		}
	});

	test("a missing notes folder yields no documents and no crash", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-empty-"));
		try {
			const manifest = buildManifest([], path.join(root, "nowhere"));
			assert.deepEqual(manifest.docs, []);
			assert.match(reloadContext(manifest), /No session notes file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pi manifest: the text Pi gets", () => {
	test("the summary focus keeps the task, the plan step, and the notes path", () => {
		const box = fixture();
		try {
			const manifest = buildManifest([toolCalls({ name: "write", args: { path: box.sessionNotes } })], box.notesDir);
			const focus = summaryInstructions(manifest);
			assert.match(focus, /current task/);
			assert.match(focus, /plan step/);
			assert.match(focus, /reloaded after compaction/);
			assert.ok(focus.includes(box.sessionNotes), "the focus names the session notes path");
		} finally {
			box.cleanup();
		}
	});

	test("the reload list is ordered, and tells the model not to re-read source", () => {
		const box = fixture();
		try {
			const manifest = buildManifest(
				[toolCalls({ name: "read", args: { path: "/pkg/content/skills/review/SKILL.md" } }), toolCalls({ name: "write", args: { path: box.sessionNotes } })],
				box.notesDir,
			);
			const text = reloadContext(manifest);
			const notes = text.indexOf("1. Read the session notes file first");
			const skills = text.indexOf("2. Re-read these skills");
			const docs = text.indexOf("3. Re-read these documents");
			const stop = text.indexOf("4. Do not re-read working source files");
			assert.ok(notes > 0 && skills > notes && docs > skills && stop > docs, text);
			assert.match(text, /- review/);
			assert.ok(text.includes(box.sessionNotes));
		} finally {
			box.cleanup();
		}
	});

	test("a skill path is recognised in both path styles", () => {
		assert.equal(skillOfPath("/pkg/content/skills/review/SKILL.md"), "review");
		assert.equal(skillOfPath(String.raw`C:\pkg\skills\interview\SKILL.md`), "interview");
		assert.equal(skillOfPath("/pkg/content/skills/SKILL.md"), null);
		assert.equal(skillOfPath("/pkg/content/skills/review/README.md"), null);
	});
});
