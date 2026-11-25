/**
 * The Kiro branches inside the shared skills.
 *
 * Three skills carry harness-specific mechanics: `review` (a Claude fork that
 * Kiro runs as a sub-agent), `retro` (a Claude transcript that Kiro reads from
 * its session store), and `wrap-up` (a Claude session-log command that Kiro runs
 * from its own script). Each starts with a branch that checks the system
 * context for `Running in Kiro CLI` and points at `references/kiro.md`.
 *
 * The installer substitutes two tokens:
 *   {{COMPANION_AGENTS_KIRO_SKILL_DIR}}  the installed skill folder
 *   {{COMPANION_AGENTS_KIRO_ROOT}}      the installed payload root
 *
 * Run: node --experimental-strip-types --test tests/kiro-skills.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "content", "skills");
const BRANCH = "Running in Kiro CLI";
const SKILL_DIR = "{{COMPANION_AGENTS_KIRO_SKILL_DIR}}/references/kiro.md";
const ROOT_TOKEN = "{{COMPANION_AGENTS_KIRO_ROOT}}";

const harnessBound: Record<string, RegExp> = {
	review: /review\.ts/,
	retro: /retro\.ts/,
	"wrap-up": /session-log\.ts/,
};

/** The skill folder names that hold a SKILL.md. */
function skillFolders(): string[] {
	return fs
		.readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

describe("kiro skills: the platform branch", () => {
	test("only the three harness-bound skills carry the Kiro branch", () => {
		for (const name of skillFolders()) {
			const text = fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
			assert.equal(text.includes(BRANCH), name in harnessBound, `${name} branch presence`);
		}
	});

	for (const [name, command] of Object.entries(harnessBound)) {
		test(`${name}: the branch names the reference and the reference names the script`, () => {
			const skill = fs.readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
			assert.match(skill, new RegExp(BRANCH));
			assert.ok(skill.includes("references/kiro.md"), `${name} does not name the reference`);
			assert.ok(skill.includes(SKILL_DIR) || skill.includes(ROOT_TOKEN), `${name} has no installed path token`);
			const file = path.join(skillsRoot, name, "references", "kiro.md");
			assert.ok(fs.existsSync(file), `${file} is missing`);
			const reference = fs.readFileSync(file, "utf8");
			assert.ok(reference.includes(ROOT_TOKEN), `${name} reference has no payload-root token`);
			assert.match(reference, command);
		});
	}

	test("the Claude fork fields of the review skill survive the branch", () => {
		const skill = fs.readFileSync(path.join(skillsRoot, "review", "SKILL.md"), "utf8");
		assert.match(skill, /^---\nname: review\n/);
		assert.match(skill, /^context: fork$/m);
		assert.match(skill, /^agent: companion-agents:reviewer$/m);
	});

	test("the retro skill stays print-only and slash-invoked", () => {
		const skill = fs.readFileSync(path.join(skillsRoot, "retro", "SKILL.md"), "utf8");
		assert.match(skill, /^disable-model-invocation: true$/m);
		assert.match(skill, /Write nothing\s+durable/);
	});
});
