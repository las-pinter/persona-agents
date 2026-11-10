/**
 * Tests for the journal write lock script: a record that goes away mid-call.
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
	journalsDir,
	lockPath,
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
	shimPath,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

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
