/**
 * The Pi prompt context and read list (platforms/pi/scripts/context.ts,
 * notes.ts, journal.ts).
 *
 * The sections are built from the shared content tree, so this suite also pins
 * the contract the Claude adapter depends on: the profession is sent verbatim,
 * the persona is voice only, and the read list names paths rather than
 * contents.
 *
 * Run: node --experimental-strip-types --test tests/pi-context.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ContentError,
	loadRegistry,
	personaText,
	platformNote,
	professionText,
	promptSections,
	resolveTheme,
	themeNames,
} from "../platforms/pi/scripts/context.ts";
import { entryPath, dayOf, recentEntries } from "../platforms/shared/notes/journal.ts";
import { openSessionNotes, startupContext, unfinishedStudies } from "../platforms/shared/notes/notes.ts";
import { PROFILES } from "../platforms/pi/scripts/profile.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const registry = loadRegistry(contentDir);
const companion = PROFILES.companion;
const reviewer = PROFILES.reviewer;

describe("pi context: the content tree", () => {
	test("every theme the Claude plugin ships is here", () => {
		const themes = themeNames(registry);
		assert.ok(themes.length >= 8, `only ${themes.length} themes`);
		for (const theme of themes) assert.ok(registry[theme].companion?.personaFile, theme);
	});

	test("the default theme resolves and an unknown theme refuses with the list", () => {
		assert.equal(resolveTheme(registry, undefined), "goblin");
		assert.equal(resolveTheme(registry, "pub"), "pub");
		assert.throws(() => resolveTheme(registry, "nosuch"), ContentError);
		assert.throws(() => resolveTheme(registry, "nosuch"), /known themes: .*goblin/);
	});

	test("the profession is sent verbatim", () => {
		const file = fs.readFileSync(path.join(contentDir, "professions", "companion.md"), "utf8").trim();
		assert.equal(professionText(contentDir, "companion"), file);
	});

	test("a persona is voice and the profession keeps precedence", () => {
		const persona = personaText(contentDir, registry, "goblin", companion);
		assert.ok(persona);
		assert.match(persona, /Bossnik/);
		const sections = promptSections(contentDir, registry, "goblin", companion);
		assert.match(sections.persona, /theme: goblin/);
		assert.match(sections.persona, /profession rules take precedence/);
		assert.equal(sections.profession, professionText(contentDir, "companion"));
	});

	test("the reviewer gets no persona, and the note says it is read-only", () => {
		const sections = promptSections(contentDir, registry, "goblin", reviewer);
		assert.equal(sections.persona, undefined);
		assert.match(sections.platform, /read-only/);
		assert.match(platformNote(reviewer), /You are read-only/);
		assert.doesNotMatch(platformNote(companion), /You are read-only/);
	});

	test("the platform note names the Pi shapes of the shared instructions", () => {
		const note = platformNote(companion);
		assert.match(note, /## Running in Pi/);
		assert.match(note, /SKILL\.md/);
		assert.match(note, /ask_user_question/);
		assert.match(note, /`review` tool/);
	});

	test("the review skill tells a Pi companion to call the review tool", () => {
		const skill = fs.readFileSync(path.join(contentDir, "skills", "review", "SKILL.md"), "utf8");
		assert.match(skill, /Running in Pi/);
		assert.match(skill, /`review` tool/);
	});
});

describe("pi notes: the startup read list", () => {
	function notesFixture(): { root: string; notesDir: string; cleanup: () => void } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-notes-"));
		const notesDir = path.join(root, "agent-notes", "project-notes", "common");
		fs.mkdirSync(path.join(notesDir, "rules"), { recursive: true });
		fs.mkdirSync(path.join(notesDir, "sessions"), { recursive: true });
		fs.mkdirSync(path.join(notesDir, "studies"), { recursive: true });
		fs.writeFileSync(path.join(notesDir, "rules", "house.md"), "# House\n");
		fs.writeFileSync(path.join(notesDir, "rules", "notes.txt"), "not a rule\n");
		fs.writeFileSync(path.join(notesDir, "summary.md"), "# Summary\n");
		fs.writeFileSync(path.join(notesDir, "sessions", "2026-01-01-open.md"), "# Task\n\n- **Status:** open\n");
		fs.writeFileSync(path.join(notesDir, "sessions", "2026-01-01-done.md"), "# Task\n\n- **Status:** done\n");
		fs.writeFileSync(
			path.join(notesDir, "studies", "index.md"),
			[
				"| title | stage | updated | path |",
				"| --- | --- | --- | --- |",
				"| Live | in-progress | 2026-01-01 | `studies/live/study.md` |",
				"| Dead | done | 2026-01-01 | `studies/dead/study.md` |",
				"",
			].join("\n"),
		);
		return { root, notesDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
	}

	test("open session notes and unfinished studies are found, finished ones are not", () => {
		const fixture = notesFixture();
		try {
			const open = openSessionNotes(fixture.notesDir);
			assert.equal(open.length, 1);
			assert.match(open[0], /open\.md$/);
			const studies = unfinishedStudies(fixture.notesDir);
			assert.equal(studies.length, 1);
			assert.match(studies[0], /Live \(in-progress\): .*studies\/live\/study\.md$/);
		} finally {
			fixture.cleanup();
		}
	});

	test("the read list names paths, orders rules before the summary, and skips done work", () => {
		const fixture = notesFixture();
		try {
			const text = startupContext(fixture.notesDir, "common");
			assert.match(text, /^# Session start: read list/);
			assert.match(text, /Project: common/);
			const rulesAt = text.indexOf("rules/house.md");
			const summaryAt = text.indexOf("summary.md");
			assert.ok(rulesAt > 0 && summaryAt > rulesAt, "rules come before the summary");
			assert.doesNotMatch(text, /notes\.txt/);
			assert.match(text, /sessions\/2026-01-01-open\.md/);
			assert.doesNotMatch(text, /2026-01-01-done\.md/);
			assert.match(text, /Unfinished studies/);
			assert.doesNotMatch(text, /Dead/);
			// Paths, not contents: the read list stays small.
			assert.doesNotMatch(text, /# House/);
		} finally {
			fixture.cleanup();
		}
	});

	test("a missing notes folder still gives a usable list", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-empty-"));
		try {
			const notesDir = path.join(root, "agent-notes", "project-notes", "common");
			const text = startupContext(notesDir, "common");
			assert.match(text, /does not exist yet/);
			assert.equal(text.match(/- none/g)?.length, 4);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pi journal: one entry per session", () => {
	test("the last three day folders come back oldest first", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-journal-"));
		try {
			const notesDir = path.join(root, "notes");
			for (const day of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
				fs.mkdirSync(path.join(notesDir, "journal", day), { recursive: true });
				fs.writeFileSync(path.join(notesDir, "journal", day, "1200-s1.md"), `# ${day}\n`);
			}
			const entries = recentEntries(notesDir, 3);
			assert.equal(entries.length, 3);
			assert.match(entries[0], /2026-01-02/);
			assert.match(entries[2], /2026-01-04/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("an entry path is reused for today and yesterday, and a session id is made safe", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-entry-"));
		try {
			const notesDir = path.join(root, "notes");
			const now = new Date(2026, 0, 2, 15, 30);
			const first = entryPath(notesDir, "sess/1", now);
			fs.mkdirSync(path.dirname(first), { recursive: true });
			fs.writeFileSync(first, "# entry\n");
			assert.equal(entryPath(notesDir, "sess/1", new Date(2026, 0, 2, 18, 0)), first);
			assert.equal(entryPath(notesDir, "sess/1", new Date(2026, 0, 3, 9, 0)), first);
			const later = entryPath(notesDir, "sess/1", new Date(2026, 0, 4, 9, 0));
			assert.notEqual(later, first);
			assert.match(later, /2026-01-04\/0900-sess_1\.md$/);
			assert.equal(dayOf(now), "2026-01-02");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
