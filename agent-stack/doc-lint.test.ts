/**
 * Structural doc-lint for the persona-agents contracts (study finding F17).
 *
 * Runs under plain Node (type stripping) with no extra dependencies:
 *   node --experimental-strip-types --test agent-stack/doc-lint.test.ts
 *
 * It asserts the six conditions of the doc-lint contract:
 *   1. every skill path named by a profession or a template resolves;
 *   2. each skills/ * /SKILL.md `name:` equals its folder name;
 *   3. every file path a SKILL.md explicitly points to exists;
 *   4. agents.json has the expected profession count per theme;
 *   5. pi `alwaysLoad` matches the profession Startup skill list;
 *   6. study and note files stay under their documented line caps.
 *
 * Condition 1 is hermetic: repo references must resolve under the repo tree,
 * and a missing optional common skill is skipped, not failed. Condition 6
 * resolves the home from the environment and skips cleanly when the notes tree
 * is absent.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const professionsDir = path.join(repoRoot, "professions");
const piFrontmattersDir = path.join(repoRoot, "agent-templates", "pi", "frontmatters");
const opencodeFrontmattersDir = path.join(repoRoot, "agent-templates", "opencode", "frontmatters");
const kiroTemplatesDir = path.join(repoRoot, "agent-templates", "kiro");

/**
 * The one named constant for the expected profession count per theme.
 * T7 retires the two specialist implementers and lowers this to 8.
 */
const EXPECTED_PROFESSIONS_PER_THEME = 10;

/** Agents whose pi `alwaysLoad` must equal the profession Startup skill list. */
const STARTUP_PARITY_AGENTS = ["orchestrator"];

/**
 * Line caps documented in `skills/common/project-notes/SKILL.md`.
 *
 * The summary cap is written as `~30`; `SUMMARY_CAP_SLACK` honors the tilde.
 * The journal cap lives in the journal-management skill, not project-notes, so
 * it is reported but not enforced here (see condition 6).
 */
const SUMMARY_CAP_LINES = 30;
const SUMMARY_CAP_SLACK = 3;
const FEATURE_BUG_TECH_CAP_LINES = 300;
const QUICK_STUDY_CAP_LINES = 150;
const FULL_STUDY_CAP_LINES = 500;

const HOME = process.env.HOME ?? os.homedir();
const AGENT_NOTES_ROOT = path.join(HOME, "agent-notes");
const REPO_NAME = path.basename(repoRoot);

// --- small filesystem and text helpers --------------------------------------

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function listFilesRecursive(dir: string, include: (name: string) => boolean): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && include(entry.name)) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

