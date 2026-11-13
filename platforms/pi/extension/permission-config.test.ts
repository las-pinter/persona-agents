/**
 * Tests for the three permission layers.
 *
 *   node --experimental-strip-types --test \
 *     platforms/pi/extension/permission-config.test.ts
 *
 * The shipped default file is the source of truth for the rows. A user override
 * patches rows by row id. The global overlay stays the third layer. A broken
 * layer fails closed, and a table inside a repository never loads. Every test
 * writes its own fixtures in a temporary directory, so no real home file and no
 * repository file is read.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  DEFAULT_TABLE_FILE,
  FENCE_REASON,
  loadGlobalRules,
  loadPermissionConfig,
  loadTableFile,
  type ConfigPaths,
  type PermissionConfig,
} from "./permission-config.ts";
import type { RuleRow } from "./permission-table.ts";
import { compileClass, compileRole, countTable } from "./permission-table-groups.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import { evaluateCommandRules, type RuleSets } from "./command-segments.ts";
import { readAllEvents } from "./tree-log.ts";
import { ENV_TREE_LOG } from "./depth.ts";

/** One throwaway directory per run. No test carries a real home path. */
const dir = mkdtempSync(path.join(tmpdir(), "permission-config-"));

function write(name: string, value: unknown): string {
	const file = path.join(dir, name);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

/** A readable, empty overlay, so no test reads the real home overlay. */
const OVERLAY = write("overlay.json", { deny: [], ask: [] });
/** A path with no file, so no override applies unless a test supplies one. */
const NO_OVERRIDE = path.join(dir, "absent-override.json");

/** The paths every case passes, with the isolated overlay and no override. */
function basePaths(extra: ConfigPaths = {}): ConfigPaths {
	return { override: NO_OVERRIDE, overlay: OVERLAY, ...extra };
}

/** A log path no other case reads, so one case never sees another's lines. */
let caseCounter = 0;
function caseLogPath(): string {
	caseCounter += 1;
	return path.join(dir, `log-${caseCounter}.ndjson`);
}

/** Load the config and capture the log lines it writes. */
function load(paths: ConfigPaths): { config: PermissionConfig; lines: string[] } {
	const previous = process.env[ENV_TREE_LOG];
	const logPath = caseLogPath();
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const config = loadPermissionConfig(paths);
		const lines = readAllEvents(logPath)
			.filter((event) => event.type === "log" && typeof event.text === "string")
			.map((event) => event.text ?? "");
		return { config, lines };
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
	}
}

/** The lead one failure line carries before the fault text. */
function failureHead(file: string, kind: "table" | "override"): string {
	return `permission gate: cannot load the ${kind} file ${file}: `;
}

/** The fault text one failure line carries after its lead. */
function faultText(line: string, file: string, kind: "table" | "override"): string {
	const head = failureHead(file, kind);
	assert.ok(line.startsWith(head), line);
	const tail = "; every tool call is denied until the file is fixed";
	const at = line.indexOf(tail, head.length);
	assert.notEqual(at, -1, line);
	return line.slice(head.length, at);
}

/** The one refusal sentence both layers share, with the kind of path named. */
function refusalLine(file: string, kind: "table" | "override"): string {
	return `permission gate: refused ${file}: the ${kind} path must be absolute, so the shipped default stays in force`;
}

/** The verdict the engine reaches for one tool call under one rule set. */
function verdict(sets: RuleSets, tool: string, probe: string, open = false): string {
	const mode = open ? "allow-unless-matched" : "deny-by-default";
	const decision = evaluateCommandRules(probe, tool === "bash", sets, mode, tool, null, {});
	return decision.kind;
}

/** A valid fixture row, so a fixture table can hold one row. */
function fixtureRow(id: string): RuleRow {
	return {
		id,
		tool: "bash",
		verdict: "ask",
		classes: ["worker"],
		verb: ["true"],
		arg: "any",
		reason: "A fixture row",
	};
}

// --- the shipped default file ----------------------------------------------

