/**
 * Tests for the journal write lock script: a refresh against a racing breaker.
 *
 * The case runs the real shipped script by absolute path, with the shared
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
	gateEnv,
	makeDateShim,
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
	startAsync,
	staleAgeOf,
	waitForMark,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

describe("E — refresh", () => {
	test("a refresh never buries a lock that another session took", async () => {
		const home = makeHome();
		// The gate opens on the read before refresh_lock, so the refresh has
		// already probed its own record when the other session takes the lock.
		const shim = makeDateShim(2);
		const mark = path.join(home, "refresh-marked");
		const release = path.join(home, "refresh-go");
		const sleepLog = path.join(home, "refresh-sleeps");
		const sleepShim = makeShimDir({
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
		});
		const gate = gateEnv(shim, mark, release);
		plantLock(home, recordText("aa", "aa-1", nowSeconds() - STALE_AGE));

		// The owner refreshes its own stale record; the epoch read waits until this
		// case releases it, so the other session breaks and takes the lock first.
		// One second bounds the loss, so the case does not pay the ten second default.
		const refresh = startAsync(
			home,
			["hold", "--agent", AGENT, "--session", "aa", "--timeout", "1"],
			{ ...gate, PATH: `${sleepShim}:${gate.PATH}`, SLEEP_LOG: sleepLog },
		);
		await waitForMark(mark);

		const breaker = run(home, ["hold", "--agent", AGENT, "--session", "bb"]);
		try {
			assert.equal(breaker.status, 0, breaker.stderr);
			assert.ok(staleAgeOf(breaker.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${breaker.stdout}`);
		} finally {
			// A red assertion must not leave the refresh waiting for the gate.
			fs.writeFileSync(release, "");
		}
		const refreshResult = await refresh;
		const refreshSleeps = fs.existsSync(sleepLog) ? rows(fs.readFileSync(sleepLog, "utf8")) : [];
		assert.deepEqual(refreshSleeps, [], `a refused refresh does not sleep: ${refreshSleeps.join(",")}`);
		assert.equal(refreshResult.status, 4, refreshResult.stderr);
		assert.match(refreshResult.stderr, /^held .* by bb since /m);
		assert.equal(recordOf(home).session, "bb");
		assert.equal(recordOf(home).token, rowOf(breaker.stdout, "token"));
	});
});
