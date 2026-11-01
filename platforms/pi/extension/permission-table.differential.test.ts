/**
 * Differential test: the legacy rules against the compiled table.
 *
 * The legacy rule lists still live in the 7 pi frontmatters, and the global
 * file is recorded in the parity ledger. This test parses them, builds a probe
 * corpus, and computes the verdict twice for every probe: once from the running
 * role's legacy rule sets and once from the table row set for the same role.
 *
 * The gate is one-sided on purpose:
 *   - the table must never be LOOSER than a legacy rule. A looser verdict is a
 *     fail-open hole and fails the test.
 *   - a STRICTER verdict is allowed only when the ledger records the change
 *     class and `CHANGE_RULINGS` holds its reason and owner ruling.
 *
 * A probe witnesses the first corpus entry its rule matches. The corpus is the
 * witness set, so a narrowed form is not probed here; the `NARROWED` list in
 * the parity ledger owns that evidence, and the table test proves it.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     platforms/pi/extension/permission-table.differential.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCommandRules, type RawRule, type RuleSets } from "./command-segments.ts";
import { compileRole, type Role, type RuleRow } from "./permission-table.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import { CHANGE_RULINGS, DELETIONS, LEGACY, LEGACY_COUNTS, LEGACY_GLOBAL } from "./permission-table.parity.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FRONTMATTER_DIR = path.join(repoRoot, "platforms", "pi", "frontmatters");

const ROLES: readonly Role[] = [
	"orchestrator",
	"planner",
	"implementer",
	"tester",
	"reviewer",
	"researcher",
	"mascot",
];

type Section = "allow" | "ask" | "deny";
const SECTIONS: readonly Section[] = ["allow", "ask", "deny"];
type Verdict = "deny" | "ask" | "allow";
const RANK: Record<Verdict, number> = { deny: 0, ask: 1, allow: 2 };

interface LegacyRule {
	tool: string;
	match: string;
}

interface LegacyRole {
	allow: LegacyRule[];
	ask: LegacyRule[];
	deny: LegacyRule[];
}

interface Probe {
	tool: string;
	probe: string;
}

// --- legacy sources ---------------------------------------------------------

function unescapeYaml(raw: string): string {
	return raw.replace(/\\(["\\])/g, "$1");
}

/**
 * Parse one `permissions:` block. The live frontmatter is the source while it
 * still holds the block; a role that has moved to a `permissionClass:` line
 * carries no legacy list, so it returns null.
 */
function parseRole(role: Role): LegacyRole | null {
	const text = readFileSync(path.join(FRONTMATTER_DIR, `${role}.yaml`), "utf8");
	const hasBlock = /^permissions:/m.test(text);
	const hasClass = /^permissionClass:/m.test(text);
	if (!hasBlock) {
		assert.ok(hasClass, `${role} carries neither a permissions block nor a class line`);
		return null;
	}
	const out: LegacyRole = { allow: [], ask: [], deny: [] };
	let section: Section | null = null;
	let inside = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^permissions:/.test(line)) {
			inside = true;
			continue;
		}
		if (inside && /^[A-Za-z]/.test(line)) inside = false;
		if (!inside) continue;
		const sec = /^  (allow|ask|deny):(?:\s*\[\s*\])?\s*$/.exec(line);
		if (sec) {
			section = sec[1] as Section;
			continue;
		}
		if (!section) continue;
		const entry = /^    - \{ tool: ([a-z_]+), match: "((?:[^"\\]|\\.)*)"(?:, reason: "((?:[^"\\]|\\.)*)")? \}\s*$/.exec(line);
		if (!entry) continue;
		out[section].push({ tool: entry[1], match: unescapeYaml(entry[2]) });
	}
	return out;
}

