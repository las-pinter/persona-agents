/**
 * Tests for the journal write lock script: a held lock blocks a second caller.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { AGENT, SESSION, lockPath, makeHome, recordOf, rowOf, run, runRaw } from "./journal-lock-helpers.ts";

describe("A — a held lock blocks", () => {
	test("a second hold with a short timeout reports the holder", () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", "first"]);
		assert.equal(first.status, 0, first.stderr);
		assert.equal(rowOf(first.stdout, "lock"), lockPath(home));
		assert.ok(rowOf(first.stdout, "token").startsWith("first-"), first.stdout);
		assert.match(rowOf(first.stdout, "at"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		assert.match(rowOf(first.stdout, "deadline"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

		const second = run(home, ["hold", "--agent", AGENT, "--session", "second", "--timeout", "1"]);
		assert.equal(second.status, 4, second.stderr);
		assert.match(second.stderr, /^held .* by first since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
		assert.equal(recordOf(home).session, "first");
	});

	test("the documented lock path comes from the default home", () => {
		const home = makeHome();
		const result = runRaw(["hold", "--agent", AGENT, "--session", SESSION], home);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);
	});
});
