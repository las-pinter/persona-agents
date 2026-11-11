/**
 * Tests for the journal write lock script: refresh of a lock this session holds.
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
import {
	AGENT,
	SESSION,
	fixedClockShim,
	lockPath,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	realToolPath,
	recordOf,
	recordText,
	rowOf,
	rows,
	run,
	shimPath,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

describe("E — refresh", () => {
	test("a second hold from the same session keeps the token and moves at", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		// The clock shim answers the epoch from a clock file, so the second hold
		// reads a later second without a timer wait.
		const shim = makeShimDir({ date: fixedClockShim() });
		const env = { ...shimPath(shim), CLOCK: clock };

		const first = run(home, ["hold", "--agent", AGENT, "--session", SESSION], env);
		assert.equal(first.status, 0, first.stderr);
		const token = rowOf(first.stdout, "token");
		const at = rowOf(first.stdout, "at");
		const deadline = rowOf(first.stdout, "deadline");
		const before = recordOf(home).at;

		fs.writeFileSync(clock, `${start + 1}\n`);
		const second = run(home, ["hold", "--agent", AGENT, "--session", SESSION], env);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(rowOf(second.stdout, "token"), token);
		assert.notEqual(rowOf(second.stdout, "at"), at);
		assert.notEqual(rowOf(second.stdout, "deadline"), deadline);
		assert.equal(recordOf(home).token, token);
		assert.ok(Number(recordOf(home).at) > Number(before), "the refresh moves the at field");
		assert.equal(Number(recordOf(home).at), start + 1, "the at field is the second clock read");
	});

	test("a refresh whose re-probe finds the name gone creates once", () => {
		const home = makeHome();
		plantLock(home, recordText(SESSION, `${SESSION}-old`, nowSeconds()));
		const realCat = realToolPath("cat");
		// The failed move leaves the record at the name. The second lock read then
		// removes it, so held_fail creates instead of returning to the claim compare.
		const shim = makeShimDir({
			mv: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ]; then',
				'  now=0',
				'  if [ -f "$CAT_COUNT" ]; then now=$(cat "$CAT_COUNT"); fi',
				'  now=$((now + 1))',
				'  printf "%s\\n" "$now" >"$CAT_COUNT"',
				'  if [ "$now" -ge 2 ]; then',
				'    rm -f -- "$target"',
				"    exit 1",
				"  fi",
				"fi",
				`exec ${realCat} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION],
			{ ...shimPath(shim), CAT_COUNT: path.join(home, "cat-count") },
			15000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.match(rowOf(result.stdout, "token"), new RegExp(`^${SESSION}-\\d+$`), result.stdout);
		assert.notEqual(rowOf(result.stdout, "token"), `${SESSION}-old`);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("an old token exits 5 after another session breaks the lock", () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(first.status, 0, first.stderr);
		const token = rowOf(first.stdout, "token");

		// Age the held record past the TTL, so the next hold breaks it as stale.
		const record = recordOf(home);
		fs.writeFileSync(lockPath(home), recordText(SESSION, record.token ?? token, nowSeconds() - STALE_AGE));

		const other = run(home, ["hold", "--agent", AGENT, "--session", "other"]);
		assert.equal(other.status, 0, other.stderr);
		const lost = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(lost.status, 5, lost.stderr);
		assert.equal(rowOf(lost.stderr, "lock lost"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), true);
	});
});
