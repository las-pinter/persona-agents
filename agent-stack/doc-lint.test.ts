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
 * T7 retired the two specialist implementers, so each theme has 8.
 */
const EXPECTED_PROFESSIONS_PER_THEME = 8;

/**
 * Agents whose pi `alwaysLoad` must equal the profession Startup skill list.
 *
 * Exact list parity applies only to a list-style Startup. The orchestrator's
 * Startup is one sentence of bold skill names, so its alwaysLoad and Startup
 * list must match one-for-one. The overseer's Startup is a numbered procedure,
 * not a skill list (its one bold name, `**herdr**`, is resolved by condition
 * 1), so exact parity is meaningless there. Its tailored rule below instead
 * requires every alwaysLoad entry to be a skill the frontmatter declares.
 */
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
const STUDY_CAP_LINES = 500;
const SIDE_DOC_CAP_LINES = 300;

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
	return COMMON_SKILL_CONTRACT.roots.filter((root) => fs.existsSync(root));
}

/**
 * The `common/skill-resolution` skill owns the installed-common-skill candidate
 * list and the four common root paths. Derive both here so a new candidate or
 * root added only to the skill cannot silently make this lint red on a healthy
 * machine. The candidate parse is scoped to the table after the candidate
 * marker, so an unrelated table cannot inject names. A parse failure throws
 * loud: an empty table or root list is a bug.
 */
const SKILL_RESOLUTION_FILE = path.join(skillsRoot, "common", "skill-resolution", "SKILL.md");

/** The line that introduces the candidate table in the skill. */
const CANDIDATE_TABLE_MARKER = "The candidates come from the domain:";

interface CommonSkillContract {
	candidates: ReadonlySet<string>;
	roots: string[];
}

function parseCommonSkillContract(): CommonSkillContract {
	const text = readText(SKILL_RESOLUTION_FILE);
	const candidates = new Set<string>();

	// Scope the parse to the block after the marker and before the next `##`.
	// A table elsewhere in the skill must not add optional names.
	const markerIndex = text.indexOf(CANDIDATE_TABLE_MARKER);
	if (markerIndex === -1) {
		throw new Error(`${SKILL_RESOLUTION_FILE}: candidate table marker not found`);
	}
	const afterMarker = text.slice(markerIndex + CANDIDATE_TABLE_MARKER.length);
	const nextHeading = afterMarker.search(/^##\s/m);
	const tableBlock = nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);

	// Candidate table rows: `| rust | primary | secondary, secondary |`.
	const rowRe = /^\|\s*([a-z0-9-]+)\s*\|([^|]*)\|([^|]*)\|\s*$/gm;
	let match: RegExpExecArray | null;
	while ((match = rowRe.exec(tableBlock)) !== null) {
		if (/^-+$/.test(match[1])) continue; // header separator row
		for (const cell of [match[2], match[3]]) {
			for (const raw of cell.split(",")) {
				const name = raw.trim();
				if (/^[a-z0-9-]+$/.test(name)) candidates.add(name);
			}
		}
	}

	// Root bullets: ``- `$HOME/.agents/skills` ``.
	const roots: string[] = [];
	const rootRe = /^-\s+`\$HOME\/([^`]+)`\s*$/gm;
	while ((match = rootRe.exec(text)) !== null) roots.push(path.join(HOME, match[1]));

	if (candidates.size === 0) {
		throw new Error(`${SKILL_RESOLUTION_FILE}: candidate table parsed to an empty set`);
	}
	if (roots.length === 0) {
		throw new Error(`${SKILL_RESOLUTION_FILE}: no common skill roots parsed`);
	}
	return { candidates, roots };
}

const COMMON_SKILL_CONTRACT = parseCommonSkillContract();

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
 * Installed common skills that live outside the repo. Derived from the
 * `common/skill-resolution` candidate table. A bare name in a profession that
 * is neither a repo skill nor a candidate here is dead and fails.
 */
const OPTIONAL_COMMON_SKILLS: ReadonlySet<string> = COMMON_SKILL_CONTRACT.candidates;

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

/** Bold `**name**` tokens in the section under a `## <heading>` line. */
function boldNamesInSection(text: string, heading: RegExp): string[] {
	const section = sectionAfterHeading(text, heading);
	const names = new Set<string>();
	const re = /\*\*([a-z0-9-]+)\*\*/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(section)) !== null) names.add(match[1]);
	return [...names];
}

