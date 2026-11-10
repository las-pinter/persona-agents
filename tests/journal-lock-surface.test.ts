/**
 * Tests for the journal write lock script: the documented surface.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT, SESSION, journalsDir, makeHome, rows, run, runRaw } from "./journal-lock-helpers.ts";

describe("the documented surface", () => {
	test("the removed subcommands exit 1 with one error line", () => {
		const home = makeHome();
		for (const removed of ["append", "check", "replace"]) {
			const result = run(home, [removed, "--agent", AGENT]);
			assert.equal(result.status, 1, `${removed}: ${result.stderr}`);
			assert.equal(rows(result.stderr).length, 1, `${removed} prints one line: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, removed);
			assert.equal(result.stdout, "");
		}
	});

	test("the help text names the two subcommands and the five flags", () => {
		const home = makeHome();
		const result = runRaw(["--help"], home);
		assert.equal(result.status, 0, result.stderr);
		for (const word of ["hold", "release", "--agent", "--session", "--token", "--home", "--timeout"]) {
			assert.ok(result.stdout.includes(word), `the help text names ${word}`);
		}
		for (const gone of ["append", "check", "replace", "--file"]) {
			assert.equal(result.stdout.includes(gone), false, `the help text must not name ${gone}`);
		}
		for (const code of ["0", "1", "2", "3", "4", "5"]) {
			assert.match(result.stdout, new RegExp(`^  ${code} `, "m"), `the help text names exit ${code}`);
		}
	});

	test("a usage error exits 1", () => {
		const home = makeHome();
		const cases: string[][] = [
			["hold", "--agent", AGENT],
			["hold", "--session", SESSION],
			["hold", "--agent", AGENT, "--session", SESSION, "--nope", "x"],
			["hold", "--agent", AGENT, "--session", SESSION, "positional"],
			["hold", "--agent", AGENT, "--agent", AGENT, "--session", SESSION],
			["hold", "--agent", AGENT, "--session"],
			["hold", "--agent", AGENT, "--session", SESSION, "--token", "abc"],
			["release", "--agent", AGENT, "--session", SESSION],
		];
		for (const args of cases) {
			const result = run(home, args);
			assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, args.join(" "));
		}
	});

	test("a bad value exits 2", () => {
		const home = makeHome();
		const cases: string[][] = [
			["hold", "--agent", "Orchestrator", "--session", SESSION],
			["hold", "--agent", AGENT, "--session", "has space"],
			["hold", "--agent", AGENT, "--session", "x".repeat(65)],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "0"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "121"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "soon"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "-1"],
			["hold", "--agent", AGENT, "--session", "-x"],
			["release", "--agent", AGENT, "--session", SESSION, "--token", "x".repeat(81)],
		];
		for (const args of cases) {
			const result = run(home, args);
			assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, args.join(" "));
		}
		const relative = runRaw(["hold", "--agent", AGENT, "--session", SESSION, "--home", "relative"], home);
		assert.equal(relative.status, 2, relative.stderr);
	});

	test("a journals path that cannot be a folder exits 3", () => {
		const home = makeHome();
		fs.mkdirSync(path.join(home, "agent-notes", AGENT), { recursive: true });
		fs.writeFileSync(journalsDir(home), "not a folder");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 3, result.stderr);
		assert.match(result.stderr, /^Error: lock folder create failed: /);
	});
});
