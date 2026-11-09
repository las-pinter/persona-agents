/**
 * Tests for the journal write lock script under a caught signal.
 *
 * Every case runs the real shipped script and ends that run with a real signal,
 * using the shared scaffolding in journal-lock-helpers.ts.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT,
	RUN_TIMEOUT_MS,
	SESSION,
	claimNames,
	journalsDir,
	lockPath,
	makeHome,
	makeShimDir,
	nowSeconds,
	plantLock,
	realToolPath,
	recordOf,
	recordText,
	rowOf,
	run,
	shimPath,
	spawnRun,
	waitForMark,
} from "./journal-lock-helpers.ts";
import type { RunResult } from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

/** The pause a shim holds, so a case signals the run inside the window. */
const SHIM_SLEEP = "0.5";

/** The record temp files left in the journals folder: not the lock, prev, or a claim. */
function tempNames(home: string): string[] {
	return fs
		.readdirSync(journalsDir(home))
		.filter(
			(name) =>
				name.startsWith(".journal-write.") &&
				name !== ".journal-write.lock" &&
				name !== ".journal-write.prev" &&
				!name.startsWith(".journal-write.claim."),
		);
}

/** Wait for one signalled run, so a run that hangs fails with the case name. */
async function settled(what: string, done: Promise<RunResult>): Promise<RunResult> {
	let timer: NodeJS.Timeout | undefined;
	const cap = new Promise<RunResult>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`the ${what} run passed ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS);
	});
	try {
		return await Promise.race([done, cap]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("G — a caught signal cleans up", () => {
	// The stale break claims the record, then the prev copy marks and sleeps, so
	// the signal lands while the claim holds the record.
	for (const [signal, status] of [
		["SIGHUP", 129],
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		test(`a ${signal} inside the claim window drops the claim and the record temp`, async () => {
			const home = makeHome();
			const mark = path.join(home, `claim-window-${signal}`);
			plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
			const shim = makeShimDir({
				cp: [
					"#!/usr/bin/env bash",
					': >"$CP_MARK"',
					`sleep ${SHIM_SLEEP}`,
					`exec ${realToolPath("cp")} "$@"`,
				].join("\n"),
			});
			const held = spawnRun(home, ["hold", "--agent", AGENT, "--session", SESSION], {
				...shimPath(shim),
				CP_MARK: mark,
			});
			await waitForMark(mark);
			assert.equal(claimNames(home).length, 1, "the claim exists when the signal lands");

			held.kill(signal);
			const result = await settled(signal, held.done);

			assert.equal(claimNames(home).length, 0, `the claim is gone: ${result.stderr}`);
			assert.deepEqual(tempNames(home), [], "the record temp is gone");
			assert.equal(result.status, status, `the run reports the signal: ${result.stderr}`);
			const fresh = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
			assert.equal(fresh.status, 0, fresh.stderr);
			assert.equal(recordOf(home).session, SESSION);
		});
	}

	test("a TERM inside the record write drops the record temp", async () => {
		const home = makeHome();
		const mark = path.join(home, "temp-window");
		// The record reaches the temp file before the link, and the link marks and
		// sleeps, so the signal lands while the record waits in the temp file.
		const shim = makeShimDir({
			ln: ["#!/usr/bin/env bash", ': >"$LN_MARK"', `sleep ${SHIM_SLEEP}`, "exit 1"].join("\n"),
		});
		const held = spawnRun(home, ["hold", "--agent", AGENT, "--session", SESSION], {
			...shimPath(shim),
			LN_MARK: mark,
		});
		await waitForMark(mark);
		assert.equal(tempNames(home).length, 1, "the record temp exists when the signal lands");

		held.kill("SIGTERM");
		const result = await settled("SIGTERM record write", held.done);

		assert.deepEqual(tempNames(home), [], `the record temp is gone: ${result.stderr}`);
		assert.equal(claimNames(home).length, 0, "no claim is left");
		assert.equal(result.status, 143, `the run reports the signal: ${result.stderr}`);
		const fresh = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(fresh.status, 0, fresh.stderr);
		assert.equal(recordOf(home).session, SESSION);
	});
});

describe("H — an orphan claim does not block", () => {
	test("a claim file beside an absent lock name leaves the hold free", () => {
		const home = makeHome();
		fs.mkdirSync(journalsDir(home), { recursive: true });
		const orphan = path.join(journalsDir(home), ".journal-write.claim.Ab12Cd");
		fs.writeFileSync(orphan, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rowOf(result.stdout, "lock"), lockPath(home));
		assert.equal(recordOf(home).session, SESSION);
		assert.equal(fs.existsSync(orphan), true, "no code removes the orphan claim");
	});
});
