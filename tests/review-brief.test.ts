/**
 * Checks shared/review/brief.ts: the brief every adapter starts a review from.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareBrief, UNCOMMITTED, type GitRun } from "../platforms/shared/review/brief.ts";

/** A git stand-in that records each call and answers with one subject. */
function fakeGit(): { git: GitRun; calls: string[][] } {
	const calls: string[][] = [];
	return { calls, git: async (args) => (calls.push(args), { code: 0, stdout: "add the widget\n" }) };
}

function withNotes(run: (notesDir: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-brief-"));
		try {
			await run(notesDir);
		} finally {
			fs.rmSync(notesDir, { recursive: true, force: true });
		}
	};
}

describe("review brief: the task from commit subjects", () => {
	test("a named scope with no study takes its task from the commit subjects", withNotes(async (notesDir) => {
		// Arrange
		const { git, calls } = fakeGit();

		// Act
		const prepared = await prepareBrief({ scope: "main" }, { notesDir, git });

		// Assert
		assert.equal(prepared.brief.task, "add the widget");
		assert.ok(calls.length > 0);
		assert.equal(prepared.workingTree, false);
	}));

	test("the uncommitted change asks git nothing and names the default scope", withNotes(async (notesDir) => {
		const { git, calls } = fakeGit();
		const prepared = await prepareBrief({}, { notesDir, git });
		assert.deepEqual(calls, []);
		assert.equal(prepared.brief.scope, UNCOMMITTED);
		assert.equal(prepared.workingTree, true);
	}));

	test("a task the author named is kept and git is not asked", withNotes(async (notesDir) => {
		const { git, calls } = fakeGit();
		const prepared = await prepareBrief({ scope: "main", task: "fix the gate" }, { notesDir, git });
		assert.equal(prepared.brief.task, "fix the gate");
		assert.deepEqual(calls, []);
	}));
});