function relativePosix(from: string, to: string): string {
	return path.relative(from, to).split(path.sep).join("/");
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

/** Read an inline YAML array `key: ["a", "b"]`. Only the documented forms. */
function parseInlineArray(text: string, key: string): string[] | undefined {
	const match = text.match(new RegExp(`^${key}:\\s*(\\[.*?\\])\\s*$`, "m"));
	if (!match) return undefined;
	try {
		const parsed: unknown = JSON.parse(match[1]);
		if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		// Fall through to a permissive split for unquoted or single-quoted lists.
	}
	return match[1]
		.slice(1, -1)
		.split(",")
		.map((part) => part.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

/** Text between a heading matching `heading` and the next `## ` heading. */
function sectionAfterHeading(text: string, heading: RegExp): string {
	const match = heading.exec(text);
	if (!match || match.index === undefined) return "";
	const rest = text.slice(match.index + match[0].length);
	const next = rest.search(/^##\s/m);
	return next === -1 ? rest : rest.slice(0, next);
}

// --- skill reference resolution ---------------------------------------------

function repoSkillDirs(): string[] {
	return listFilesRecursive(skillsRoot, (name) => name === "SKILL.md").map((file) =>
		relativePosix(skillsRoot, path.dirname(file)),
	);
}

function commonSkillRoots(): string[] {
	return [path.join(HOME, ".agents", "skills"), path.join(HOME, ".pi", "agent", "skills")].filter(
		(root) => fs.existsSync(root),
	);
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${escaped}$`);
}

interface ResolvedSkill {
	ok: boolean;
	detail: string;
	/** The repo-relative skill dirs when resolved, or the common path otherwise. */
	resolved: string[];
}

/**
 * Installed common skills that live outside the repo. `common/skill-resolution`
 * owns this candidate list. A bare name in a profession that is neither a repo
 * skill nor a name here is a dead repo reference and fails.
 */
const OPTIONAL_COMMON_SKILLS: ReadonlySet<string> = new Set([
	"rust-best-practices",
	"rust-async-patterns",
	"python-design-patterns",
	"python-testing-patterns",
	"vercel-react-best-practices",
	"web-design-guidelines",
	"frontend-design",
	"shadcn",
]);

/** Resolve a name to a repo skill dir. A grouped name never falls back to a basename. */
function findRepoSkill(name: string): string | undefined {
	if (fs.existsSync(path.join(skillsRoot, name, "SKILL.md"))) return name;
	if (name.includes("/")) return undefined;
	return repoSkillDirs().find((dir) => path.basename(dir) === name);
}

/** Resolve a name under the common roots. Returns the SKILL.md path or undefined. */
function findCommonSkill(name: string): string | undefined {
	for (const root of commonSkillRoots()) {
		const file = path.join(root, name, "SKILL.md");
		if (fs.existsSync(file)) return file;
		const hit = listFilesRecursive(root, (entry) => entry === "SKILL.md")
			.map((found) => path.dirname(found))
			.find((dir) => path.basename(dir) === name);
		if (hit) return path.join(hit, "SKILL.md");
	}
	return undefined;
}

/**
 * Resolve a skill reference to a real skill.
 *
 * Glob refs (`implementer/*`) and grouped refs (`common/skill-resolution`) must
 * resolve under the repo `skills/` tree, as must explicit `skills/...` paths
 * (`repoOnly`). A bare name is a repo skill when one exists; otherwise it is an
 * optional common skill. A missing common skill is skipped, not failed, so the
 * check stays hermetic. A bare name outside both sets is a dead repo reference.
 */
function resolveSkillRef(ref: string, options: { repoOnly?: boolean } = {}): ResolvedSkill {
	const normalized = ref.replace(/\/+$/, "").replace(/\/SKILL\.md$/, "");

	if (normalized.includes("*")) {
		const matcher = globToRegExp(normalized);
		const matches = repoSkillDirs().filter((dir) => matcher.test(dir));
		if (matches.length > 0) {
			return { ok: true, detail: `glob ${ref} -> ${matches.join(", ")}`, resolved: matches };
		}
		return { ok: false, detail: `glob ${ref} matched no skill under skills/`, resolved: [] };
	}

	const repoHit = findRepoSkill(normalized);
	if (repoHit) {
		return { ok: true, detail: path.join(skillsRoot, repoHit, "SKILL.md"), resolved: [repoHit] };
	}

	// A grouped ref, an explicit `skills/...` path, or a frontmatter entry must
	// live in the repo. Do not fall back to the common roots for these.
	if (options.repoOnly || normalized.includes("/")) {
		return { ok: false, detail: `expected ${path.join(skillsRoot, normalized, "SKILL.md")}`, resolved: [] };
	}

	if (OPTIONAL_COMMON_SKILLS.has(normalized)) {
		const commonHit = findCommonSkill(normalized);
		if (commonHit) return { ok: true, detail: commonHit, resolved: [commonHit] };
		return { ok: true, detail: `optional common skill ${normalized} is not installed (skipped)`, resolved: [] };
	}

	return { ok: false, detail: `expected ${path.join(skillsRoot, normalized, "SKILL.md")}`, resolved: [] };
}

// --- condition 1: every named skill path resolves ----------------------------

/** Explicit `skills/<group>/<name>` tokens anywhere in a profession. */
function explicitSkillPaths(text: string): string[] {
	const refs = new Set<string>();
	const re = /\bskills\/([a-z0-9-]+)\/([a-z0-9-]+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) refs.add(`${match[1]}/${match[2]}`);
	return [...refs];
}

/** Bold skill names in a profession's `## Skills` section. */
function skillListNames(text: string): string[] {
	const section = sectionAfterHeading(text, /^##\s+Skills\s*$/m);
	const names = new Set<string>();
	const re = /\*\*([a-z0-9-]+)\*\*/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(section)) !== null) names.add(match[1]);
	return [...names];
}

/** Top-level `skills` and `alwaysLoad` arrays in a pi/opencode YAML template. */
function templateSkillRefs(text: string): string[] {
	const refs = new Set<string>();
	for (const key of ["skills", "alwaysLoad"]) {
		for (const ref of parseInlineArray(text, key) ?? []) refs.add(ref);
	}
	return [...refs];
}

/** `skill://.../skills/<ref>` targets in a kiro template's `resources` list. */
function kiroSkillRefs(profession: string, resource: unknown): string[] {
	if (typeof resource !== "string" || !resource.startsWith("skill://")) return [];
	const marker = resource.match(/skills\/(.+?)\/?$/);
	if (!marker) return [];
	return [marker[1].replace(/\{\{PROFESSION\}\}/g, profession)];
}

describe("condition 1: named skill paths resolve", () => {
	for (const file of fs.readdirSync(professionsDir).filter((name) => name.endsWith(".md")).sort()) {
		test(`profession ${file}`, () => {
			const text = readText(path.join(professionsDir, file));
			// Explicit `skills/group/name` paths must live in this repo. Bold names
			// in the `## Skills` list may also be installed common skills.
			const refs = [
				...explicitSkillPaths(text).map((ref) => ({ ref, repoOnly: true })),
				...skillListNames(text).map((ref) => ({ ref, repoOnly: false })),
			];
			const failures = refs
				.map(({ ref, repoOnly }) => ({ ref, result: resolveSkillRef(ref, { repoOnly }) }))
				.filter((entry) => !entry.result.ok)
				.map((entry) => `${entry.ref}: ${entry.result.detail}`);
			assert.deepEqual(failures, [], `${file} names dead skills`);
		});
	}

	for (const file of fs.readdirSync(piFrontmattersDir).filter((name) => name.endsWith(".yaml")).sort()) {
		test(`pi frontmatter ${file}`, () => {
			const refs = templateSkillRefs(readText(path.join(piFrontmattersDir, file)));
			const failures = refs
				.map((ref) => ({ ref, result: resolveSkillRef(ref) }))
				.filter((entry) => !entry.result.ok)
				.map((entry) => `${entry.ref}: ${entry.result.detail}`);
			assert.deepEqual(failures, [], `${file} names dead skills`);
		});
	}

	// OpenCode templates carry no top-level `skills:`/`alwaysLoad:` path field;
	// their `skill:` entries are runtime permission names, not repo skill paths.
	for (const file of fs.readdirSync(opencodeFrontmattersDir).filter((name) => name.endsWith(".yaml")).sort()) {
		test(`opencode frontmatter ${file}`, () => {
			const refs = templateSkillRefs(readText(path.join(opencodeFrontmattersDir, file)));
			const failures = refs
				.map((ref) => ({ ref, result: resolveSkillRef(ref) }))
				.filter((entry) => !entry.result.ok)
				.map((entry) => `${entry.ref}: ${entry.result.detail}`);
			assert.deepEqual(failures, [], `${file} names dead skills`);
		});
	}

	for (const file of fs.readdirSync(kiroTemplatesDir).filter((name) => name.endsWith(".json")).sort()) {
		test(`kiro template ${file}`, () => {
			const parsed: unknown = JSON.parse(readText(path.join(kiroTemplatesDir, file)));
			const profession = path.basename(file, ".json");
			const resources =
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>).resources
					: undefined;
			const refs = Array.isArray(resources)
				? resources.flatMap((resource) => kiroSkillRefs(profession, resource))
				: [];
			const failures = refs
				.map((ref) => ({ ref, result: resolveSkillRef(ref) }))
				.filter((entry) => !entry.result.ok)
				.map((entry) => `${entry.ref}: ${entry.result.detail}`);
			assert.deepEqual(failures, [], `${file} names dead skills`);
		});
	}
});

// --- condition 2: SKILL.md name equals its folder -----------------------------

describe("condition 2: SKILL.md name equals its folder name", () => {
	for (const file of listFilesRecursive(skillsRoot, (name) => name === "SKILL.md")) {
		const rel = relativePosix(repoRoot, file);
		test(`name matches folder in ${rel}`, () => {
			const folder = path.basename(path.dirname(file));
			const name = parseScalar(readText(file), "name");
			assert.equal(name, folder, `${rel} has name ${name ?? "<none>"}, expected ${folder}`);
		});
	}
});

// --- condition 3: referenced skill files exist --------------------------------

/** File paths a SKILL.md explicitly points to (markdown links, references/). */
function referencedPaths(text: string): string[] {
	const refs = new Set<string>();
	const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = linkRe.exec(text)) !== null) {
		const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
		if (!target || target.includes("://") || target.startsWith("mailto:")) continue;
		if (target.startsWith("/")) continue;
		refs.add(target);
	}
	const backtickRe = /`((?:\.\/)?(?:references|scripts)\/[^`]+)`/g;
	while ((match = backtickRe.exec(text)) !== null) refs.add(match[1]);
	return [...refs];
}

describe("condition 3: referenced skill files exist", () => {
	for (const file of listFilesRecursive(skillsRoot, (name) => name === "SKILL.md")) {
		const dir = path.dirname(file);
		const refs = referencedPaths(readText(file));
		for (const ref of refs) {
			const rel = relativePosix(repoRoot, file);
			test(`${rel} points to ${ref}`, () => {
				// A glob tail only requires the directory it points into.
				const target = ref.includes("*") ? path.dirname(ref) : ref;
				const resolved = path.resolve(dir, target);
				assert.ok(fs.existsSync(resolved), `${rel} references missing path ${ref}`);
			});
		}
	}
});

// --- condition 4: expected profession count per theme -------------------------

describe("condition 4: agents.json profession count", () => {
	test(`every theme has ${EXPECTED_PROFESSIONS_PER_THEME} professions`, () => {
		const registry: unknown = JSON.parse(readText(path.join(repoRoot, "agents.json")));
		assert.ok(registry && typeof registry === "object", "agents.json must be an object");
		const bad: string[] = [];
		for (const [theme, professions] of Object.entries(registry as Record<string, unknown>)) {
			if (!professions || typeof professions !== "object") {
				bad.push(`${theme}: not an object`);
				continue;
			}
			const count = Object.keys(professions as Record<string, unknown>).length;
			if (count !== EXPECTED_PROFESSIONS_PER_THEME) {
				bad.push(`${theme}: ${count} != ${EXPECTED_PROFESSIONS_PER_THEME}`);
			}
		}
		assert.deepEqual(bad, [], "agents.json profession count drifted");
	});
});

// --- condition 5: alwaysLoad matches the profession Startup list --------------

describe("condition 5: pi alwaysLoad matches the profession Startup list", () => {
	for (const agent of STARTUP_PARITY_AGENTS) {
		test(`pi ${agent} alwaysLoad equals its Startup skills`, () => {
			const professionFile = path.join(professionsDir, `${agent}.md`);
			assert.ok(fs.existsSync(professionFile), `missing professions/${agent}.md`);
			const startup = sectionAfterHeading(readText(professionFile), /^##\s+Startup\s*$/m);
			const startupNames = new Set<string>();
			const nameRe = /\*\*([a-z0-9-]+)\*\*/g;
			let match: RegExpExecArray | null;
			while ((match = nameRe.exec(startup)) !== null) startupNames.add(match[1]);
			assert.ok(startupNames.size > 0, `no Startup skills found in professions/${agent}.md`);

			const frontmatterFile = path.join(piFrontmattersDir, `${agent}.yaml`);
			assert.ok(fs.existsSync(frontmatterFile), `missing pi frontmatter for ${agent}`);
			const alwaysLoad = parseInlineArray(readText(frontmatterFile), "alwaysLoad") ?? [];
			const alwaysNames = new Set(alwaysLoad.map((ref) => ref.split("/").pop() ?? ref));

			const onlyStartup = [...startupNames].filter((name) => !alwaysNames.has(name)).sort();
			const onlyAlways = [...alwaysNames].filter((name) => !startupNames.has(name)).sort();
			assert.deepEqual(
				{ onlyStartup, onlyAlways },
				{ onlyStartup: [], onlyAlways: [] },
				`pi ${agent} alwaysLoad differs from the Startup list`,
			);
		});
	}
});

// --- condition 6: study and note line caps ------------------------------------

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
	return trimmed.split("\n").length;
}

interface LineCap {
	cap: number;
	label: string;
}

/** The project-notes caps that apply to a file, or null when no cap maps. */
function capFor(relativeFile: string): LineCap | null {
	const parts = relativeFile.split(path.sep);
	const base = parts[parts.length - 1];
	if (base === "summary.md") return { cap: SUMMARY_CAP_LINES + SUMMARY_CAP_SLACK, label: "summary (~30)" };
	if (base === "quick-study.md") return { cap: QUICK_STUDY_CAP_LINES, label: "quick-study" };
	if (base === "full-study.md") return { cap: FULL_STUDY_CAP_LINES, label: "full-study" };
	if (parts.includes("features") || parts.includes("bugs") || parts.includes("tech")) {
		return { cap: FEATURE_BUG_TECH_CAP_LINES, label: "feature/bug/tech note" };
	}
	return null;
}

describe("condition 6: project note line caps", () => {
	const projectNotes = path.join(AGENT_NOTES_ROOT, "project-notes", REPO_NAME);

	test("this repo's project notes stay under their caps", (t) => {
		if (!fs.existsSync(projectNotes)) {
			// Hermetic: a machine without the notes tree skips the check.
			t.skip(`no agent-notes tree for ${REPO_NAME} at ${projectNotes}`);
			return;
		}
		const violations: string[] = [];
		const unmapped: string[] = [];
		for (const file of listFilesRecursive(projectNotes, (name) => name.endsWith(".md"))) {
			const relative = path.relative(projectNotes, file);
			const cap = capFor(relative);
			if (!cap) {
				unmapped.push(relative);
				continue;
			}
			const lines = lineCount(readText(file));
			if (lines > cap.cap) violations.push(`${relative}: ${lines} > ${cap.cap} (${cap.label})`);
		}
		if (unmapped.length > 0) {
			// Flag files whose cap is not documented in common/project-notes.
			console.warn(`doc-lint: no project-notes line cap for ${unmapped.length} file(s): ${unmapped.join(", ")}`);
		}
		assert.deepEqual(violations, [], "note line caps exceeded");
	});
});
