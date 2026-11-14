/**
 * Sidebar data tests for the study status rows: the panel order, the glyph,
 * the age, the poll, and the home notes tree.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data-study.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSidebarData } from "./sidebar-data.ts";
import { STUDY_POLL_MS } from "./sidebar-data-study.ts";
import {
	NOTES_STUDIES,
	makeFakeCtx,
	makeFakePi,
	makeNotesHome,
	readStatusPanel,
	studyNames,
	studyStatusFile,
	withHome,
} from "./sidebar-data-fixtures.ts";

test("an active study paints one row with its brief count and age", async () => {
	const files: Record<string, string> = {
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
		[`${NOTES_STUDIES}/2026-01-05-alpha/briefs/notes.txt`]: "not a brief",
	};
	for (const name of ["01-one.md", "02-two.md", "03-three.md", "04-four.md"]) {
		files[`${NOTES_STUDIES}/2026-01-05-alpha/briefs/${name}`] = "brief";
	}
	const home = makeNotesHome(files);
	try {
		const now = Date.parse("2026-01-05T00:00:00.000Z");
		const lines = await readStatusPanel({}, home, "/repo", now);
		assert.equal(lines[0], " STUDY STATUS");
		assert.equal(lines[1], "● alpha · 4 · 0s");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the panel lists every open study, newest updated first", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("active", "2026-01-01"),
		[`${NOTES_STUDIES}/2026-02-01-beta/status.md`]: studyStatusFile("done", "2026-02-01"),
		[`${NOTES_STUDIES}/2026-03-01-gamma/status.md`]: studyStatusFile("active", "2026-03-01"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-03-01T00:00:00.000Z"));
		assert.equal(lines[1], "● gamma · 0 · 0s");
		assert.equal(lines[2], "● alpha · 0 · 1416h00m");
		assert.equal(lines.length, 3, "the closed study paints no row");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("two blocked studies keep the updated order and the warning glyph", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("blocked", "2026-01-01"),
		[`${NOTES_STUDIES}/2026-03-01-gamma/status.md`]: studyStatusFile("blocked", "2026-03-01"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-03-01T00:00:00.000Z"));
		assert.equal(lines[1], "⚠ gamma · 0 · 0s");
		assert.equal(lines[2], "⚠ alpha · 0 · 1416h00m");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the archived studies folder is not listed", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-01-alpha/status.md`]: studyStatusFile("active", "2026-01-01"),
		[`${NOTES_STUDIES}/legacy_studies/2026-01-05-old/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-01T00:00:00.000Z"));
		assert.deepEqual(lines.slice(1), ["● alpha · 0 · 0s"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a pi without exec keeps the study row and marks git", () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	const data = createSidebarData(makeFakePi({ noExec: true }));
	try {
		withHome(home, () => data.subscribe(makeFakeCtx()));
		assert.deepEqual(studyNames(data), ["alpha"]);
		assert.deepEqual(data.snapshot().workspace.changed, ["(git unavailable)"]);
	} finally {
		data.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test("an empty notes tree paints the empty line", async () => {
	const home = makeNotesHome({ "agent-notes/.keep": "" });
	try {
		const lines = await readStatusPanel({}, home);
		assert.deepEqual(lines, [" STUDY STATUS", "no study tracked"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a status file without a stage paints the unknown glyph", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]:
			"# Alpha — Status\n\n- **Updated:** 2026-01-05\n- **Owner:** planner\n",
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-05T00:00:00.000Z"));
		assert.deepEqual(lines, [" STUDY STATUS", "? alpha · 0 · 0s"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a status file without an updated date prints the fallback age", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]:
			"# Alpha — Status\n\n- **Stage:** active\n- **Owner:** planner\n",
	});
	try {
		const lines = await readStatusPanel({}, home, "/repo", Date.parse("2026-01-05T00:00:00.000Z"));
		assert.deepEqual(lines, [" STUDY STATUS", "● alpha · 0 · -"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a study folder with no status file paints no row", async () => {
	const home = makeNotesHome({ [`${NOTES_STUDIES}/2026-01-05-alpha/briefs/01-one.md`]: "brief" });
	try {
		const lines = await readStatusPanel({}, home);
		assert.deepEqual(lines, [" STUDY STATUS", "no study tracked"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a failed git read keeps the study rows", async () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	try {
		const lines = await readStatusPanel({ status: { code: 1, stdout: "" } }, home);
		assert.equal(lines[1]?.startsWith("● alpha · 0 · "), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the study reader reads only the home notes tree, not the cwd", async () => {
	const home = makeNotesHome({
		["agent-notes/project-notes/myrepo/studies/2026-01-05-alpha/status.md"]: studyStatusFile(
			"active",
			"2026-01-05",
		),
	});
	const cwdRoot = makeNotesHome({
		["myrepo/agent-notes/project-notes/myrepo/studies/2026-02-01-decoy/status.md"]: studyStatusFile(
			"active",
			"2026-02-01",
		),
	});
	try {
		const lines = await readStatusPanel({}, home, join(cwdRoot, "myrepo"));
		assert.equal(lines[1]?.startsWith("● alpha · 0 · "), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwdRoot, { recursive: true, force: true });
	}
});

test("the study poll picks up a new study", (t) => {
	const home = makeNotesHome({});
	const data = createSidebarData(makeFakePi({}));
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		withHome(home, () => {
			data.subscribe(makeFakeCtx());
			assert.deepEqual(studyNames(data), []);
			const studyDir = join(home, NOTES_STUDIES, "2026-03-01-beta");
			mkdirSync(studyDir, { recursive: true });
			writeFileSync(join(studyDir, "status.md"), studyStatusFile("blocked", "2026-03-01"));
			t.mock.timers.tick(STUDY_POLL_MS);
			assert.deepEqual(studyNames(data), ["beta"]);
			assert.equal(data.snapshot().status?.studies?.[0].stage, "blocked");
		});
	} finally {
		data.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a study that turns done mid-session keeps its row", (t) => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("active", "2026-01-05"),
	});
	const data = createSidebarData(makeFakePi({}));
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		withHome(home, () => {
			data.subscribe(makeFakeCtx());
			assert.deepEqual(studyNames(data), ["alpha"]);
			writeFileSync(
				join(home, NOTES_STUDIES, "2026-01-05-alpha", "status.md"),
				studyStatusFile("done", "2026-01-06"),
			);
			t.mock.timers.tick(STUDY_POLL_MS);
			assert.deepEqual(studyNames(data), ["alpha"], "the closed study keeps its row");
			assert.equal(data.snapshot().status?.studies?.[0].stage, "done");
		});
	} finally {
		data.dispose();
		t.mock.timers.reset();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a restart drops a study that is already done", () => {
	const home = makeNotesHome({
		[`${NOTES_STUDIES}/2026-01-05-alpha/status.md`]: studyStatusFile("done", "2026-01-06"),
	});
	const data = createSidebarData(makeFakePi({}));
	try {
		withHome(home, () => data.subscribe(makeFakeCtx()));
		assert.deepEqual(studyNames(data), [], "a fresh process state starts empty");
	} finally {
		data.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});
