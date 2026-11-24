/**
 * The Pi package manifest and the shared-module layout.
 *
 * Pi discovers package resources from the `pi` block in package.json. A path
 * that points at nothing loads nothing, silently, so this suite keeps the
 * manifest equal to what the package ships — the same job doc-lint does for
 * the Claude plugin manifest.
 *
 * Run: node --experimental-strip-types --test tests/pi-package.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewerBody } from "../platforms/pi/scripts/review-body.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), "utf8");

interface Manifest {
	version: string;
	pi?: { extensions?: string[]; skills?: string[]; prompts?: string[]; agents?: string[] };
}

const manifest = JSON.parse(read("package.json")) as Manifest;

/** The skill folders of content/skills that hold a SKILL.md. */
function skillFolders(): string[] {
	const root = path.join(repoRoot, "content", "skills");
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

/**
 * The skill folder names a manifest entry covers. A directory entry ships every
 * folder the content tree holds; a per-skill entry ships just that folder.
 */
function shippedSkills(entries: string[]): string[] {
	const shipped = new Set<string>();
	for (const entry of entries) {
		const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
		if (normalized === "content/skills") {
			for (const folder of skillFolders()) shipped.add(folder);
			continue;
		}
		shipped.add(normalized.replace(/^content\/skills\//, ""));
	}
	return [...shipped].sort();
}

describe("pi package: the manifest", () => {
	test("the pi block exists and its paths exist", () => {
		assert.ok(manifest.pi, "package.json has no pi block");
		const groups = ["extensions", "skills", "prompts", "agents"] as const;
		for (const group of groups) {
			for (const entry of manifest.pi[group] ?? []) {
				assert.ok(fs.existsSync(path.join(repoRoot, entry)), `${group}: ${entry} does not exist`);
			}
		}
	});

	test("the extension is a module with a default export", () => {
		const entry = manifest.pi?.extensions?.[0];
		assert.ok(entry);
		const source = read(entry);
		assert.match(source, /export default function/);
	});

	test("the extension module loads without Pi", async () => {
		// The wiring imports the Pi API as types only, so loading it here is
		// safe: no Pi process starts. A broken import fails CI, not a session.
		const entry = manifest.pi?.extensions?.[0];
		assert.ok(entry);
		const module = (await import(path.join(repoRoot, entry))) as { default?: unknown };
		assert.equal(typeof module.default, "function");
	});

	test("every content skill ships, and nothing else does", () => {
		const shipped = shippedSkills(manifest.pi?.skills ?? []);
		assert.deepEqual(shipped, skillFolders());
	});

	test("the version line is package.json line 3", () => {
		// The release ritual (§AGENTS.md) reads the version from line 3.
		const lines = read("package.json").split("\n");
		assert.match(lines[2], /"version": "\d+\.\d+\.\d+"/);
		assert.equal(manifest.version, JSON.parse(lines.join("\n")).version);
	});
});

describe("pi package: the reviewer agent", () => {
	const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), "utf8");

	test("the reviewer prompt is the shared profession", () => {
		const profession = read("content/professions/reviewer.md");
		assert.match(profession, /^# Reviewer\n/);
		assert.match(profession, /is opinion from someone with/);
		assert.match(profession, /## Output Format/);
	});

	test("the Pi extension reads that file at run time", () => {
		assert.equal(reviewerBody(), read("content/professions/reviewer.md").trim());
	});

	test("no adapter keeps its own copy of the reviewer rules", () => {
		assert.equal(fs.existsSync(path.join(repoRoot, "platforms", "pi", "agents", "reviewer.md")), false);
		assert.equal(fs.existsSync(path.join(repoRoot, "platforms", "kiro", "agents", "reviewer-prompt.md")), false);
		const wrapper = read("platforms/claude/agents/reviewer.md");
		assert.match(wrapper, /\$\{CLAUDE_PLUGIN_ROOT\}\/content\/professions\/reviewer\.md/);
		assert.equal(wrapper.includes("Build your own risk list"), false, "the wrapper restates no rule");
	});
});

describe("pi package: one parser, two platforms", () => {
	test("the neutral notes, review, compaction, and retro modules live in shared only", () => {
		const shared = [
			"platforms/shared/notes/notes-paths.ts",
			"platforms/shared/notes/notes.ts",
			"platforms/shared/notes/session-log.ts",
			"platforms/shared/notes/session-log-net.ts",
			"platforms/shared/compaction/manifest.ts",
			"platforms/shared/review/review.ts",
			"platforms/shared/review/brief.ts",
			"platforms/shared/retro/retro.ts",
			"platforms/shared/context/context.ts",
		];
		for (const file of shared) assert.ok(fs.existsSync(path.join(repoRoot, file)), `${file} is missing`);
		for (const name of ["notes-paths.ts", "notes.ts", "session-log.ts", "session-log-net.ts", "manifest.ts", "review.ts", "brief.ts", "retro.ts"]) {
			assert.equal(fs.existsSync(path.join(repoRoot, "platforms", "pi", "scripts", name)), false, `pi/scripts/${name} is a duplicate`);
		}
		// The Pi context file stays as a thin adapter over the shared builder: it
		// adds only the Pi platform note.
		assert.match(read("platforms/pi/scripts/context.ts"), /shared\/context\/context\.ts/);
	});

	test("the pi extension imports the shared notes, review, compaction, and retro modules", () => {
		const source = read("platforms/pi/extensions/index.ts");
		for (const part of ["shared/notes/session-log.ts", "shared/notes/notes.ts", "shared/compaction/manifest.ts", "shared/review/review.ts", "shared/retro/retro.ts"]) {
			assert.ok(source.includes(part), `the extension does not import ${part}`);
		}
	});

	test("the shell parser lives in platforms/shared and only there", () => {
		for (const file of ["shell-parse.ts", "shell-grammar.ts", "gates.ts", "scan.ts"]) {
			assert.ok(fs.existsSync(path.join(repoRoot, "platforms", "shared", "shell", file)), `shared/${file} is missing`);
			assert.equal(fs.existsSync(path.join(repoRoot, "platforms", "claude", "scripts", file)), false, `claude/scripts/${file} is a duplicate`);
		}
	});

	test("both adapters import the shared gates", () => {
		for (const file of ["platforms/claude/scripts/doctrine.ts", "platforms/pi/scripts/policy.ts"]) {
			assert.match(read(file), /shared\/shell\/gates\.ts/, file);
		}
	});

	test("the pi policy has no private copy of the gate constants", () => {
		const source = read("platforms/pi/scripts/policy.ts");
		for (const leaked of ["GIT_PLAIN_OPTIONS", "SAFE_HEREDOC_HEADER", "GATED_WORD", "MAX_UNWRAP_DEPTH"]) {
			assert.equal(source.includes(leaked), false, `policy.ts redefines ${leaked}`);
		}
	});

	test("the session id comes from the session manager, never the environment", () => {
		// PI_SESSION_ID is inherited by every child process: a reviewer or a
		// second pi started from a session would file its session log under the
		// parent's id, at the parent's path.
		const wiring = read("platforms/pi/extensions/index.ts");
		assert.equal(wiring.includes("PI_SESSION_ID"), false);
		assert.match(wiring, /sessionManager\.getSessionId\(\)/);
	});

	test("the type shim stays in step with the events the wiring uses", () => {
		const shim = read("platforms/pi/types/pi-api.d.ts");
		const wiring = read("platforms/pi/extensions/index.ts");
		const used = [...wiring.matchAll(/pi\.on\("([a-z_]+)"/g)].map((match) => match[1]);
		assert.ok(used.length > 0);
		for (const event of new Set(used)) {
			assert.ok(shim.includes(`on(event: "${event}"`), `the shim does not declare ${event}`);
		}
	});
});
