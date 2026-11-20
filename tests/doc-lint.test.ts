/**
 * Structural doc-lint for the persona-agents content tree.
 *
 * Runs under plain Node (type stripping) with no extra dependencies:
 *   node --experimental-strip-types --test tests/doc-lint.test.ts
 *
 * It asserts these conditions:
 *   1. every skill the companion profession lists in `## Skills` exists;
 *   2. each content/skills/<name>/SKILL.md `name:` equals its folder name;
 *   3. the plugin manifest ships exactly the skill folders of content/skills;
 *   4. every agents.json theme maps exactly the professions of
 *      content/professions, and each persona file exists.
 *
 * It does not check doctrine prose.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(repoRoot, "content");
const skillsRoot = path.join(contentDir, "skills");
const professionsDir = path.join(contentDir, "professions");

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

/** The skill folder names: each direct child of content/skills that holds a SKILL.md. */
function skillFolders(): string[] {
	return fs
		.readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

/** The profession names: the .md files of content/professions without the extension. */
function professionNames(): string[] {
	return fs
		.readdirSync(professionsDir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -3))
		.sort();
}

/** Text between a heading matching `heading` and the next `## ` heading. */
function sectionAfterHeading(text: string, heading: RegExp): string {
	const match = heading.exec(text);
	if (!match) return "";
	const rest = text.slice(match.index + match[0].length);
	const next = rest.search(/^##\s/m);
	return next === -1 ? rest : rest.slice(0, next);
}

/** Bold `**kebab-name**` tokens in a section. */
function boldNames(section: string): string[] {
	return [...new Set([...section.matchAll(/\*\*([a-z0-9-]+)\*\*/g)].map((match) => match[1]))];
}

/** A `key: value` frontmatter line, with simple quotes stripped. */
function frontmatterValue(text: string, key: string): string | undefined {
	const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
	return match?.[1].replace(/^["']|["']$/g, "");
}

describe("condition 1: the profession names only real skills", () => {
	for (const profession of professionNames()) {
		test(`${profession}: every ## Skills entry exists`, () => {
			const section = sectionAfterHeading(readText(path.join(professionsDir, `${profession}.md`)), /^##\s+Skills\s*$/m);
			const names = boldNames(section);
			assert.ok(names.length > 0, `${profession}.md lists no skill`);
			const missing = names.filter((name) => !fs.existsSync(path.join(skillsRoot, name, "SKILL.md")));
			assert.deepEqual(missing, [], `${profession}.md names missing skills`);
		});
	}
});

describe("condition 2: SKILL.md name equals its folder name", () => {
	for (const folder of skillFolders()) {
		test(folder, () => {
			assert.equal(frontmatterValue(readText(path.join(skillsRoot, folder, "SKILL.md")), "name"), folder);
		});
	}
});

describe("condition 3: the plugin manifest ships every skill folder", () => {
	test("plugin.json skills equal the content/skills folders", () => {
		const manifest = JSON.parse(readText(path.join(repoRoot, ".claude-plugin", "plugin.json"))) as { skills: string[] };
		const shipped = manifest.skills.map((entry) => entry.replace(/^\.\/content\/skills\//, "").replace(/\/$/, "")).sort();
		assert.deepEqual(shipped, skillFolders());
	});
});

describe("condition 4: agents.json matches content/professions and content/personas", () => {
	/** Professions that carry no voice, so no theme maps them to a persona. */
	const VOICELESS = ["reviewer"];

	test("every theme maps exactly the professions, to persona files that exist", () => {
		const registry = JSON.parse(readText(path.join(contentDir, "agents.json"))) as Record<
			string,
			Record<string, { personaFile?: string }>
		>;
		const expected = professionNames().filter((name) => !VOICELESS.includes(name));
		assert.ok(Object.keys(registry).length > 0, "agents.json must hold at least one theme");
		const bad: string[] = [];
		for (const [theme, professions] of Object.entries(registry)) {
			const names = Object.keys(professions).sort();
			if (JSON.stringify(names) !== JSON.stringify(expected)) bad.push(`${theme}: ${names.join(",")}`);
			for (const [profession, entry] of Object.entries(professions)) {
				const file = path.join(contentDir, "personas", theme, entry.personaFile ?? "");
				if (!entry.personaFile || !fs.existsSync(file)) bad.push(`${theme}/${profession}: no persona file`);
			}
		}
		assert.deepEqual(bad, [], "agents.json drifted from content/");
	});
});
