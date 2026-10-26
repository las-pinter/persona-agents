/**
 * Structural doc-lint for the persona-agents contracts.
 *
 * Runs under plain Node (type stripping) with no extra dependencies:
 *   node --experimental-strip-types --test tests/doc-lint.test.ts
 *
 * It asserts the seven conditions of the doc-lint contract:
 *   1. every skill path named by a profession or a template resolves;
 *   2. each skills/ * /SKILL.md `name:` equals its folder name;
 *   3. every file path a SKILL.md explicitly points to exists;
 *   4. every agents.json theme has the profession set of content/professions;
 *   5. pi `alwaysLoad` matches the profession Startup skill list;
 *   6. no doctrine file runs a home discovery order or marks the home path in a
 *      command block;
 *   7. exactly one skill file owns the full home discovery rule.
 *
 * Condition 1 is hermetic: repo references must resolve under the repo tree,
 * and a missing optional common skill is skipped, not failed.
 *
 * The file is 816 lines, inside the 501-1000 tier: it holds one lint contract,
 * and every condition shares the helper block at the top.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "content", "skills");
const professionsDir = path.join(repoRoot, "content", "professions");
const HOME = process.env.HOME ?? os.homedir();
const piFrontmattersDir = path.join(repoRoot, "platforms", "pi", "frontmatters");
const opencodeFrontmattersDir = path.join(repoRoot, "platforms", "opencode", "frontmatters");
const kiroTemplatesDir = path.join(repoRoot, "platforms", "kiro", "templates");
const commandsDir = path.join(repoRoot, "content", "commands");
const claudeAgentsDir = path.join(repoRoot, "platforms", "claude", "agents");

/**
 * Agents whose pi `alwaysLoad` must equal the profession Startup skill list.
 *
 * Exact list parity applies only to a list-style Startup. The orchestrator's
 * Startup is one sentence of bold skill names, so its alwaysLoad and Startup
 * list must match one-for-one.
 */
const STARTUP_PARITY_AGENTS = ["orchestrator"];

/**
 * The character that opens the home expansion marker, built from a code so this
 * lint file never carries the literal token it forbids.
 */
const HOME_MARKER_CHARACTER = String.fromCharCode(36);

/**
 * The installed common root prefix: the marker form or the angle-bracket token.
 * The marker sits in a character class, because a bare marker is an anchor.
 */
const HOME_ROOT_PREFIX = "(?:[" + HOME_MARKER_CHARACTER + "]HOME|<USER_HOME>)";

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

	// Root bullets: a marker home form or the angle-bracket token.
	const roots: string[] = [];
	const rootRe = new RegExp("^-\\s+`" + HOME_ROOT_PREFIX + "\\/([^`]+)`\\s*$", "gm");
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

/** Bold skill names in a profession's `## Startup` section (for example `**task-routing**`). */
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

