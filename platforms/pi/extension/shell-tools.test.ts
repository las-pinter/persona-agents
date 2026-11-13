/**
 * One duty: guard the shell tool class against a second copy of a name.
 *
 * `shell-tools.ts` owns the class. A module that hard-codes a shell tool name
 * can test for one spelling only, so the gate runs the second shell tool as a
 * plain tool call and no error shows. The scan below fails when a module holds
 * such a name outside the exemption table. Test files are not scanned: an
 * assertion may name a tool, a module may not.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { SHELL_PROBES } from "./shell-tools.ts";

interface ModuleSource {
	name: string;
	text: string;
}

interface Exemption {
	file: string;
	lines: string;
	reason: string;
}

/** The shell tool name that the positive control plants. */
const CONTROL_NAME = "powershell";

/** The quote pair that can hold a name: double, single, and template. */
const QUOTES = ['"', "'", "`"] as const;

/**
 * The quote forms the positive control plants. Kept apart from `QUOTES` on
 * purpose: a control that reads the scanner's own list cannot fail.
 */
const CONTROL_QUOTES = ['"', "'", "`"] as const;

/**
 * Every module that holds a shell tool name today. A `lines` value names only
 * the lines that hold a quoted name, so no reader is sent to a bare line. The
 * numbers are the ones this commit measured; a moved name needs a new number.
 */
const EXEMPT: readonly Exemption[] = [
	{ file: "shell-tools.ts", lines: "14", reason: "the owner of the shell tool class" },
	{ file: "child-tools.ts", lines: "93, 94, 266, 271", reason: "the host tool definition list and its wrapper switch" },
	{ file: "permission-table.ts", lines: "384", reason: "the row refusal for a bash row" },
	{ file: "permission-table.parity.ts", lines: "77 to 100", reason: "the legacy row ledger of shipped patterns" },
	{ file: "permission-table.test-helpers.ts", lines: "117, 140, 154", reason: "the test path's row keys" },
	{ file: "permissions.ts", lines: "94", reason: "names the script interpreter program, not a tool" },
	{ file: "gate-child-ask-fixture.ts", lines: "166, 167, 171, 260, 266, 270", reason: "child ask test data" },
	{ file: "tree-ui-fixtures.ts", lines: "154", reason: "tree render test data" },
	{ file: "subagent-render-fixtures.ts", lines: "105", reason: "subagent render test data" },
];

/** True when the line opens a comment, so a documented name is not a copy. */
function opensComment(line: string): boolean {
	return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/**
 * The names of the modules that hold a shell tool name in a quoted literal.
 * Reads no file, so a caller can pass a synthetic module.
 */
function scanShellToolNames(files: readonly ModuleSource[]): string[] {
	const names = [...SHELL_PROBES.keys()];
	const offenders: string[] = [];
	for (const file of files) {
		const holds = file.text.split("\n").some((line) => {
			if (opensComment(line)) return false;
			return names.some((name) => QUOTES.some((quote) => line.includes(`${quote}${name}${quote}`)));
		});
		if (holds) offenders.push(file.name);
	}
	return offenders;
}

/** Every module in the extension folder, test files left out. */
function moduleSources(): ModuleSource[] {
	const dir = new URL(".", import.meta.url);
	const names = readdirSync(dir)
		.map((name) => String(name))
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
	return names.map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));
}

test("no module holds a shell tool name outside the exemption table", () => {
	const exempt = new Set(EXEMPT.map((row) => row.file));
	const offenders = scanShellToolNames(moduleSources()).filter((name) => !exempt.has(name));
	assert.deepEqual(offenders, [], `a second shell tool name lives in ${offenders.join(", ")}`);
});

test("the scan reports a planted shell tool name in every quote form", () => {
	for (const quote of CONTROL_QUOTES) {
		const planted: ModuleSource = {
			name: "new-consumer.ts",
			text: `const tool = ${quote}${CONTROL_NAME}${quote};\n`,
		};
		assert.deepEqual(scanShellToolNames([planted]), ["new-consumer.ts"], `the ${quote} form passed unseen`);
	}
});

test("the folder read returns the real module set, not an empty one", () => {
	const files = moduleSources();
	assert.ok(files.length >= 60, `the folder read returned ${files.length} modules`);
	for (const file of files) {
		assert.ok(file.name.endsWith(".ts"), `${file.name} is not a module name`);
		assert.ok(file.text.length > 0, `${file.name} read as an empty text`);
	}
	const present = new Set(files.map((file) => file.name));
	const missing = EXEMPT.filter((row) => !present.has(row.file)).map((row) => row.file);
	assert.deepEqual(missing, [], `the folder read missed the exempt module ${missing.join(", ")}`);
});

test("every exemption row carries a reason of at least three words", () => {
	for (const row of EXEMPT) {
		const words = row.reason.trim().split(/\s+/).filter((word) => word.length > 0);
		assert.ok(words.length >= 3, `${row.file} carries no reason`);
		assert.ok(row.lines.trim().length > 0, `${row.file} carries no line number`);
	}
	const owners = EXEMPT.filter((row) => row.reason.includes("the owner"));
	assert.deepEqual(owners.map((row) => row.file), ["shell-tools.ts"]);
});
