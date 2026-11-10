/**
 * Tests for the journal write lock script: release ownership.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { AGENT, SESSION, claimNames, lockPath, makeHome, makeShimDir, rowOf, rows, run, shimPath } from "./journal-lock-helpers.ts";

describe("D — release ownership", () => {
	test("a wrong token keeps the lock and a good token removes it", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");

		const wrong = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", `${token}x`]);
		assert.equal(wrong.status, 5, wrong.stderr);
		assert.equal(rowOf(wrong.stderr, "lock lost"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), true);

		const second = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", `${token}x`]);
		assert.equal(second.status, 5, second.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);

		const good = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(good.status, 0, good.stderr);
		assert.equal(rowOf(good.stdout, "released"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), false);

		const gone = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(gone.status, 5, gone.stderr);
	});

	test("a release claim failure with the record still present exits 3", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");
		// The move fails and leaves the source in place, as an IO fault does.
		const shim = makeShimDir({ mv: ["#!/usr/bin/env bash", "exit 1"].join("\n") });

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", token],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock release claim failed/m);
		assert.equal(fs.existsSync(lockPath(home)), true, "the lock stays in place");
		assert.equal(claimNames(home).length, 0, "the failed claim temp is removed");
	});

	test("another session and another agent never release the lock", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");

		const otherSession = run(home, ["release", "--agent", AGENT, "--session", "other", "--token", token]);
		assert.equal(otherSession.status, 5, otherSession.stderr);
		const otherAgent = run(home, ["release", "--agent", "tester", "--session", SESSION, "--token", token]);
		assert.equal(otherAgent.status, 5, otherAgent.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);
	});
});
