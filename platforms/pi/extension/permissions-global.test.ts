/**
 * Tests for the live global permission file loader.
 *
 *   node --experimental-strip-types --test \
 *     platforms/pi/extension/permissions-global.test.ts
 *
 * The global deny and ask rules are the hard floor under every agent, so a
 * malformed or unreadable file must never yield an empty fence. The test
 * injects its own file in a temporary directory, so the real home file is
 * never read.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { evaluateCommandRules, type RuleSets } from "./command-segments.ts";
import { loadGlobalRules } from "./permissions.ts";

/** One throwaway directory per run. No test carries a real home path. */
const dir = mkdtempSync(path.join(tmpdir(), "global-permissions-"));

type GlobalRules = ReturnType<typeof loadGlobalRules>;

function writeFile(name: string, text: string): string {
	const file = path.join(dir, name);
	writeFileSync(file, text);
	return file;
}

/** Run the loader and capture the log lines it writes. */
function load(file: string): { rules: GlobalRules; lines: string[] } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((value) => String(value)).join(" "));
	};
	try {
		return { rules: loadGlobalRules(file), lines };
	} finally {
		console.error = original;
	}
}

/**
 * The verdict the engine reaches for one tool call under the loaded fence.
 * `allow-unless-matched` is Pi's default mode, so an empty fence reads as
 * `allow` and a fail-closed fence reads as `deny`.
 */
function verdict(rules: GlobalRules, tool: string, probe: string): string {
	const sets: RuleSets = {
		globalDeny: rules.deny,
		globalAsk: rules.ask,
		agentDeny: [],
		agentAsk: [],
		agentAllow: [],
	};
	const decision = evaluateCommandRules(probe, tool === "bash", sets, "allow-unless-matched", tool, null, {});
	return decision.kind;
}

test("a malformed global file fails loudly and keeps the fence closed", () => {
	const file = writeFile("malformed.json", '{ "deny": [ }');
	const { rules, lines } = load(file);
	assert.equal(lines.length, 1, "the fault is reported in one line");
	assert.ok(lines[0].includes(file), `the line must name the file: ${lines[0]}`);
	assert.ok(rules.deny.length > 0, "a malformed file must not empty the fence");
	assert.equal(verdict(rules, "bash", "git status"), "deny");
	assert.equal(verdict(rules, "read", "/fixture/notes.txt"), "deny");
});

test("a missing global file fails loudly and keeps the fence closed", () => {
	const file = path.join(dir, "absent.json");
	assert.equal(existsSync(file), false);
	const { rules, lines } = load(file);
	assert.equal(lines.length, 1, "the fault is reported in one line");
	assert.ok(lines[0].includes(file), `the line must name the file: ${lines[0]}`);
	assert.ok(rules.deny.length > 0, "a missing file must not empty the fence");
	assert.equal(verdict(rules, "bash", "ls"), "deny");
});

test("a global file whose sections are not lists fails loudly", () => {
	const file = writeFile("shape.json", JSON.stringify({ deny: "all" }));
	const { rules, lines } = load(file);
	assert.equal(lines.length, 1, "the fault is reported in one line");
	assert.ok(rules.deny.length > 0, "a wrong shape must not empty the fence");
	assert.equal(verdict(rules, "bash", "git status"), "deny");
});

test("a readable global file loads its rules and logs nothing", () => {
	const file = writeFile(
		"valid.json",
		JSON.stringify({ deny: [{ tool: "bash", match: "\\brm\\b" }], ask: [] }),
	);
	const { rules, lines } = load(file);
	assert.deepEqual(lines, [], "a readable file is not a fault");
	assert.equal(rules.deny.length, 1);
	assert.equal(verdict(rules, "bash", "rm notes.txt"), "deny");
	assert.equal(verdict(rules, "bash", "ls"), "allow");
});
