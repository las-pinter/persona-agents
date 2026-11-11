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
	holdWindow,
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
import type { RunResult, SpawnedRun } from "./journal-lock-helpers.ts";

const STALE_AGE = 601;

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

/**
 * Wait for one signalled run, so a run that hangs fails with the case name. The
 * cap kills only the direct child, so a failed case leaves no direct child
 * behind.
 */
async function settled(what: string, held: SpawnedRun, capMs: number = RUN_TIMEOUT_MS): Promise<RunResult> {
	let timer: NodeJS.Timeout | undefined;
	const cap = new Promise<RunResult>((_resolve, reject) => {
		timer = setTimeout(() => {
			held.kill("SIGKILL");
			reject(new Error(`the ${what} run passed ${capMs} ms`));
		}, capMs);
	});
	try {
		return await Promise.race([held.done, cap]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("G — a caught signal cleans up", () => {
	// The stale break claims the record, then the prev copy marks and holds, so
	// the signal lands while the claim holds the record. The case releases the
	// shim after it signals, because a bash trap runs after the foreground ends.
	for (const [signal, status] of [
		["SIGHUP", 129],
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		test(`a ${signal} inside the claim window drops the claim and the record temp`, async () => {
			const home = makeHome();
			const mark = path.join(home, `claim-window-${signal}`);
			const release = path.join(home, `claim-window-${signal}-go`);
			plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
			const shim = makeShimDir({
				cp: holdWindow("CP_MARK", "CP_RELEASE", `exec ${realToolPath("cp")} "$@"`),
			});
			const held = spawnRun(home, ["hold", "--agent", AGENT, "--session", SESSION], {
				...shimPath(shim),
				CP_MARK: mark,
				CP_RELEASE: release,
			});
			await waitForMark(mark);
			assert.equal(claimNames(home).length, 1, "the claim exists when the signal lands");

			held.kill(signal);
			fs.writeFileSync(release, "");
			const result = await settled(signal, held);

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
		const release = path.join(home, "temp-window-go");
		// The record reaches the temp file before the link, and the link marks and
		// holds, so the signal lands while the record waits in the temp file.
		const shim = makeShimDir({
			ln: holdWindow("LN_MARK", "LN_RELEASE", "exit 1"),
		});
		const held = spawnRun(home, ["hold", "--agent", AGENT, "--session", SESSION], {
			...shimPath(shim),
			LN_MARK: mark,
			LN_RELEASE: release,
		});
		await waitForMark(mark);
		assert.equal(tempNames(home).length, 1, "the record temp exists when the signal lands");

		held.kill("SIGTERM");
		fs.writeFileSync(release, "");
		const result = await settled("SIGTERM record write", held);

		assert.deepEqual(tempNames(home), [], `the record temp is gone: ${result.stderr}`);
		assert.equal(claimNames(home).length, 0, "no claim is left");
		assert.equal(result.status, 143, `the run reports the signal: ${result.stderr}`);
		const fresh = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(fresh.status, 0, fresh.stderr);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("a run past the cap is killed, so no direct child is left", async () => {
		const home = makeHome();
		const mark = path.join(home, "cap-marked");
		const release = path.join(home, "cap-go");
		// The claim copy stalls in the shim until this case releases it, so the run
		// cannot end by itself before the cap fires.
		const shim = makeShimDir({
			cp: holdWindow("CP_MARK", "CP_RELEASE", `exec ${realToolPath("cp")} "$@"`),
		});
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		const held = spawnRun(home, ["hold", "--agent", AGENT, "--session", SESSION], {
			...shimPath(shim),
			CP_MARK: mark,
			CP_RELEASE: release,
		});
		await waitForMark(mark);

		try {
			await assert.rejects(settled("capped", held, 200), /the capped run passed 200 ms/);
		} finally {
			// The shim holds the child's pipes, so the release comes before the await:
			// a close event waits for every writer of the captured streams.
			fs.writeFileSync(release, "");
		}
		const killed = await held.done;
		assert.equal(killed.status, -1, "the child ends by signal, not by its own exit");
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
