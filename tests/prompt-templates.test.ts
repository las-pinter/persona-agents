/**
 * Structural checks for the shared commands in `content/commands/`.
 *
 * The `pi.prompts` globs in `package.json` decide which commands pi ships.
 * Each platform turns the filename into the slash command, so a broken glob
 * or a dead skill reference removes a command with no other signal. The
 * install.sh copy is covered by tests/install-sh.test.ts.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "content", "skills");
const commandsDir = path.join(repoRoot, "content", "commands");

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

/** Read a scalar `key: value` line, stripping simple quotes. */
function parseScalar(text: string, key: string): string | undefined {
	const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (!match) return undefined;
	let value = match[1].trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return value.length > 0 ? value : undefined;
}

/** Minimal glob to RegExp: `*` stays in one path segment, `**` crosses. */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/** Repo-relative files a manifest glob matches. Anchored at the static prefix. */
function matchesForPattern(pattern: string): string[] {
	const normalized = pattern.replace(/^\.\//, "");
	const globAt = normalized.search(/[*?]/);
	const staticPart = globAt === -1 ? normalized : normalized.slice(0, globAt);
	const baseDir = path.dirname(staticPart);
	const absBase = path.join(repoRoot, baseDir);
	if (!fs.existsSync(absBase)) return [];
	const matcher = globToRegExp(normalized);
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				const rel = path.relative(repoRoot, full).split(path.sep).join("/");
				if (matcher.test(rel)) out.push(rel);
			}
		}
	};
	walk(absBase);
	return out.sort();
}

/** `skills/<group>/<name>` tokens a prompt template names. */
function skillRefs(text: string): string[] {
	const refs = new Set<string>();
	const re = /\bskills\/([a-z0-9-]+)\/([a-z0-9-]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) refs.add(`${match[1]}/${match[2]}`);
	return [...refs];
}

const manifest = JSON.parse(readText(path.join(repoRoot, "package.json"))) as {
	pi?: { prompts?: unknown };
};
const promptPatterns = Array.isArray(manifest.pi?.prompts)
	? manifest.pi.prompts.filter((value): value is string => typeof value === "string")
	: [];

const matched = promptPatterns.flatMap((pattern) => matchesForPattern(pattern));

describe("pi prompt templates: manifest ships each command", () => {
	test("package.json declares a non-empty pi.prompts list", () => {
		assert.ok(promptPatterns.length > 0, "pi.prompts must list at least one glob");
	});

	for (const pattern of promptPatterns) {
		test(`pi.prompts glob ${pattern} matches at least one template`, () => {
			assert.ok(matchesForPattern(pattern).length > 0, `pi.prompts glob ${pattern} matched no file`);
		});
	}
});

describe("shared commands: pi ships every command", () => {
	test("pi.prompts ships every file in content/commands", () => {
		const commands = fs
			.readdirSync(commandsDir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => `content/commands/${name}`)
			.sort();
		assert.ok(commands.length > 0, "content/commands must hold a command file");
		assert.deepEqual(matched, commands);
	});
});

describe("shared commands: a skill with platform references carries the pi reference", () => {
	const withReferences = fs
		.readdirSync(skillsRoot)
		.flatMap((group) => fs.readdirSync(path.join(skillsRoot, group)).map((name) => path.join(skillsRoot, group, name)))
		.filter((dir) => fs.existsSync(path.join(dir, "references")));

	test("the retro skill has platform references", () => {
		assert.ok(withReferences.includes(path.join(skillsRoot, "common", "retro")));
	});

	for (const dir of withReferences) {
		const rel = path.relative(skillsRoot, dir);
		test(`${rel} has references/pi.md`, () => {
			assert.ok(fs.existsSync(path.join(dir, "references", "pi.md")), `${rel}: references/pi.md is missing`);
		});
	}
});

describe("retro reach: every agent with tools can load the retro skill", () => {
	const platformsDir = path.join(repoRoot, "platforms");
	/** Mascot has no tools, so it cannot read a transcript. */
	const professions = ["orchestrator", "planner", "researcher", "implementer", "reviewer", "tester"];

	for (const profession of professions) {
		test(`pi ${profession} lists common/retro in skills`, () => {
			const text = readText(path.join(platformsDir, "pi", "frontmatters", `${profession}.yaml`));
			assert.match(text, /^skills: \[.*"common\/retro".*\]$/m);
		});
	}
});

describe("pi prompt templates: frontmatter and skill references resolve", () => {
	test("the manifest matches at least one template", () => {
		assert.ok(matched.length > 0, `pi.prompts matched no file: ${promptPatterns.join(", ")}`);
	});

	for (const file of matched) {
		test(`${file} has a description`, () => {
			const description = parseScalar(readText(path.join(repoRoot, file)), "description");
			assert.ok(description, `${file} has no description frontmatter`);
		});

		test(`${file} names only skills that exist`, () => {
			const dead = skillRefs(readText(path.join(repoRoot, file))).filter(
				(ref) => !fs.existsSync(path.join(skillsRoot, ref, "SKILL.md")),
			);
			assert.deepEqual(dead, [], `${file} names dead skills`);
		});
	}
});