/** Bold skill names in a profession's `## Skills` section. */
function skillListNames(text: string): string[] {
	return boldNamesInSection(text, /^##\s+Skills\s*$/m);
}

/** Bold skill names in a profession's `## Startup` section (for example `**herdr**`). */
function startupSkillNames(text: string): string[] {
	return boldNamesInSection(text, /^##\s+Startup\s*$/m);
}

interface TemplateSkillParse {
	refs: string[];
	/** Keys present in the frontmatter whose value is not a parseable inline array. */
	unparsable: string[];
}

/**
 * Top-level `skills` and `alwaysLoad` arrays in a pi/opencode YAML template.
 * A present key whose value is not an inline array (for example a block-style
 * YAML list) is reported in `unparsable` and fails the check instead of
 * silently yielding an empty list.
 */
function templateSkillRefs(text: string): TemplateSkillParse {
	const refs = new Set<string>();
	const unparsable: string[] = [];
	for (const key of ["skills", "alwaysLoad"]) {
		if (!new RegExp(`^${key}:`, "m").test(text)) continue;
		const parsed = parseInlineArray(text, key);
		if (parsed === undefined) {
			unparsable.push(key);
			continue;
		}
		for (const ref of parsed) refs.add(ref);
	}
	return { refs: [...refs], unparsable };
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
			// in the `## Skills` list and in a `## Startup` procedure may also be
			// installed common skills.
			const refs = [
				...explicitSkillPaths(text).map((ref) => ({ ref, repoOnly: true })),
				...skillListNames(text).map((ref) => ({ ref, repoOnly: false })),
				...startupSkillNames(text).map((ref) => ({ ref, repoOnly: false })),
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
			const { refs, unparsable } = templateSkillRefs(readText(path.join(piFrontmattersDir, file)));
			const failures = [
				...unparsable.map((key) => `${key}: present but not an inline array (use [\"...\"] )`),
				...refs
					.map((ref) => ({ ref, result: resolveSkillRef(ref) }))
					.filter((entry) => !entry.result.ok)
					.map((entry) => `${entry.ref}: ${entry.result.detail}`),
			];
			assert.deepEqual(failures, [], `${file} names dead skills`);
		});
	}

	// OpenCode templates carry no top-level `skills:`/`alwaysLoad:` path field;
	// their `skill:` entries are runtime permission names, not repo skill paths.
	for (const file of fs.readdirSync(opencodeFrontmattersDir).filter((name) => name.endsWith(".yaml")).sort()) {
		test(`opencode frontmatter ${file}`, () => {
			const { refs, unparsable } = templateSkillRefs(readText(path.join(opencodeFrontmattersDir, file)));
			const failures = [
				...unparsable.map((key) => `${key}: present but not an inline array (use [\"...\"] )`),
				...refs
					.map((ref) => ({ ref, result: resolveSkillRef(ref) }))
					.filter((entry) => !entry.result.ok)
					.map((entry) => `${entry.ref}: ${entry.result.detail}`),
			];
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

// --- condition 1: strict frontmatter list parse -------------------------------

describe("condition 1: frontmatter skill list parse", () => {
	test("a present but block-style list is reported as unparsable", () => {
		const block = 'skills:\n  - "a/*"\nalwaysLoad: ["common/simplified-technical-english"]\n';
		const parsed = templateSkillRefs(block);
		assert.deepEqual(parsed.unparsable, ["skills"], "a block-style skills list must not pass silently");
		assert.deepEqual(parsed.refs, ["common/simplified-technical-english"]);
	});

	test("inline arrays parse and report no error", () => {
		const inline = 'skills: ["a/*", "common/ste"]\nalwaysLoad: ["common/ste"]\n';
		const parsed = templateSkillRefs(inline);
		assert.deepEqual(parsed.unparsable, []);
		assert.deepEqual(parsed.refs, ["a/*", "common/ste"]);
	});
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

	// T28 tailored rule: the overseer Startup is a numbered procedure, so exact
	// list parity does not apply. Every alwaysLoad entry must still be a skill the
	// frontmatter declares.
	test("pi overseer alwaysLoad is a subset of its declared skills", () => {
		const frontmatterFile = path.join(piFrontmattersDir, "overseer.yaml");
		assert.ok(fs.existsSync(frontmatterFile), "missing pi frontmatter for overseer");
		const text = readText(frontmatterFile);
		const skills = parseInlineArray(text, "skills") ?? [];
		const alwaysLoad = parseInlineArray(text, "alwaysLoad") ?? [];
		const skillNames = new Set(skills.map((ref) => ref.split("/").pop() ?? ref));
		const undeclared = alwaysLoad
			.map((ref) => ref.split("/").pop() ?? ref)
			.filter((name) => !skillNames.has(name))
			.sort();
		assert.deepEqual(undeclared, [], "overseer alwaysLoad names a skill it does not declare in skills");
	});
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

/**
 * True when the path sits under an archived `legacy_studies/` folder.
 */
function isLegacyStudy(relativeFile: string): boolean {
	return relativeFile.split(path.sep).includes("legacy_studies");
}

/**
 * The project-notes caps that apply to a file, or null when no cap maps.
 *
 * A study holds one `study.md` with a 500-line cap and optional side documents
 * with a 300-line cap. A pre-overhaul `quick-study.md` or `full-study.md` that
 * still sits outside `legacy_studies/` maps to no cap. Files under
 * `legacy_studies/` are skipped as archived.
 */
function capFor(relativeFile: string): LineCap | null {
	const parts = relativeFile.split(path.sep);
	if (isLegacyStudy(relativeFile)) return null;
	const base = parts[parts.length - 1];
	if (base === "summary.md") return { cap: SUMMARY_CAP_LINES + SUMMARY_CAP_SLACK, label: "summary (~30)" };
	if (base === "study.md") return { cap: STUDY_CAP_LINES, label: "study" };
	if (base === "quick-study.md" || base === "full-study.md") return null;
	if (
		parts.includes("studies") &&
		parts.length >= 3 &&
		base.endsWith(".md") &&
		base !== "status.md"
	) {
		return { cap: SIDE_DOC_CAP_LINES, label: "study side document" };
	}
	if (parts.includes("features") || parts.includes("bugs") || parts.includes("tech")) {
		return { cap: FEATURE_BUG_TECH_CAP_LINES, label: "feature/bug/tech note" };
	}
	return null;
}

describe("condition 6: study and note line caps", () => {
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
				// Archived studies are exempt and are not reported as unmapped.
				if (!isLegacyStudy(relative)) unmapped.push(relative);
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

	test("capFor maps the study, side-doc, status, and legacy paths", () => {
		const capCases: { file: string; cap: number | null }[] = [
			{ file: "studies/2026-01-01-x/study.md", cap: STUDY_CAP_LINES },
			{ file: "studies/2026-01-01-x/notes.md", cap: SIDE_DOC_CAP_LINES },
			{ file: "studies/2026-01-01-x/reverse_engineering/finding.md", cap: SIDE_DOC_CAP_LINES },
			{ file: "studies/2026-01-01-x/status.md", cap: null },
			{ file: "studies/2026-01-01-x/quick-study.md", cap: null },
			{ file: "studies/2026-01-01-x/full-study.md", cap: null },
		];
		for (const { file, cap } of capCases) {
			const relative = file.split("/").join(path.sep);
			assert.equal(capFor(relative)?.cap ?? null, cap, `${file} cap`);
		}
		for (const file of [
			"studies/legacy_studies/2026-01-01-x/study.md",
			"studies/legacy_studies/2026-01-01-x/notes.md",
		]) {
			const relative = file.split("/").join(path.sep);
			assert.ok(isLegacyStudy(relative), `${file} is archived`);
			assert.equal(capFor(relative), null, `${file} is skipped`);
		}
	});
});