/** The tools a role's loadout carries. A probe whose tool is absent is skipped. */
function parseLoadout(role: Role): Set<string> {
	const text = readFileSync(path.join(FRONTMATTER_DIR, `${role}.yaml`), "utf8");
	const line = /^tools:\s*\[(.*)\]\s*$/m.exec(text);
	if (!line) return new Set();
	const tools = line[1]
		.split(",")
		.map((token) => token.trim().replace(/^["']|["']$/g, ""))
		.filter((token) => token.length > 0 && !token.includes("*"));
	return new Set(tools);
}

const PARSED = new Map<Role, LegacyRole | null>();
const LOADOUT = new Map<Role, Set<string>>();
for (const role of ROLES) {
	PARSED.set(role, parseRole(role));
	LOADOUT.set(role, parseLoadout(role));
}

// --- the probe corpus -------------------------------------------------------

/**
 * Witness commands. A rule's witness is the first entry whose tool matches and
 * whose regex matches, so the safe, table-supported form of each rule family
 * comes first.
 */
const CANDIDATES: readonly Probe[] = [
	// Tool rows and path rows.
	{ tool: "todo", probe: "x" },
	{ tool: "subagent", probe: "x" },
	{ tool: "ask_user_question", probe: "x" },
	{ tool: "read", probe: "notes/x.md" },
	{ tool: "read", probe: "agent-notes/x.md" },
	{ tool: "read", probe: "agents.json" },
	{ tool: "read", probe: "package.json" },
	{ tool: "read", probe: "personas/x.md" },
	{ tool: "read", probe: "platforms/pi/frontmatters/x.yaml" },
	{ tool: "read", probe: "skills/x/SKILL.md" },
	{ tool: "read", probe: ".env" },
	{ tool: "read", probe: "id_rsa" },
	{ tool: "find", probe: "src" },
	{ tool: "ls", probe: "src" },
	{ tool: "grep", probe: "src" },
	{ tool: "edit", probe: "src/x.ts" },
	{ tool: "write", probe: "src/x.ts" },
	{ tool: "edit", probe: "agent-notes/planner/x.md" },
	{ tool: "write", probe: "agent-notes/planner/x.md" },
	{ tool: "edit", probe: "agent-notes/project-notes/x.md" },
	{ tool: "write", probe: "agent-notes/project-notes/x.md" },
	{ tool: "edit", probe: "agent-notes/researcher/x.md" },
	{ tool: "write", probe: "agent-notes/researcher/x.md" },
	{ tool: "edit", probe: "/fixture/agent-notes/x.md" },
	{ tool: "write", probe: "/fixture/agent-notes/x.md" },
	{ tool: "edit", probe: "/tmp/x" },
	{ tool: "write", probe: "/tmp/x" },
	{ tool: "edit", probe: "../x" },
	{ tool: "write", probe: "../x" },
	{ tool: "edit", probe: "~/x" },
	{ tool: "write", probe: "~/x" },
	{ tool: "edit", probe: "/etc/passwd" },
	{ tool: "write", probe: "/etc/passwd" },

	// Read-only shell commands and search.
	{ tool: "bash", probe: "cat x" },
	{ tool: "bash", probe: "find ." },
	{ tool: "bash", probe: "mkdir -p out" },
	{ tool: "bash", probe: "sort -o out in" },
	{ tool: "bash", probe: "uniq in out" },
	{ tool: "bash", probe: "xxd a b" },
	{ tool: "bash", probe: "rg --pre 'sh -c id' pat" },
	{ tool: "bash", probe: "rg -z pat.gz" },
	{ tool: "bash", probe: "date -s 2020-01-01" },
	{ tool: "bash", probe: "tsc --noEmit" },
	{ tool: "bash", probe: "tsc" },
	{ tool: "bash", probe: "npm root" },

	// Git reads and listings.
	{ tool: "bash", probe: "git status" },
	{ tool: "bash", probe: "git blame f" },
	{ tool: "bash", probe: "git tag -l" },
	{ tool: "bash", probe: "git stash list" },
	{ tool: "bash", probe: "git notes show" },
	{ tool: "bash", probe: "git worktree list" },
	{ tool: "bash", probe: "git submodule status" },
	{ tool: "bash", probe: "git sparse-checkout list" },
	{ tool: "bash", probe: "git commit-graph verify" },
	{ tool: "bash", probe: "git multi-pack-index verify" },
	{ tool: "bash", probe: "git branch -l" },
	{ tool: "bash", probe: "git branch -r --contains main" },
	{ tool: "bash", probe: "git symbolic-ref HEAD" },
	{ tool: "bash", probe: "git config --get core.editor" },
	{ tool: "bash", probe: "git remote -v" },
	{ tool: "bash", probe: "git reflog show" },
	{ tool: "bash", probe: "git hash-object f" },
	{ tool: "bash", probe: "git fsck" },
	{ tool: "bash", probe: "git diff <(x)" },

	// Git fences and exception forms.
	{ tool: "bash", probe: "git hash-object -w f" },
	{ tool: "bash", probe: "git fsck --lost-found" },
	{ tool: "bash", probe: "git log --output=/fixture/escape.txt" },
	{ tool: "bash", probe: "git grep -O less pat" },
	{ tool: "bash", probe: "git fetch" },
	{ tool: "bash", probe: "git fetch origin a:b" },
	{ tool: "bash", probe: "git branch -d x" },
	{ tool: "bash", probe: "git branch new" },
	{ tool: "bash", probe: "git branch -u origin/main" },
	{ tool: "bash", probe: "git branch --format=x a b" },
	// The second-token branch listing needs a two-word value pair, so a value of
	// one letter witnesses nothing. The reviewer and the researcher carry one
	// identical rule, so one probe covers both.
	{ tool: "bash", probe: "git branch -r --contains main extra" },
	{ tool: "bash", probe: "git reflog expire --all" },
	{ tool: "bash", probe: "git remote add origin x" },
	{ tool: "bash", probe: "git ls-remote --upload-pack=x origin" },
	{ tool: "bash", probe: "git tag -d v1" },
	{ tool: "bash", probe: "git reset --hard" },
	{ tool: "bash", probe: "git clean -fdx" },
	{ tool: "bash", probe: "git checkout -- ." },
	{ tool: "bash", probe: "git reset --soft HEAD~1" },
	{ tool: "bash", probe: "git commit" },
	{ tool: "bash", probe: "git commit --amend" },
	{ tool: "bash", probe: "git tag --force v1" },
	{ tool: "bash", probe: "git pull --upload-pack=x" },
	{ tool: "bash", probe: "git pull ext::sh -c id" },
	{ tool: "bash", probe: "git merge --strategy=ours t" },
	{ tool: "bash", probe: "git rebase -s recursive t" },
	{ tool: "bash", probe: "git -c core.editor=v commit" },
	{ tool: "bash", probe: "git --git-dir=/x commit" },
	{ tool: "bash", probe: "env A=1 git commit" },
	{ tool: "bash", probe: "git commit $MSG" },
	{ tool: "bash", probe: "git commit *" },
	{ tool: "bash", probe: "$(git commit)" },
	{ tool: "bash", probe: "git push" },
	{ tool: "bash", probe: "gh pr" },
	{ tool: "bash", probe: "gh run" },
	{ tool: "bash", probe: "gh release" },
	{ tool: "bash", probe: "gh --version" },

	// Builds, tests, and toolchain probes.
	{ tool: "bash", probe: "cargo build" },
	{ tool: "bash", probe: "cargo check" },
	{ tool: "bash", probe: "cargo build" },
	{ tool: "bash", probe: "cargo deny check" },
	{ tool: "bash", probe: "cargo nextest" },
	{ tool: "bash", probe: "cargo metadata" },
	{ tool: "bash", probe: "cargo tree" },
	{ tool: "bash", probe: "cargo locate-project" },
	{ tool: "bash", probe: "cargo pkgid" },
	{ tool: "bash", probe: "cargo fmt --check" },
	{ tool: "bash", probe: "cargo add serde" },
	{ tool: "bash", probe: "cargo --version" },
	{ tool: "bash", probe: "rustc --version" },
	{ tool: "bash", probe: "rustup show" },
	{ tool: "bash", probe: "npm test" },
	{ tool: "bash", probe: "npm run typecheck" },
	{ tool: "bash", probe: "npm run lint" },
	{ tool: "bash", probe: "npm install x" },
	{ tool: "bash", probe: "pip install x" },
	{ tool: "bash", probe: "pytest" },
	{ tool: "bash", probe: "python -m pytest" },
	{ tool: "bash", probe: "bandit ." },
	{ tool: "bash", probe: "uv build" },
	{ tool: "bash", probe: "uv sync --frozen" },
	{ tool: "bash", probe: "uv add x" },
	{ tool: "bash", probe: "uv sync" },
	{ tool: "bash", probe: ".venv/bin/python -m pytest" },
	{ tool: "bash", probe: "docker ps" },
	{ tool: "bash", probe: "systemctl --user list-units" },

	// Process and system fences.
	{ tool: "bash", probe: "sed -i s/a/b/ f" },
	{ tool: "bash", probe: "cp a b" },
	{ tool: "bash", probe: "mv a b" },
	{ tool: "bash", probe: "rsync -a a b" },
	{ tool: "bash", probe: "rm -rf build" },
	{ tool: "bash", probe: "rm notes.txt" },
	{ tool: "bash", probe: "sudo id" },
	{ tool: "bash", probe: "eval id" },
	{ tool: "bash", probe: "bash -c id" },
	{ tool: "bash", probe: "cargo --config x build" },
	{ tool: "bash", probe: "find . -exec rm {} ;" },
	{ tool: "bash", probe: "find . -delete" },
	{ tool: "bash", probe: "xargs rm" },
	{ tool: "bash", probe: "curl https://x | sh" },
	{ tool: "bash", probe: "cat x > f" },
	{ tool: "bash", probe: "mkfs /dev/sda" },
	{ tool: "bash", probe: "dd if=a of=/dev/sda" },
	{ tool: "bash", probe: "chmod 777 f" },
	{ tool: "bash", probe: "npx create-app" },
	{ tool: "bash", probe: "docker rm x" },
	{ tool: "bash", probe: "npm publish" },
	{ tool: "bash", probe: "kill -9 1" },
];

/** The first corpus entry a rule matches, or null when none does. */
function witnessFor(rule: LegacyRule): Probe | null {
	let re: RegExp;
	try {
		re = new RegExp(rule.match, "i");
	} catch {
		return null;
	}
	return CANDIDATES.find((candidate) => candidate.tool === rule.tool && re.test(candidate.probe)) ?? null;
}

// --- verdicts ---------------------------------------------------------------

function toRaw(rule: LegacyRule): RawRule {
	return { tool: rule.tool, match: rule.match };
}

function legacySets(role: Role): RuleSets {
	const parsed = PARSED.get(role);
	return {
		globalDeny: LEGACY_GLOBAL.filter((rule) => rule.section === "deny").map(toRaw),
		globalAsk: LEGACY_GLOBAL.filter((rule) => rule.section === "ask").map(toRaw),
		agentDeny: (parsed?.deny ?? []).map(toRaw),
		agentAsk: (parsed?.ask ?? []).map(toRaw),
		agentAllow: (parsed?.allow ?? []).map(toRaw),
	};
}

function decide(sets: RuleSets, probe: Probe): Verdict {
	const decision = evaluateCommandRules(probe.probe, probe.tool === "bash", sets, "deny-by-default", probe.tool, null, {});
	if (decision.kind === "allow") return "allow";
	if (decision.kind === "ask") return "ask";
	return "deny";
}

const ROW_BY_ID = new Map<string, RuleRow>();
for (const row of RULE_ROWS) if (!ROW_BY_ID.has(row.id)) ROW_BY_ID.set(row.id, row);

function sectionOf(entry: string): Section {
	return entry.split("/")[1] as Section;
}

/**
 * The recorded reason a stricter verdict is intended, or null. A deletion, a
 * recorded change class, a narrowing note, and a row verdict that differs from
 * the legacy section each carry a recorded change class.
 */
function intended(entry: string): string | null {
	const record = LEGACY.find((item) => item.entry === entry);
	if (!record) return null;
	if (record.del !== undefined) return record.del in DELETIONS ? record.del : null;
	if (record.why !== undefined) return record.why;
	if (record.note !== undefined) return "note";
	const row = record.row === undefined ? undefined : ROW_BY_ID.get(record.row);
	if (row && row.verdict !== sectionOf(entry)) return "strengthened";
	return null;
}

// --- coverage ---------------------------------------------------------------

test("the legacy sources parse to the recorded shape", () => {
	for (const role of ROLES) {
		const parsed = PARSED.get(role);
		assert.ok(parsed, `${role} did not parse`);
		const counts = LEGACY_COUNTS[role];
		assert.ok(counts, `${role} has no recorded count`);
		for (const section of SECTIONS) {
			assert.equal(parsed[section].length, counts[section], `${role}/${section}`);
		}
	}
	const deny = LEGACY_GLOBAL.filter((rule) => rule.section === "deny").length;
	const ask = LEGACY_GLOBAL.filter((rule) => rule.section === "ask").length;
	assert.equal(deny, 6);
	assert.equal(ask, 11);
});

test("the probe corpus witnesses every legacy rule", () => {
	const missing: string[] = [];
	for (const role of ROLES) {
		const parsed = PARSED.get(role);
		if (!parsed) continue;
		for (const section of SECTIONS) {
			for (const rule of parsed[section]) {
				if (witnessFor(rule) === null) missing.push(`${role}/${section}: ${rule.tool} ${rule.match}`);
			}
		}
	}
	for (const rule of LEGACY_GLOBAL) {
		if (witnessFor(rule) === null) missing.push(`global/${rule.section}: ${rule.tool} ${rule.match}`);
	}
	assert.deepEqual(missing, [], `no probe witnesses:\n${missing.join("\n")}`);
});

// --- the gate ---------------------------------------------------------------

test("the table is never looser than the legacy rules", (t) => {
	const failures: string[] = [];
	const tightened: string[] = [];

	const compare = (entry: string, role: Role, probe: Probe): void => {
		const legacy = decide(legacySets(role), probe);
		const next = decide(compileRole(RULE_ROWS, role), probe);
		if (RANK[next] > RANK[legacy]) {
			failures.push(
				`LOOSER ${entry} on ${probe.tool} \`${probe.probe}\`: legacy ${legacy}, table ${next}`,
			);
			return;
		}
		if (RANK[next] < RANK[legacy]) {
			const why = intended(entry);
			if (why === null) {
				failures.push(
					`STRICTER-UNLISTED ${entry} on ${probe.tool} \`${probe.probe}\`: legacy ${legacy}, table ${next}`,
				);
				return;
			}
			if (!(why in CHANGE_RULINGS)) {
				failures.push(`UNRECORDED-CLASS ${entry}: ${why}`);
				return;
			}
			tightened.push(`${entry} ${legacy}->${next} (${why})`);
		}
	};

	for (const role of ROLES) {
		const parsed = PARSED.get(role);
		if (!parsed) continue;
		const loadout = LOADOUT.get(role) ?? new Set<string>();
		for (const section of SECTIONS) {
			parsed[section].forEach((rule, index) => {
				const probe = witnessFor(rule);
				if (probe === null || !loadout.has(probe.tool)) return;
				compare(`${role}/${section}/${index + 1}`, role, probe);
			});
		}
	}

	for (const rule of LEGACY_GLOBAL) {
		const probe = witnessFor(rule);
		if (probe === null) continue;
		const index = LEGACY_GLOBAL.filter((item) => item.section === rule.section).indexOf(rule) + 1;
		const entry = `global/${rule.section}/${index}`;
		for (const role of ROLES) {
			if (!(LOADOUT.get(role) ?? new Set<string>()).has(probe.tool)) continue;
			compare(entry, role, probe);
		}
	}

	assert.deepEqual(failures, [], `legacy-versus-table disagreements:\n${failures.join("\n")}`);
	// The stricter set is measured and reported, never assumed.
	t.diagnostic(`tightened verdicts: ${tightened.length}`);
	for (const line of tightened) t.diagnostic(line);
});

test("every change class carries a reason and an owner ruling", () => {
	for (const [name, record] of Object.entries(CHANGE_RULINGS)) {
		assert.ok(record.reason.length > 0 && !record.reason.includes("\n"), `${name} needs a one-line reason`);
		assert.ok(record.ruling.length > 0 && !record.ruling.includes("\n"), `${name} needs a one-line ruling`);
	}
	for (const id of Object.keys(DELETIONS)) {
		assert.ok(id in CHANGE_RULINGS, `${id} has no change ruling`);
	}
});