test("the shipped default file holds 87 rows and the frozen counts", () => {
	const rows = loadTableFile(DEFAULT_TABLE_FILE);
	const counts = countTable(rows);
	assert.equal(counts.total, 87);
	assert.equal(counts.byGroup.global, 22);
	assert.equal(counts.byGroup.reader, 15);
	assert.equal(counts.byGroup.worker, 22);
	assert.equal(counts.byGroup.orchestrator, 28);
	assert.equal(counts.byClass.reader, 36);
	assert.equal(counts.byClass.worker, 44);
	assert.equal(counts.byClass.orchestrator, 50);
	assert.equal(counts.uniqueIds, 62);
});

test("the default file resolves from the module, not the working directory", () => {
	assert.equal(path.isAbsolute(DEFAULT_TABLE_FILE), true);
	assert.equal(DEFAULT_TABLE_FILE.endsWith(path.join("platforms", "pi", "permissions.table.json")), true);
});

test("the module view and the loaded default are one row definition", () => {
	const rows = loadTableFile(DEFAULT_TABLE_FILE);
	assert.deepEqual(rows.map((row) => row.id), RULE_ROWS.map((row) => row.id));
	assert.ok(rows.every((row) => row.layer === "default"));
});

// --- the user override ------------------------------------------------------

test("an override changes one verdict for every row of that id", () => {
	const file = write("verdict-override.json", {
		version: 1,
		patch: [{ id: "release.ask", verdict: "deny" }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	assert.equal(config.rows.length, 87);
	const changed = config.rows.filter((row) => row.id === "release.ask");
	assert.equal(changed.length, 1);
	assert.ok(changed.every((row) => row.verdict === "deny" && row.layer === "override"));
	assert.equal(verdict(compileRole(config.rows, "orchestrator"), "bash", "git push origin main"), "deny");
});

test("an override disables one row", () => {
	const file = write("disable-override.json", {
		version: 1,
		patch: [{ id: "npx.run", disabled: true }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	assert.equal(config.rows.length, 86);
	assert.equal(config.rows.some((row) => row.id === "npx.run"), false);
	// The ask row is gone, so the call falls to the mode default.
	assert.equal(verdict(compileRole(config.rows, "implementer"), "bash", "npx cowsay hi"), "default");
});

test("an override adds one row", () => {
	const file = write("add-override.json", {
		version: 1,
		patch: [
			{
				id: "custom.fetch-ask",
				row: {
					id: "custom.fetch-ask",
					tool: "bash",
					verdict: "ask",
					classes: ["worker"],
					verb: ["curl"],
					arg: "any",
					reason: "A network fetch requires user approval",
				},
			},
		],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	assert.equal(config.rows.length, 88);
	const added = config.rows.find((row) => row.id === "custom.fetch-ask");
	assert.ok(added !== undefined && added.layer === "override");
	assert.equal(verdict(compileRole(config.rows, "implementer"), "bash", "curl https://example.test"), "ask");
});

test("an override row with unnamed widens to its class compile", () => {
	const row = {
		id: "custom.copy-ask",
		tool: "bash",
		verdict: "ask",
		classes: ["worker"],
		roles: ["implementer"],
		unnamed: true,
		verb: ["curl"],
		arg: "any",
		reason: "A network fetch requires user approval",
	};
	const file = write("unnamed-row.json", { version: 1, patch: [{ id: row.id, row }] });
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	assert.equal(config.rows.length, 88);
	assert.equal(verdict(compileClass(config.rows, "worker"), "bash", "curl https://example.test"), "ask");
	// The named profession keeps the row; a named tester does not get it.
	assert.equal(verdict(compileRole(config.rows, "implementer"), "bash", "curl https://example.test"), "ask");
	assert.equal(verdict(compileRole(config.rows, "tester"), "bash", "curl https://example.test"), "default");
});

test("an override row without unnamed leaves the class compile alone", () => {
	const row = {
		id: "custom.copy-ask",
		tool: "bash",
		verdict: "ask",
		classes: ["worker"],
		roles: ["implementer"],
		verb: ["curl"],
		arg: "any",
		reason: "A network fetch requires user approval",
	};
	const file = write("named-only-row.json", { version: 1, patch: [{ id: row.id, row }] });
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	assert.equal(verdict(compileClass(config.rows, "worker"), "bash", "curl https://example.test"), "default");
	assert.equal(verdict(compileRole(config.rows, "implementer"), "bash", "curl https://example.test"), "ask");
});

test("an override replaces every row of an id with one supplied row", () => {
	const file = write("replace-override.json", {
		version: 1,
		patch: [
			{
				id: "git.fetch.deny",
				row: {
					id: "git.fetch.deny",
					tool: "bash",
					verdict: "ask",
					classes: ["reader", "worker"],
					verb: ["git"],
					sub: ["fetch"],
					flags: "refspec",
					arg: "any",
					reason: "A fetch with a refspec requires user approval",
				},
			},
		],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.deepEqual(lines, []);
	const replaced = config.rows.filter((row) => row.id === "git.fetch.deny");
	assert.equal(replaced.length, 1);
	assert.deepEqual(replaced[0]?.classes, ["reader", "worker"]);
	// Two shipped git.fetch.deny rows collapse to one, so the total drops by one.
	assert.equal(config.rows.length, 86);
});

test("an override that changes the class list of an existing id fails closed", () => {
	const file = write("class-change.json", {
		version: 1,
		patch: [
			{
				id: "git.fetch.deny",
				row: {
					id: "git.fetch.deny",
					tool: "bash",
					verdict: "ask",
					classes: ["reader", "worker", "orchestrator"],
					verb: ["git"],
					sub: ["fetch"],
					flags: "refspec",
					arg: "any",
					reason: "A fetch with a refspec requires user approval",
				},
			},
		],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("git.fetch.deny"), lines[0]);
	assert.ok(lines[0].includes("class list"), lines[0]);
	assertFenced(config);
});

// --- the source layer -------------------------------------------------------

test("every compiled row records its layer", () => {
	const file = write("layer-override.json", {
		version: 1,
		patch: [{ id: "release.ask", verdict: "deny" }],
	});
	const { config } = load(basePaths({ override: file }));
	const sets = compileRole(config.rows, "orchestrator");
	for (const list of Object.values(sets)) {
		for (const rule of list) {
			assert.ok(rule.layer === "default" || rule.layer === "override", rule.match);
		}
	}
	assert.ok(sets.agentAsk.some((rule) => rule.reason === "A release or remote operation requires user approval") === false);
	assert.ok(sets.agentDeny.some((rule) => rule.reason === "A release or remote operation requires user approval" && rule.layer === "override"));
	assert.ok(sets.agentDeny.some((rule) => rule.reason === "Deleting a tag is denied" && rule.layer === "default"));
});

test("the global overlay loads after the rows and is stamped as overlay", () => {
	const overlay = write("overlay-rules.json", {
		deny: [{ tool: "bash", match: "\\btrue\\b", reason: "A test overlay" }],
		ask: [],
	});
	const { config, lines } = load(basePaths({ overlay }));
	assert.deepEqual(lines, []);
	assert.equal(config.rows.length, 87);
	assert.equal(config.overlay.deny.length, 1);
	assert.equal(config.overlay.deny[0].layer, "overlay");
	const sets = compileRole(config.rows, "implementer");
	sets.globalDeny = [...sets.globalDeny, ...config.overlay.deny];
	assert.equal(verdict(sets, "bash", "true"), "deny");
});

// --- the overlay schema -----------------------------------------------------

/** The fence a broken overlay returns: one deny-all row, no ask row. */
function assertOverlayFence(rules: ReturnType<typeof loadGlobalRules>): void {
	assert.equal(rules.deny.length, 1);
	assert.equal(rules.deny[0].match, ".*");
	assert.equal(rules.deny[0].layer, "overlay");
	assert.deepEqual(rules.ask, []);
}

/** Run the overlay loader and capture the log lines it writes. */
function loadOverlay(file: string): { rules: ReturnType<typeof loadGlobalRules>; lines: string[] } {
	const previous = process.env[ENV_TREE_LOG];
	const logPath = caseLogPath();
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const rules = loadGlobalRules(file);
		const lines = readAllEvents(logPath)
			.filter((event) => event.type === "log" && typeof event.text === "string")
			.map((event) => event.text ?? "");
		return { rules, lines };
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
	}
}

test("an overlay deny row with no match closes the fence", () => {
	const file = write("overlay-no-match.json", { deny: [{ reason: "x" }], ask: [] });
	const { rules } = loadOverlay(file);
	assertOverlayFence(rules);
});

test("an overlay fault writes one line that names the file and the fault", () => {
	const file = write("overlay-fault-line.json", { deny: [{ reason: "x" }], ask: [] });
	const { lines } = loadOverlay(file);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assert.ok(lines[0].includes("match"), lines[0]);
});

test("an overlay row with an empty match closes the fence", () => {
	const file = write("overlay-empty-match.json", { deny: [{ match: "" }], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('non-empty string "match"'), lines[0]);
});

test("an overlay row with a non-string reason closes the fence", () => {
	const file = write("overlay-bad-reason.json", { deny: [{ match: "\\btrue\\b", reason: 3 }], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('string "reason"'), lines[0]);
});

test("an overlay row that is not an object closes the fence", () => {
	const file = write("overlay-row-not-object.json", { deny: ["\\btrue\\b"], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("deny[0] must be a JSON object"), lines[0]);
});

test("an overlay row with a match that does not compile closes the fence", () => {
	const file = write("overlay-bad-regex.json", { deny: [{ match: "[unclosed" }], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('valid "match" regex'), lines[0]);
});

test("an overlay with an absent section returns no rules and logs nothing", () => {
	const file = write("overlay-absent-section.json", {});
	const { rules, lines } = loadOverlay(file);
	assert.deepEqual(lines, []);
	assert.deepEqual(rules.deny, []);
	assert.deepEqual(rules.ask, []);
});

test("an overlay section that is not a list names the fault", () => {
	const file = write("overlay-not-a-list.json", { deny: "all", ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('"deny" must be a list'), lines[0]);
});

test("an overlay row with an unknown field closes the fence", () => {
	const file = write("overlay-unknown-key.json", {
		deny: [{ match: "\\btrue\\b", matches: "\\btrue\\b" }],
		ask: [],
	});
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('unknown field "matches"'), lines[0]);
});

test("an overlay row with a non-string tool closes the fence", () => {
	const file = write("overlay-bad-tool.json", { deny: [{ tool: 3, match: "\\btrue\\b" }], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('string "tool"'), lines[0]);
});

test("an overlay row with an empty tool closes the fence", () => {
	const file = write("overlay-empty-tool.json", { deny: [{ tool: "", match: "\\btrue\\b" }], ask: [] });
	const { rules, lines } = loadOverlay(file);
	assertOverlayFence(rules);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes('non-empty string "tool"'), lines[0]);
});

test("a well-formed overlay keeps its rules in order and their layer", () => {
	const file = write("overlay-good.json", {
		deny: [
			{ tool: "bash", match: "\\btrue\\b", reason: "first" },
			{ match: "\\bfalse\\b", reason: "second" },
		],
		ask: [{ tool: "read", match: "^/fixture", reason: "third" }],
	});
	const rules = loadGlobalRules(file);
	assert.deepEqual(
		rules.deny.map((rule) => [rule.tool, rule.match, rule.reason, rule.layer]),
		[
			["bash", "\\btrue\\b", "first", "overlay"],
			[undefined, "\\bfalse\\b", "second", "overlay"],
		],
	);
	assert.deepEqual(
		rules.ask.map((rule) => [rule.tool, rule.match, rule.reason, rule.layer]),
		[["read", "^/fixture", "third", "overlay"]],
	);
});

// --- fail closed ------------------------------------------------------------

/** The overlay a fail-closed load returns, checked as a live fence. */
function assertFenced(config: PermissionConfig): void {
	assert.equal(config.rows.length, 0);
	assert.ok(config.overlay.deny.some((rule) => rule.reason === FENCE_REASON));
	const sets: RuleSets = {
		globalDeny: config.overlay.deny,
		globalAsk: config.overlay.ask,
		agentDeny: [],
		agentAsk: [],
		agentAllow: [],
	};
	assert.equal(verdict(sets, "bash", "git status", true), "deny");
	assert.equal(verdict(sets, "read", "/fixture/notes.txt", true), "deny");
}

test("a malformed default layer fails closed with the layer, the file and the row id", () => {
	const file = write("malformed-table.json", {
		version: 1,
		rows: [{ ...fixtureRow("bad.verdict"), verdict: "maybe" }],
	});
	const { config, lines } = load(basePaths({ table: file }));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(faultText(lines[0], file, "table"), 'row "bad.verdict": unknown verdict "maybe"');
	assertFenced(config);
});

test("a parse error fails closed with the file path", () => {
	const file = write("broken-table.json", '{ "version": 1, "rows": [ }');
	const { config, lines } = load(basePaths({ table: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assertFenced(config);
});

test("an override with an unknown row id fails closed with the file and id", () => {
	const file = write("unknown-id.json", {
		version: 1,
		patch: [{ id: "no.such.row", verdict: "ask" }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assert.ok(lines[0].includes("no.such.row"), lines[0]);
	assertFenced(config);
});

test("an override row fault starts with the one row prefix", () => {
	const file = write("row-prefix-override.json", {
		version: 1,
		patch: [{ id: "no.such.row", verdict: "ask" }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(faultText(lines[0], file, "override"), 'row "no.such.row": unknown row id');
	assertFenced(config);
});

test("an override entry with no string id names the one missing placeholder", () => {
	const file = write("no-id-entry.json", { version: 1, patch: [{ verdict: "deny" }] });
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(faultText(lines[0], file, "override"), 'row "<missing>": an entry needs a string id');
	assertFenced(config);
});

test("an override entry with an unknown field fails closed with the file and id", () => {
	const file = write("unknown-field.json", {
		version: 1,
		patch: [{ id: "release.ask", verdict: "deny", colour: "red" }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assert.ok(lines[0].includes("release.ask"), lines[0]);
	assertFenced(config);
});

test("a supplied row with an unknown field fails closed with the file and id", () => {
	const file = write("unknown-row-field.json", {
		version: 1,
		patch: [{ id: "release.ask", row: { ...fixtureRow("release.ask"), verdict: "ask", surprise: 1 } }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assert.ok(lines[0].includes("release.ask"), lines[0]);
	assertFenced(config);
});

test("an override with two actions fails closed", () => {
	const file = write("two-actions.json", {
		version: 1,
		patch: [{ id: "release.ask", verdict: "deny", disabled: true }],
	});
	const { config, lines } = load(basePaths({ override: file }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(file), lines[0]);
	assert.ok(lines[0].includes("release.ask"), lines[0]);
	assertFenced(config);
});

// --- no project-level table -------------------------------------------------

test("a table path inside a repository is refused and the default stays in force", () => {
	const repo = path.join(dir, "planted-repo");
	mkdirSync(path.join(repo, ".git"), { recursive: true });
	const planted = path.join(repo, "permissions.table.json");
	// An empty table would fail closed, so a loaded row proves the refusal.
	writeFileSync(planted, JSON.stringify({ version: 1, rows: [] }));
	const { config, lines } = load(basePaths({ table: planted }));
	assert.equal(config.errors.length, 0);
	assert.equal(config.rows.length, 87);
	// Both layers carry one refusal sentence, so a parser reads one format.
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(
		lines[0],
		`permission gate: refused ${planted}: a permission file inside a repository is ignored, so the shipped default stays in force`,
	);
	assert.ok(config.overlay.deny.every((rule) => rule.reason !== FENCE_REASON));
	assert.equal(verdict(compileRole(config.rows, "orchestrator"), "bash", "git push origin main"), "ask");
});

test("an override path inside a repository is refused and the shipped rows stay", () => {
	const repo = path.join(dir, "override-repo");
	mkdirSync(path.join(repo, ".git"), { recursive: true });
	const planted = path.join(repo, "permissions.table.json");
	writeFileSync(
		planted,
		JSON.stringify({ version: 1, patch: [{ id: "release.ask", verdict: "allow" }] }),
	);
	const { config, lines } = load(basePaths({ override: planted }));
	assert.equal(config.errors.length, 0);
	assert.equal(config.rows.length, 87);
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(
		lines[0],
		`permission gate: refused ${planted}: a permission file inside a repository is ignored, so the shipped default stays in force`,
	);
	assert.equal(verdict(compileRole(config.rows, "orchestrator"), "bash", "git push origin main"), "ask");
});

test("a relative table path is refused and the default stays in force", () => {
	const configured = path.join("relative", "permissions.table.json");
	const { config, lines } = load(basePaths({ table: configured }));
	assert.equal(config.errors.length, 0);
	// The table layer falls back to DEFAULT_TABLE_FILE, so the shipped rows load.
	assert.equal(config.rows.length, 87);
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(lines[0], refusalLine(configured, "table"));
	assert.ok(config.overlay.deny.every((rule) => rule.reason !== FENCE_REASON));
});

test("a relative override path is refused and the shipped rows stay", () => {
	const configured = path.join("relative", "permissions.table.json");
	const { config, lines } = load(basePaths({ override: configured }));
	assert.equal(config.errors.length, 0);
	// The override layer falls back to null, so no patch applies.
	assert.equal(config.rows.length, 87);
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.equal(lines[0], refusalLine(configured, "override"));
	assert.equal(verdict(compileRole(config.rows, "orchestrator"), "bash", "git push origin main"), "ask");
});

test("a symlinked table path that resolves inside a repository is refused", () => {
	const repo = path.join(dir, "symlink-table-repo");
	mkdirSync(path.join(repo, ".git"), { recursive: true });
	const planted = path.join(repo, "permissions.table.json");
	writeFileSync(planted, JSON.stringify({ version: 1, rows: [] }));
	const link = path.join(dir, "table-link.json");
	symlinkSync(planted, link);
	const { config, lines } = load(basePaths({ table: link }));
	assert.equal(config.errors.length, 0);
	assert.equal(config.rows.length, 87);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(planted), lines[0]);
	assert.ok(config.overlay.deny.every((rule) => rule.reason !== FENCE_REASON));
});

test("a symlinked override path that resolves inside a repository is refused", () => {
	const repo = path.join(dir, "symlink-override-repo");
	mkdirSync(path.join(repo, ".git"), { recursive: true });
	const planted = path.join(repo, "permissions.table.json");
	writeFileSync(
		planted,
		JSON.stringify({ version: 1, patch: [{ id: "release.ask", verdict: "allow" }] }),
	);
	const link = path.join(dir, "override-link.json");
	symlinkSync(planted, link);
	const { config, lines } = load(basePaths({ override: link }));
	assert.equal(config.errors.length, 0);
	assert.equal(config.rows.length, 87);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes(planted), lines[0]);
	assert.equal(verdict(compileRole(config.rows, "orchestrator"), "bash", "git push origin main"), "ask");
});

// --- the test hooks ---------------------------------------------------------

test("the environment hooks point the loader at fixtures", () => {
	const table = write("env-table.json", { version: 1, rows: [fixtureRow("env.row")] });
	const override = write("env-override.json", {
		version: 1,
		patch: [{ id: "env.row", verdict: "deny" }],
	});
	const saved = {
		table: process.env.PI_PERMISSIONS_TABLE,
		override: process.env.PI_PERMISSIONS_TABLE_OVERRIDE,
	};
	process.env.PI_PERMISSIONS_TABLE = table;
	process.env.PI_PERMISSIONS_TABLE_OVERRIDE = override;
	try {
		const { config, lines } = load({ overlay: OVERLAY });
		assert.deepEqual(lines, []);
		assert.equal(config.rows.length, 1);
		assert.equal(config.rows[0].id, "env.row");
		assert.equal(config.rows[0].verdict, "deny");
		assert.equal(config.rows[0].layer, "override");
	} finally {
		if (saved.table === undefined) delete process.env.PI_PERMISSIONS_TABLE;
		else process.env.PI_PERMISSIONS_TABLE = saved.table;
		if (saved.override === undefined) delete process.env.PI_PERMISSIONS_TABLE_OVERRIDE;
		else process.env.PI_PERMISSIONS_TABLE_OVERRIDE = saved.override;
	}
});
