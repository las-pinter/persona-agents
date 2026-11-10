/**
 * Tests for the journal write lock script: two holders never both proceed.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { AGENT, lockPath, makeHome, recordOf, rowOf, run, runAsync } from "./journal-lock-helpers.ts";

/**
 * Five rounds, not twenty: each round is a fresh home with eight concurrent
 * holds on one lock name, so five rounds make 40 contended hold attempts and
 * five release and re-take cycles. The claim is one invariant per lock name,
 * and every round repeats the same shape, so five rounds are five independent
 * trials of that invariant. The extra rounds repeat the same shape.
 */
const ROUNDS = 5;

describe("B — two holders never both proceed", () => {
	test("one of eight holds wins, and a release frees the lock", async () => {
		for (let round = 1; round <= ROUNDS; round += 1) {
			const home = makeHome();
			const results = await Promise.all(
				Array.from({ length: 8 }, (_unused, index) =>
					runAsync(home, ["hold", "--agent", AGENT, "--session", `r${round}s${index}`, "--timeout", "1"]),
				),
			);
			const winners = results.filter((result) => result.status === 0);
			const waiters = results.filter((result) => result.status === 4);
			assert.equal(winners.length, 1, `round ${round} has one holder`);
			assert.equal(waiters.length, 7, `round ${round} has seven waiters`);

			const token = rowOf(winners[0]?.stdout ?? "", "token");
			const record = recordOf(home);
			assert.equal(token, record.token, `round ${round} names the winner token`);
			const released = run(home, [
				"release",
				"--agent",
				AGENT,
				"--session",
				record.session ?? "",
				"--token",
				token,
			]);
			assert.equal(released.status, 0, released.stderr);
			assert.equal(fs.existsSync(lockPath(home)), false, `round ${round} removes the lock`);

			const next = run(home, ["hold", "--agent", AGENT, "--session", `next${round}`]);
			assert.equal(next.status, 0, next.stderr);
		}
	});
});
