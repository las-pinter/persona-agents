/**
 * The compaction manifest (platforms/shared/compaction/manifest.ts).
 *
 * A compaction must not lose the plan. The manifest names the skills the
 * session used, the task notes file, and the documents to re-read; the
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

/** A project notes tree with rules, a summary, one task notes file, and a study. */
function fixture(): { root: string; notesDir: string; taskNotes: string; study: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-pi-manifest-"));
	const notesDir = path.join(root, "agent-notes", "project-notes", "demo");
	const study = path.join(notesDir, "studies", "live", "study.md");
	const taskNotes = path.join(notesDir, "tasks", "2026-01-01-gate.md");
	for (const dir of [path.join(notesDir, "rules"), path.join(notesDir, "tasks"), path.join(notesDir, "studies", "live")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(path.join(notesDir, "rules", "house.md"), "# House rules\n");
	fs.writeFileSync(path.join(notesDir, "summary.md"), "# Summary\n");
	fs.writeFileSync(study, "# Study\n");
	fs.writeFileSync(
		taskNotes,
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
	return { root, notesDir, taskNotes, study, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("pi manifest: what to reload", () => {
	test("the skills, the task notes, and the documents are collected", () => {
		const box = fixture();
		try {
			const entries: EntryLike[] = [
				userText("/skill:interview settle the policy format"),
				toolCalls({ name: "read", args: { path: "/pkg/content/skills/review/SKILL.md" } }),
				toolCalls({ name: "read", args: { path: path.join(box.notesDir, "rules", "house.md") } }),
				toolCalls({ name: "write", args: { path: box.taskNotes } }),
				// Not reloaded: working source, and a session log.
				toolCalls({ name: "read", args: { path: "/repo/src/gate.ts" } }),
				toolCalls({ name: "read", args: { path: path.join(box.notesDir, "session-logs", "2026-01-01", "1200-s1.md") } }),
			];
			const manifest = buildManifest(entries, box.notesDir);
			assert.equal(manifest.taskNotes, box.taskNotes);
			assert.deepEqual(manifest.skills, ["review", "interview"]);
			assert.deepEqual(manifest.docs, [
				path.join(box.notesDir, "rules", "house.md"),
				path.join(box.notesDir, "summary.md"),
				box.study,
				path.join(box.notesDir, "pinned", "api.md"),
			]);
			assert.equal(manifest.docs.includes(box.taskNotes), false, "the task notes are step 1, not a doc");
			// A reloaded skill is instructions, not work: `review` must not
			// start a review just because a compaction happened.
			assert.match(reloadContext(manifest), /Reloading a skill loads its instructions/);
		} finally {
			box.cleanup();
		}
	});

	test("a resumed session that only read its notes gets them from the Sessions line", () => {
		const box = fixture();
		try {
			const mine = path.join(box.notesDir, "tasks", "2026-01-03-mine.md");
			fs.writeFileSync(mine, "# Mine\n\n- **Status:** open\n- **Sessions:** sess-9\n");
			const manifest = buildManifest([userText("hello")], box.notesDir, "sess-9");
			assert.equal(manifest.taskNotes, mine);
			assert.equal(manifest.session, "sess-9");
			assert.match(reloadContext(manifest), /Session id: sess-9/);
		} finally {
			box.cleanup();
		}
	});

	test("a last-write task notes file wins, and a second session file is not stale", () => {
		const box = fixture();
		try {
			const second = path.join(box.notesDir, "tasks", "2026-01-02-other.md");
			fs.writeFileSync(second, "# Other\n");
			const manifest = buildManifest(
				[toolCalls({ name: "write", args: { path: box.taskNotes } }), toolCalls({ name: "edit", args: { path: second } })],
				box.notesDir,
			);
			assert.equal(manifest.taskNotes, second);
		} finally {
			box.cleanup();
		}
	});

	test("an empty branch falls back to the only open notes file", () => {
		const box = fixture();
		try {
			const manifest = buildManifest([], box.notesDir);
			assert.equal(manifest.taskNotes, box.taskNotes);
			assert.deepEqual(manifest.skills, []);
			assert.deepEqual(manifest.docs, [
				path.join(box.notesDir, "rules", "house.md"),
				path.join(box.notesDir, "summary.md"),
				box.study,
				path.join(box.notesDir, "pinned", "api.md"),
			]);
			const text = reloadContext(manifest);
			assert.ok(text.includes(box.taskNotes));
			assert.match(text, /- none/);
		} finally {
			box.cleanup();
		}
	});

	test("no id match, no write, and two open files leave no notes file", () => {
		const box = fixture();
		try {
			fs.writeFileSync(
				path.join(box.notesDir, "tasks", "2026-01-02-other.md"),
				"# Other\n\n- **Status:** open\n",
			);
			const manifest = buildManifest([], box.notesDir);
			assert.equal(manifest.taskNotes, "");
			assert.match(reloadContext(manifest), /No task notes file was found/);
		} finally {
			box.cleanup();
		}
	});

	test("a missing notes folder yields no documents and no crash", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-pi-empty-"));
		try {
			const manifest = buildManifest([], path.join(root, "nowhere"));
			assert.deepEqual(manifest.docs, []);
			assert.match(reloadContext(manifest), /No task notes file/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pi manifest: the text Pi gets", () => {
	test("the summary focus keeps the task, the plan step, and the notes path", () => {
		const box = fixture();
		try {
			const manifest = buildManifest([toolCalls({ name: "write", args: { path: box.taskNotes } })], box.notesDir);
			const focus = summaryInstructions(manifest);
			assert.match(focus, /current task/);
			assert.match(focus, /plan step/);
			assert.match(focus, /reloaded after compaction/);
			assert.ok(focus.includes(box.taskNotes), "the focus names the task notes path");
		} finally {
			box.cleanup();
		}
	});

	test("the reload list is ordered, and tells the model not to re-read source", () => {
		const box = fixture();
		try {
			const manifest = buildManifest(
				[toolCalls({ name: "read", args: { path: "/pkg/content/skills/review/SKILL.md" } }), toolCalls({ name: "write", args: { path: box.taskNotes } })],
				box.notesDir,
			);
			const text = reloadContext(manifest);
			const notes = text.indexOf("1. Read the task notes file first");
			const skills = text.indexOf("2. Re-read these skills");
			const docs = text.indexOf("3. Re-read these documents");
			const stop = text.indexOf("4. Do not re-read working source files");
			assert.ok(notes > 0 && skills > notes && docs > skills && stop > docs, text);
			assert.match(text, /- review/);
			assert.ok(text.includes(box.taskNotes));
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
