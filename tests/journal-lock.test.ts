/**
 * Tests for the journal write lock script: hold, refresh, and release.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 * This file pins one script's contract, which is why it sits in the 501-1000 band.
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
	gateEnv,
	journalsDir,
	lockPath,
	makeDateShim,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	prevPath,
	realToolPath,
	recordOf,
	recordText,
	rowOf,
	rows,
	run,
	runAsync,
	runRaw,
	settle,
	shimPath,
	staleAgeOf,
	startAsync,
	waitForMark,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

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

describe("B — two holders never both proceed", () => {
	test("one of eight holds wins, and a release frees the lock", async () => {
		for (let round = 1; round <= 20; round += 1) {
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

describe("C — a dead holder is broken", () => {
	test("a record past the TTL is broken and kept in the prev file", () => {
		const home = makeHome();
		const lock = plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);

		const match = /^(.*) age (\d+)s$/.exec(rowOf(result.stdout, "stale"));
		assert.ok(match, `the stale row names the lock and the age: ${result.stdout}`);
		assert.equal(match[1], lock);
		const age = Number(match[2]);
		assert.ok(
			age >= STALE_AGE && age <= STALE_AGE + 30,
			`the age meets the floor and stays under the widened ceiling, got ${age}`,
		);

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
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// Every digest read differs from the last, so the claim never equals the
		// probe and the break never wins.
		const shim = makeShimDir({ cksum: countingCksum(realToolPath("cksum"), false) });

		const started = Date.now();
		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			shimPath(shim),
			20000,
		);
		const elapsed = Date.now() - started;
		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.ok(elapsed < 10000, `the wait is bounded, took ${elapsed} ms`);
		assert.match(result.stderr, /^held .* by dead-session since /m);
		assert.equal(recordOf(home).session, "dead-session", "the unbroken record stays");
	});

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

		const startMs = Date.now();
		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog },
			20000,
		);

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.equal(
			fs.existsSync(sleepLog),
			true,
			`the stale retry slept before the next poll; elapsed ${Date.now() - startMs} ms`,
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
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
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
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog, LN_MARK: lnMark, CAT_MARK: catMark },
			15000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.equal(recordOf(home).session, SESSION, "the caller owns the lock");
		assert.equal(fs.existsSync(sleepLog), true, "the absent-name retry slept before the next poll");
		assert.equal(rows(fs.readFileSync(sleepLog, "utf8")).length, 1, "the absent-name retry made one sleep");
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
			date: [
				"#!/usr/bin/env bash",
				'for arg in "$@"; do',
				'  if [ "$arg" = "+%s" ]; then',
				'    cat "$CLOCK"',
				"    exit 0",
				"  fi",
				"done",
				`exec ${realToolPath("date")} "$@"`,
			].join("\n"),
			sleep: [
				"#!/usr/bin/env bash",
				'now=$(cat "$CLOCK")',
				'printf "%s\\n" "$((now + 1))" >"$CLOCK"',
			].join("\n"),
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

	test("two breakers on one stale record leave exactly one holder", async () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "slow-breaker-marked");
		const release = path.join(home, "slow-breaker-go");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		// The slow breaker probes at once, then waits inside its epoch read until
		// this case releases it, so the fast breaker breaks and creates first.
		const slow = startAsync(
			home,
			["hold", "--agent", AGENT, "--session", "slow", "--timeout", "1"],
			gateEnv(shim, mark, release),
		);
		await waitForMark(mark);

		const fast = run(home, ["hold", "--agent", AGENT, "--session", "fast", "--timeout", "1"]);
		assert.equal(fast.status, 0, fast.stderr);
		assert.ok(staleAgeOf(fast.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${fast.stdout}`);
		assert.equal(recordOf(home).session, "fast");

		fs.writeFileSync(release, "");
		const slowResult = await slow;
		assert.equal(slowResult.status, 4, slowResult.stderr);
		assert.match(slowResult.stderr, /^held .* by fast since /m);
		assert.equal(recordOf(home).session, "fast");
		assert.equal(recordOf(home).token, rowOf(fast.stdout, "token"));
		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
	});
});

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

describe("E — refresh", () => {
	test("a second hold from the same session keeps the token and moves at", async () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(first.status, 0, first.stderr);
		const token = rowOf(first.stdout, "token");
		const at = rowOf(first.stdout, "at");
		const deadline = rowOf(first.stdout, "deadline");
		const before = recordOf(home).at;

		await settle(1100);
		const second = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(rowOf(second.stdout, "token"), token);
		assert.notEqual(rowOf(second.stdout, "at"), at);
		assert.notEqual(rowOf(second.stdout, "deadline"), deadline);
		assert.equal(recordOf(home).token, token);
		assert.ok(Number(recordOf(home).at) > Number(before), "the refresh moves the at field");
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

	test("a refresh never buries a lock that another session took", async () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "refresh-marked");
		const release = path.join(home, "refresh-go");
		plantLock(home, recordText("aa", "aa-1", nowSeconds() - STALE_AGE));

		// The owner refreshes its own stale record; the epoch read waits until this
		// case releases it, so the other session breaks and takes the lock first.
		const refresh = startAsync(
			home,
			["hold", "--agent", AGENT, "--session", "aa"],
			gateEnv(shim, mark, release),
		);
		await waitForMark(mark);

		const breaker = run(home, ["hold", "--agent", AGENT, "--session", "bb"]);
		assert.equal(breaker.status, 0, breaker.stderr);
		assert.ok(staleAgeOf(breaker.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${breaker.stdout}`);

		fs.writeFileSync(release, "");
		const refreshResult = await refresh;
		assert.equal(refreshResult.status, 4, refreshResult.stderr);
		assert.match(refreshResult.stderr, /^held .* by bb since /m);
		assert.equal(recordOf(home).session, "bb");
		assert.equal(recordOf(home).token, rowOf(breaker.stdout, "token"));
	});
});

describe("F — a record that goes away mid-call", () => {
	test("a failed restore drops the claim once the prev copy holds the bytes", () => {
		const home = makeHome();
		const plant = recordText(SESSION, `${SESSION}-1`, nowSeconds());
		plantLock(home, plant);
		// The first digest read answers the planted bytes and every later read
		// another value, so the claim compare sees a changed record. `ln` always
		// fails, so the record cannot go back to the lock name.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), true),
			ln: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
		});

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", `${SESSION}-1`],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock restore failed/m);
		assert.equal(result.stderr.includes(prevPath(home)), true, `the error names the prev copy: ${result.stderr}`);
		assert.equal(result.stderr.split(prevPath(home)).length - 1, 1, `the error names the prev copy once: ${result.stderr}`);
		assert.equal(fs.readFileSync(prevPath(home), "utf8"), plant);
		assert.equal(claimNames(home).length, 0, "the prev copy lets the claim go");
	});

	test("a failed restore keeps the claim when the prev copy fails and names it", () => {
		const home = makeHome();
		const plant = recordText(SESSION, `${SESSION}-1`, nowSeconds());
		plantLock(home, plant);
		// The link and the prev copy both fail, so the claim is the only copy left.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), true),
			ln: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
			cp: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
		});

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", `${SESSION}-1`],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock restore failed/m);
		const claimed = /\/\S*\/\.journal-write\.claim\.[A-Za-z0-9]+/.exec(result.stderr);
		assert.ok(claimed, `the error names the kept claim: ${result.stderr}`);
		assert.equal(claimed[0].startsWith(journalsDir(home)), true, claimed[0]);
		assert.equal(result.stderr.split(claimed[0]).length - 1, 1, `the error names the claim once: ${result.stderr}`);
		assert.equal(fs.readFileSync(claimed[0], "utf8"), plant);
		assert.equal(claimNames(home).length, 1, "the claimed record stays on disk");
		assert.equal(fs.existsSync(prevPath(home)), false, "the failed copy leaves no prev file");
		assert.equal(result.stderr.includes(lockPath(home)), false, "the error does not name the lock");
	});

	test("a record that goes away before the read is absent, not an IO fault", () => {
		const home = makeHome();
		const realCat = realToolPath("cat");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// The first read of the lock name removes it and fails, so the name is gone
		// between the exist test and the read.
		const shim = makeShimDir({
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ] && [ -f "$target" ]; then',
				'  rm -f -- "$target"',
				"  exit 1",
				"fi",
				`exec ${realCat} "$@"`,
			].join("\n"),
		});

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], shimPath(shim), 15000);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(recordOf(home).session, SESSION, "the caller creates the lock");
	});

	test("a vanished record at the re-probe is created, not reported incomplete", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		const lock = plantLock(home, recordText("other-session", "other-session-1", start));
		// The live holder drops its record during the wait and the clock reaches
		// the deadline, so the re-probe finds a free name and the caller creates.
		const shim = makeShimDir({
			date: [
				"#!/usr/bin/env bash",
				'for arg in "$@"; do',
				'  if [ "$arg" = "+%s" ]; then',
				'    cat "$CLOCK"',
				"    exit 0",
				"  fi",
				"done",
				`exec ${realToolPath("date")} "$@"`,
			].join("\n"),
			sleep: [
				"#!/usr/bin/env bash",
				'rm -f -- "$VANISH_LOCK"',
				'now=$(cat "$CLOCK")',
				'printf "%s\\n" "$((now + 1))" >"$CLOCK"',
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), VANISH_LOCK: lock, CLOCK: clock },
			20000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.equal(rowOf(result.stdout, "lock"), lock, result.stdout);
		assert.match(rowOf(result.stdout, "token"), new RegExp(`^${SESSION}-\\d+$`), result.stdout);
		assert.equal(recordOf(home).session, SESSION, "the caller owns the lock");
		assert.equal(fs.existsSync(prevPath(home)), false, "an absent record is not kept");
	});

	test("a name that goes at the final probe names the lost name, not a create", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const sleepLog = path.join(home, "sleeps");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		const realCat = realToolPath("cat");
		// The create loses to a name that another writer makes, and the next read
		// finds the name gone. So no create failed when the final probe ran.
		const shim = makeShimDir({
			date: [
				"#!/usr/bin/env bash",
				'for arg in "$@"; do',
				'  if [ "$arg" = "+%s" ]; then',
				'    cat "$CLOCK"',
				"    exit 0",
				"  fi",
				"done",
				`exec ${realToolPath("date")} "$@"`,
			].join("\n"),
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				'now=$(cat "$CLOCK")',
				'printf "%s\\n" "$((now + 1))" >"$CLOCK"',
			].join("\n"),
			ln: [
				"#!/usr/bin/env bash",
				'args=("$@")',
				'target="${args[${#args[@]}-1]}"',
				'printf "agent orchestrator\\nsession boss\\ntoken boss-1\\nat %s\\nhost test-host\\n" "$(cat "$CLOCK")" >"$target"',
				"exit 1",
			].join("\n"),
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ] && [ -f "$target" ]; then',
				'  rm -f -- "$target"',
				"  exit 1",
				"fi",
				`exec ${realCat} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), CLOCK: clock, SLEEP_LOG: sleepLog },
			15000,
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.equal(
			result.stderr,
			`Error: lock name went before the create: ${lockPath(home)}\n`,
			`the error names the lost name: ${result.stderr}`,
		);
	});

	test("a refresh that loses the record to another breaker creates again", () => {
		const home = makeHome();
		plantLock(home, recordText(SESSION, `${SESSION}-1`, nowSeconds()));
		// The move fails after it removed the source, as a rename does when another
		// breaker took the name first.
		const shim = makeShimDir({
			mv: ["#!/usr/bin/env bash", 'args=("$@")', 'rm -f -- "${args[1]}"', "exit 1"].join("\n"),
		});

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], shimPath(shim), 15000);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rowOf(result.stdout, "token"), `${SESSION}-1`);
		assert.equal(recordOf(home).session, SESSION);
	});
});

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
