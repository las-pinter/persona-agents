/**
 * Tests for the journal write lock script: a dead holder is broken.
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
	claimNames,
	countingCksum,
	fixedClockShim,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	prevPath,
	realToolPath,
	recordOf,
	recordText,
	rowOf,
	run,
	shimPath,
	steppingSleepShim,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

describe("C — a dead holder is broken", () => {
	test("a record past the TTL is broken and kept in the prev file", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		const lock = plantLock(home, recordText("dead-session", "dead-session-4242", start - STALE_AGE));
		// The clock shim answers the epoch from a clock file, so the age is exact
		// and no wall clock reaches the assert.
		const shim = makeShimDir({ date: fixedClockShim() });

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], {
			...shimPath(shim),
			CLOCK: clock,
		});
		assert.equal(result.status, 0, result.stderr);

		const match = /^(.*) age (\d+)s$/.exec(rowOf(result.stdout, "stale"));
		assert.ok(match, `the stale row names the lock and the age: ${result.stdout}`);
		assert.equal(match[1], lock);
		assert.equal(Number(match[2]), STALE_AGE, `the age is the fixed clock gap: ${result.stdout}`);

		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("a failed claim remove keeps the name for the exit trap", () => {
		const home = makeHome();
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// The first claim remove fails, so the slot must stay set for the trap to
		// retry it. The second attempt forwards to the real tool and succeeds.
		const shim = makeShimDir({
			rm: [
				"#!/usr/bin/env bash",
				'case " $* " in',
				'  *".journal-write.claim."*)',
				'    if [ ! -f "$RM_SEEN" ]; then : >"$RM_SEEN"; exit 1; fi',
				"    ;;",
				"esac",
				`exec ${realToolPath("rm")} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION],
			{ ...shimPath(shim), RM_SEEN: path.join(home, "rm-seen") },
		);

		assert.equal(result.status, 0, `the failed remove keeps the hold status: ${result.stderr}`);
		assert.match(result.stdout, /^stale /m, `the stale record is broken: ${result.stdout}`);
		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
		assert.equal(recordOf(home).session, SESSION);
		assert.equal(fs.existsSync(path.join(home, "rm-seen")), true, "the remove failed once");
		assert.deepEqual(claimNames(home), [], "the trap names the claim again and removes it");
	});

	test("an empty lock file is stale at age 0", () => {
		const home = makeHome();
		plantLock(home, "");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(rowOf(result.stdout, "stale"), / age 0s$/);
		assert.equal(fs.existsSync(prevPath(home)), true);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("an incomplete record is stale at age 0", () => {
		const home = makeHome();
		plantLock(home, "agent orchestrator\nsession dead\n");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(rowOf(result.stdout, "stale"), / age 0s$/);
		assert.equal(recordOf(home).token.startsWith(`${SESSION}-`), true);
	});

	test("a break that never wins ends at the timeout", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		plantLock(home, recordText("dead-session", "dead-session-4242", start - STALE_AGE));
		// Every digest read differs from the last, so the claim never equals the
		// probe and the break never wins. The date shim answers the epoch from a
		// clock file and the sleep shim moves that clock one second, so the poll
		// count measures the wait bound without a wall clock.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), false),
			date: fixedClockShim(),
			sleep: steppingSleepShim(),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), CLOCK: clock },
			20000,
		);
		const waited = Number(fs.readFileSync(clock, "utf8").trim()) - start;

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.ok(waited >= 3, `the hold waits at least the timeout, got ${waited}`);
		assert.ok(waited <= 4, `the hold ends within the timeout plus one poll, got ${waited}`);
		assert.match(result.stderr, /^held .* by dead-session since /m);
		assert.equal(recordOf(home).session, "dead-session", "the unbroken record stays");
	});

	test("a hold ends within the timeout bound plus one poll", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		plantLock(home, recordText("other-session", "other-session-1", start));
		// The date shim answers the epoch from a clock file and the sleep shim moves
		// that clock one second, so the poll count measures the wait bound.
		const shim = makeShimDir({
			date: fixedClockShim(),
			sleep: steppingSleepShim(),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), CLOCK: clock },
			20000,
		);
		const waited = Number(fs.readFileSync(clock, "utf8").trim()) - start;

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.ok(waited >= 3, `the hold waits at least the timeout, got ${waited}`);
		assert.ok(waited <= 4, `the hold ends within the timeout plus one poll, got ${waited}`);
	});
});
