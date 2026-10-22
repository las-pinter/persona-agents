/**
 * Structural checks for the pi prompt templates declared in `package.json`.
 *
 * The `pi.prompts` globs decide which templates ship. Pi turns the filename
 * into the slash command, so a broken glob or a dead skill reference removes a
 * command with no other signal. No other test reads `package.json`.
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
