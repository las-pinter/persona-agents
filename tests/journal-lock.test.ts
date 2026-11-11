/**
 * Tests for the journal write lock script under the date gate.
 *
 * The two cases here hold one run at its first epoch read, so a second run
 * enters the race window. Every case runs the real shipped script by absolute
 * path, with the shared scaffolding in journal-lock-helpers.ts and a throw-away
 * home under os.tmpdir().
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
	gateEnv,
	makeDateShim,
	makeHome,
	nowSeconds,
	plantLock,
	prevPath,
	recordOf,
	recordText,
	rowOf,
	run,
	startAsync,
	staleAgeOf,
	waitForMark,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

describe("C — a dead holder is broken", () => {
	test("two breakers on one stale record leave exactly one holder", async () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "slow-breaker-marked");
		const release = path.join(home, "slow-breaker-go");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		// The slow breaker waits at its first epoch read before any probe.
		// This case releases it, so the fast breaker breaks and creates first.
		const slow = startAsync(
			home,
			["hold", "--agent", AGENT, "--session", "slow", "--timeout", "1"],
			gateEnv(shim, mark, release),
		);
		await waitForMark(mark);

		const fast = run(home, ["hold", "--agent", AGENT, "--session", "fast", "--timeout", "1"]);
		try {
			assert.equal(fast.status, 0, fast.stderr);
			assert.ok(staleAgeOf(fast.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${fast.stdout}`);
			assert.equal(recordOf(home).session, "fast");
		} finally {
			// A red assertion must not leave the slow breaker waiting for the gate.
			fs.writeFileSync(release, "");
		}
		const slowResult = await slow;
		assert.equal(slowResult.status, 4, slowResult.stderr);
		assert.match(slowResult.stderr, /^held .* by fast since /m);
		assert.equal(recordOf(home).session, "fast");
		assert.equal(recordOf(home).token, rowOf(fast.stdout, "token"));
		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
	});

	test("a date shim with no release variable never waits", () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "gate-marked");
		const waitLog = path.join(home, "gate-waits");
		// The shim marks every gate read and logs every wait turn it enters. An
		// empty release leaves the wait log absent, so the case reads the wait and
		// not the wall clock.
		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], {
			...gateEnv(shim, mark, ""),
			JOURNAL_GATE_WAIT_LOG: waitLog,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.existsSync(mark), true, "the gate read ran");
		assert.equal(fs.existsSync(waitLog), false, "the gate never waited");
	});
});
