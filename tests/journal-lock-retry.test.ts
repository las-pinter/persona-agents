/**
 * Tests for the journal write lock script: a retry poll sleeps before it re-probes.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 * The sleep shim records every poll, so a removed sleep turns the case red.
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
	countingCksum,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	realToolPath,
	recordOf,
	recordText,
	rows,
	run,
	shimPath,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

describe("C — a dead holder is broken", () => {
	test("a stale retry sleeps before the next poll", () => {
		const home = makeHome();
		const sleepLog = path.join(home, "sleeps");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// Every digest read differs, so the break never wins and the caller takes
		// the retry turn. The sleep body marks the turn, so a missing sleep is red.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), false),
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog },
			20000,
		);

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.equal(
			fs.existsSync(sleepLog),
			true,
			"the stale retry slept before the next poll",
		);
		assert.ok(rows(fs.readFileSync(sleepLog, "utf8")).length >= 1, "the stale retry made one sleep");
	});

	test("an incomplete retry sleeps before the next poll", () => {
		const home = makeHome();
		const sleepLog = path.join(home, "sleeps");
		plantLock(home, "agent orchestrator\nsession dead\n");
		// The incomplete break never wins, so the caller takes the retry turn.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), false),
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog },
			20000,
		);

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.equal(fs.existsSync(sleepLog), true, "the incomplete retry slept before the next poll");
		assert.ok(rows(fs.readFileSync(sleepLog, "utf8")).length >= 1, "the incomplete retry made one sleep");
	});

	test("an absent-name retry sleeps before the next poll", () => {
		const home = makeHome();
		const sleepLog = path.join(home, "sleeps");
		const lnMark = path.join(home, "ln-count");
		const catMark = path.join(home, "cat-count");
		// The first create loses to a name another writer makes, and the first lock
		// read then finds the name gone. So the caller takes the absent-name retry
		// turn and the second create wins. The sleep marks that turn, so a removed
		// sleep leaves no row while the run still holds the lock.
		const shim = makeShimDir({
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
			ln: [
				"#!/usr/bin/env bash",
				'if [ -f "$LN_MARK" ]; then',
				`  exec ${realToolPath("ln")} "$@"`,
				"fi",
				': >"$LN_MARK"',
				'args=("$@")',
				'target="${args[${#args[@]}-1]}"',
				'printf "agent orchestrator\\nsession boss\\ntoken boss-1\\nat %s\\nhost test-host\\n" "$(date +%s)" >"$target"',
				"exit 1",
			].join("\n"),
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ] && [ -f "$target" ] && [ ! -f "$CAT_MARK" ]; then',
				'  : >"$CAT_MARK"',
				'  rm -f -- "$target"',
				"  exit 1",
				"fi",
				`exec ${realToolPath("cat")} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "30"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog, LN_MARK: lnMark, CAT_MARK: catMark },
			15000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.equal(recordOf(home).session, SESSION, "the caller owns the lock");
		assert.equal(fs.existsSync(sleepLog), true, "the absent-name retry slept before the next poll");
		assert.deepEqual(
			rows(fs.readFileSync(sleepLog, "utf8")),
			["0.050"],
			"the absent-name retry sleeps the fast poll width, not a whole second",
		);
	});
});
