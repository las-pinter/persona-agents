/**
 * Tests for the journal write lock script poll-interval seam.
 *
 * Every case runs the real shipped script by absolute path, with the shared
 * scaffolding in journal-lock-helpers.ts and a throw-away home under os.tmpdir().
 * The cases read the poll width from the sleep shim, so the seam is measured.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunResult } from "./journal-lock-helpers.ts";
import {
	AGENT,
	SESSION,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	realToolPath,
	recordOf,
	recordText,
	rowOf,
	rows,
	shimPath,
	startAsync,
} from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

/** The poll width the script must use when the seam carries no valid value. */
const DEFAULT_POLL = "1";

/** Every value outside the seam holds no width, so each one keeps the default. */
const REJECTED_POLLS: (string | undefined)[] = [
	undefined,
	"",
	"0",
	"1001",
	"-5",
	"12.5",
	"08",
	"abc",
];

interface Retry {
	result: RunResult;
	sleeps: string[];
}

/**
 * One stale break that loses its first digest compare, so the caller takes
 * exactly one retry poll and then wins. The digest shim differs on its first
 * read only, and the sleep shim records the width it was given.
 */
async function retryOnce(poll: string | undefined): Promise<Retry> {
	const home = makeHome();
	const sleepLog = path.join(home, "sleeps");
	plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
	const realCksum = realToolPath("cksum");
	const shim = makeShimDir({
		cksum: [
			"#!/usr/bin/env bash",
			'count="$(dirname "$0")/cksum-count"',
			"now=0",
			'if [ -f "$count" ]; then now=$(cat "$count"); fi',
			"now=$((now + 1))",
			'printf "%s\\n" "$now" >"$count"',
			'if [ "$now" -lt 2 ]; then printf "%s %s\\n" 1 1; exit 0; fi',
			`exec ${realCksum} "$@"`,
		].join("\n"),
		sleep: [
			"#!/usr/bin/env bash",
			'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
			`exec ${realToolPath("sleep")} "$@"`,
		].join("\n"),
	});

	// A wide hold deadline keeps a loaded machine from ending the wait early.
	const result = await startAsync(home, ["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "30"], {
		...shimPath(shim),
		SLEEP_LOG: sleepLog,
		JOURNAL_WRITE_POLL_MS: poll ?? "",
	});
	const sleeps = fs.existsSync(sleepLog) ? rows(fs.readFileSync(sleepLog, "utf8")) : [];

	assert.equal(result.status, 0, result.stderr);
	assert.equal(rowOf(result.stdout, "lock"), path.join(home, "agent-notes", AGENT, "journals", ".journal-write.lock"));
	assert.equal(recordOf(home).session, SESSION, "the retry ends with the caller's record");
	return { result, sleeps };
}

describe("I — the poll interval seam", () => {
	test("an unset poll interval keeps the one second retry", async () => {
		const retry = await retryOnce(undefined);
		assert.deepEqual(retry.sleeps, [DEFAULT_POLL], `one default poll: ${retry.sleeps.join(",")}`);
	});

	test("an invalid poll interval keeps the one second default", async () => {
		const retry = await retryOnce("soon");
		assert.deepEqual(retry.sleeps, [DEFAULT_POLL], `an invalid value keeps the default: ${retry.sleeps.join(",")}`);
	});

	test("a value outside the seam keeps the one second default", async () => {
		const retries = await Promise.all(REJECTED_POLLS.map((poll) => retryOnce(poll)));
		REJECTED_POLLS.forEach((poll, index) => {
			const retry = retries[index] as Retry;
			const name = poll === undefined ? "unset" : `"${poll}"`;
			assert.deepEqual(retry.sleeps, [DEFAULT_POLL], `${name} keeps one default sleep: ${retry.sleeps.join(",")}`);
			assert.equal(retry.result.stderr, "", `${name} prints no base error: ${retry.result.stderr}`);
		});
	});

	test("the poll interval override sleeps the fast poll width", async () => {
		const retry = await retryOnce("50");
		assert.deepEqual(retry.sleeps, ["0.050"], `one fast poll: ${retry.sleeps.join(",")}`);
	});
});