describe("condition 4: agents.json professions match content/professions", () => {
	test("every theme has exactly the profession set of the content folder", () => {
		const registry: unknown = JSON.parse(readText(path.join(repoRoot, "content", "agents.json")));
		assert.ok(registry && typeof registry === "object", "agents.json must be an object");
		const expected = fs
			.readdirSync(professionsDir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3))
			.sort();
		assert.ok(expected.length > 0, "content/professions must hold a profession file");
		assert.ok(Object.keys(registry as Record<string, unknown>).length > 0, "agents.json must hold at least one theme");
		const bad: string[] = [];
		for (const [theme, professions] of Object.entries(registry as Record<string, unknown>)) {
			if (!professions || typeof professions !== "object") {
				bad.push(`${theme}: not an object`);
				continue;
			}
			const names = Object.keys(professions as Record<string, unknown>).sort();
			if (JSON.stringify(names) !== JSON.stringify(expected)) {
				bad.push(`${theme}: ${names.join(",")} != ${expected.join(",")}`);
			}
		}
		assert.deepEqual(bad, [], "agents.json professions drifted from content/professions");
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

// --- condition 6: no shell command discovers the home path --------------------

/**
 * A home reference written as the marker, with optional braces or quotes around
 * the name.
 */
const HOME_MARKER_SOURCE = "[" + HOME_MARKER_CHARACTER + "]\\{?['\"]?HOME['\"]?\\}?";

/** The marker alone, with no command word in front of it. */
const HOME_MARKER_ONLY = new RegExp(HOME_MARKER_SOURCE, "i");

/**
 * A discovery order that names the marker: a command word that can print the
 * path, then the marker. The gap crosses a newline, so an order wrapped across
 * two lines still matches. It is lazy, so the nearest marker wins.
 *
 * Accepted trade: a doctrine line that forbids the order and quotes it in
 * backticks also matches, so such a line must be reworded, not exempted.
 */
const HOME_MARKER_ORDER = new RegExp(
	"\\b(?:echo|printenv|env|printf)\\b[\\s\\S]*?(?:" + HOME_MARKER_SOURCE + ")",
	"i",
);

/**
 * A bare `HOME` word after a printing command, bounded to one line and allowed
 * to cross a pipe, so a piped reader such as `printenv | grep HOME` matches.
 */
const HOME_BARE_ORDER = new RegExp("\\b(?:printenv|env)\\b[^;&\\n]*\\bHOME\\b", "i");

/** True when a text carries a shell order that prints the home path. */
function isHomeDiscoveryOrder(text: string): boolean {
	return HOME_MARKER_ORDER.test(text) || HOME_BARE_ORDER.test(text);
}

/**
 * 1-based lines that carry the marker inside a fenced command block, whatever
 * word comes before it. Doctrine code blocks are commands, so the marker has no
 * place in one.
 */
function markerInCommandBlockLines(text: string): number[] {
	const hits: number[] = [];
	let inBlock = false;
	text.split("\n").forEach((line, index) => {
		if (/^\s*```/.test(line)) {
			inBlock = !inBlock;
			return;
		}
		if (inBlock && line.includes(HOME_MARKER_CHARACTER)) hits.push(index + 1);
	});
	return hits;
}

/** One scanned doctrine folder and the file names it contributes. */
interface DiscoveryScanSet {
	label: string;
	dir: string;
	include: (name: string) => boolean;
}

/**
 * Every doctrine folder the home discovery rule covers. A missing folder is
 * reported by the folder test below instead of throwing: the recursive walk
 * guards its readdir and returns no file for it.
 */
const DISCOVERY_SCAN_SETS: DiscoveryScanSet[] = [
	{ label: "content/skills", dir: skillsRoot, include: (name) => name.endsWith(".md") },
	{ label: "content/professions", dir: professionsDir, include: (name) => name.endsWith(".md") },
	{ label: "content/commands", dir: commandsDir, include: (name) => name.endsWith(".md") },
	{ label: "platforms/pi/frontmatters", dir: piFrontmattersDir, include: (name) => name.endsWith(".yaml") },
	{
		label: "platforms/opencode/frontmatters",
		dir: opencodeFrontmattersDir,
		include: (name) => name.endsWith(".yaml"),
	},
	{ label: "platforms/kiro/templates", dir: kiroTemplatesDir, include: (name) => name.endsWith(".json") },
	{ label: "platforms/claude/agents", dir: claudeAgentsDir, include: (name) => name.endsWith(".md") },
];

/** Scanned doctrine folders that are absent from the tree. */
function missingDiscoveryScanFolders(): string[] {
	return DISCOVERY_SCAN_SETS.filter((set) => !fs.existsSync(set.dir)).map((set) => set.label);
}

/** Every doctrine file the home discovery rule covers. */
function homeDiscoveryFiles(): string[] {
	return DISCOVERY_SCAN_SETS.flatMap((set) => listFilesRecursive(set.dir, set.include));
}

/** The 1-based line of a character offset. */
function lineAtOffset(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

/**
 * 1-based lines that run a shell order to print the home path. The line scan
 * catches a same-line order. The whole-text scan catches an order wrapped
 * across two lines and reports both the command line and the marker line.
 */
function shellHomeDiscoveryLines(text: string): number[] {
	const hits = new Set<number>();
	text.split("\n").forEach((line, index) => {
		if (isHomeDiscoveryOrder(line)) hits.add(index + 1);
	});
	const wrapped = HOME_MARKER_ORDER.exec(text);
	if (wrapped) {
		hits.add(lineAtOffset(text, wrapped.index));
		const marker = HOME_MARKER_ONLY.exec(text.slice(wrapped.index));
		if (marker) hits.add(lineAtOffset(text, wrapped.index + marker.index));
	}
	return [...hits].sort((left, right) => left - right);
}

describe("condition 6: no shell command discovers the home path", () => {
	test("every scanned doctrine folder exists", () => {
		assert.deepEqual(
			missingDiscoveryScanFolders(),
			[],
			"check 6 (no shell home discovery order) scans a missing folder",
		);
	});
	test("no doctrine file runs a shell home discovery order", () => {
		const failures: string[] = [];
		for (const file of homeDiscoveryFiles()) {
			const rel = relativePosix(repoRoot, file);
			for (const line of shellHomeDiscoveryLines(readText(file))) failures.push(rel + ":" + line);
		}
		assert.deepEqual(
			failures,
			[],
			"check 6 (no shell home discovery order) found a discovery order at: " + failures.join(", "),
		);
	});
	test("no doctrine file carries the home marker inside a command block", () => {
		const failures: string[] = [];
		for (const file of homeDiscoveryFiles()) {
			const rel = relativePosix(repoRoot, file);
			for (const line of markerInCommandBlockLines(readText(file))) failures.push(rel + ":" + line);
		}
		assert.deepEqual(
			failures,
			[],
			"check 6 (no shell home discovery order) found the home marker in a command block at: " +
				failures.join(", "),
		);
	});
});

// --- condition 7: one owner of the home discovery rule ------------------------

/** The one file that owns the full home discovery rule. */
const HOME_DISCOVERY_OWNER = path.join(skillsRoot, "common", "journal-management-generic", "SKILL.md");

/**
 * The owner sentence that ends the search at the folder holding agent-notes.
 *
 * Limit: the check matches this one phrase, so an owner that rewords the
 * sentence makes check 7 pass with no owner at all. Rename the phrase here
 * together with the sentence.
 */
const HOME_DISCOVERY_SENTENCE = "Stop at the first folder that holds a folder named agent-notes";

/** Collapse whitespace so a sentence wrapped across lines still matches. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** True when a file carries the canonical discovery rule sentence. */
function carriesDiscoveryRule(text: string): boolean {
	return collapseWhitespace(text).includes(HOME_DISCOVERY_SENTENCE);
}

/**
 * The pointer line every doctrine file that names the placeholder must carry.
 * The owner states the rule; a pointer only sends the reader to the owner.
 */
const HOME_DISCOVERY_POINTER =
	"`<USER_HOME>` is the folder that holds `agent-notes`. Follow the **journal-management-generic** skill for the exact rule and the fallback.";

/** True when a file carries the pointer line that sends the reader to the owner. */
function carriesOwnerPointer(text: string): boolean {
	return collapseWhitespace(text).includes(HOME_DISCOVERY_POINTER);
}

/**
 * The files that replaced a startup shell order with the pointer line. Each one
 * must still carry it: a file that drops the pointer leaves the reader with no
 * rule, and a file that restates the rule breaks the one-owner law.
 */
const HOME_DISCOVERY_POINTER_FILES: string[] = [
	"content/professions/orchestrator.md",
	"content/professions/planner.md",
	"content/professions/researcher.md",
	"content/skills/common/project-notes/SKILL.md",
	"content/skills/common/skill-resolution/SKILL.md",
	"content/skills/planner/study/SKILL.md",
];

/** Phrases only the owner may state. A copy that restates the rule fails here. */
const HOME_DISCOVERY_OWNER_PHRASES: string[] = ["literal path", "ask the user once"];

describe("condition 7: one owner of the home discovery rule", () => {
	test("only the journal-management-generic skill carries the discovery sentence", () => {
		const owner = relativePosix(repoRoot, HOME_DISCOVERY_OWNER);
		const carriers = homeDiscoveryFiles()
			.filter((file) => carriesDiscoveryRule(readText(file)))
			.map((file) => relativePosix(repoRoot, file));
		assert.deepEqual(
			carriers,
			[owner],
			"check 7 (single owner of the home discovery rule) expected only " +
				owner +
				" but found: " +
				carriers.join(", "),
		);
	});
	test("every pointer file carries the pointer line", () => {
		const failures = new Set<string>();
		for (const rel of HOME_DISCOVERY_POINTER_FILES) {
			const file = path.join(repoRoot, rel);
			if (!fs.existsSync(file)) failures.add(rel + " (missing file)");
			else if (!carriesOwnerPointer(readText(file))) failures.add(rel + " (no pointer line)");
		}
		// Any skill that names the placeholder must point at the owner as well.
		for (const file of homeDiscoveryFiles()) {
			if (file === HOME_DISCOVERY_OWNER) continue;
			if (!file.startsWith(skillsRoot + path.sep)) continue;
			const text = readText(file);
			if (!text.includes("<USER_HOME>")) continue;
			if (!carriesOwnerPointer(text)) {
				failures.add(relativePosix(repoRoot, file) + " (no pointer line)");
			}
		}
		assert.deepEqual(
			[...failures].sort(),
			[],
			"check 7 (single owner of the home discovery rule) these files lack the pointer line: " +
				[...failures].sort().join(", "),
		);
	});
	test("only the owner skill states the owner phrases", () => {
		const owner = relativePosix(repoRoot, HOME_DISCOVERY_OWNER);
		const failures: string[] = [];
		for (const file of homeDiscoveryFiles()) {
			const rel = relativePosix(repoRoot, file);
			if (rel === owner) continue;
			const text = collapseWhitespace(readText(file));
			for (const phrase of HOME_DISCOVERY_OWNER_PHRASES) {
				if (text.includes(phrase)) failures.push(rel + ' (copies "' + phrase + '")');
			}
		}
		assert.deepEqual(
			failures.sort(),
			[],
			"check 7 (single owner of the home discovery rule) these files restate the rule: " +
				failures.sort().join(", "),
		);
	});
	test("the owner skill states both owner phrases", () => {
		const text = collapseWhitespace(readText(HOME_DISCOVERY_OWNER));
		const missing = HOME_DISCOVERY_OWNER_PHRASES.filter((phrase) => !text.includes(phrase));
		assert.deepEqual(
			missing,
			[],
			"check 7 (single owner of the home discovery rule) the owner lost these phrases: " +
				missing.join(", "),
		);
	});
});
