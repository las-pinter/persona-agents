/**
 * Tests for the journal write script: concurrency and the lock.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 *
 * Run: npm test
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AGENT,
	BLOCK_MAX_ROWS,
	appendArgs,
	blockRows,
	cleanup,
	countRow,
	dailyPath,
	didSettle,
	expectedLines,
	fileLines,
	holdLock,
	makeBlock,
	makeHome,
	run,
	runAsync,
	runChild,
	seedTarget,
	stampOf,
	settle,
	todayName,
	waitForLockOpen,
	weeklyPath,
} from "./journal-write.fixtures.ts";

afterEach(cleanup);

describe("concurrent writers", () => {
	test("keeps both blocks when two appends overlap", async () => {
		let lostRounds = 0;
		for (let round = 1; round <= 20; round += 1) {
			const home = makeHome();
			const rowsA = blockRows(`round${round}A`, BLOCK_MAX_ROWS);
			const rowsB = blockRows(`round${round}B`, BLOCK_MAX_ROWS);
			const blockA = makeBlock(home, rowsA);
			const blockB = makeBlock(home, rowsB);
			const stamps = [stampOf(blockA), stampOf(blockB)];
			const total = expectedLines([blockA, blockB]);
			const [first, second] = await Promise.all([
				runAsync(home, appendArgs(blockA)),
				runAsync(home, appendArgs(blockB)),
			]);
			const text = fs.readFileSync(dailyPath(home), "utf8");
			const rows = fileLines(text);
			const headers = rows.filter((row) => row.startsWith("# ")).length;
			// Each block carries 198 rows, so each run must report the gate as over.
			const gates = first.stdout.includes("gate over") && second.stdout.includes("gate over");
			// Every row of both blocks and both stamp rows must appear exactly once,
			// so a swap of two rows, a lost block, or a doubled stamp cannot pass.
			const eachRowOnce = [...rowsA, ...rowsB, ...stamps].every((row) => countRow(text, row) === 1);
			const kept =
				first.status === 0 &&
				second.status === 0 &&
				headers === 1 &&
				gates &&
				eachRowOnce &&
				rows.length === total;
			if (!kept) lostRounds += 1;
		}
		assert.equal(lostRounds, 0, "every round must keep both blocks whole");
	});

	test("detects a lost update in a writer with no lock", async (t) => {
		const cpus = os.cpus().length;
		if (cpus < 2) {
			t.skip(`runner has ${cpus} cpu, so a serialized control cannot race`);
			return;
		}
		// A writer with no lock reads the whole target and renames its own copy.
		// The pause holds both reads open, so this control loses one block.
		const control =
			'p="$1"; b="$2"; m="$(cat -- "$p" 2>/dev/null)"; sleep 0.05; { printf "%s" "$m"; cat -- "$b"; } > "$p.$$" && mv -f -- "$p.$$" "$p"';
		let brokenRounds = 0;
		for (let round = 1; round <= 20; round += 1) {
			const home = makeHome();
			const target = seedTarget(dailyPath(home), "");
			const rowsA = blockRows(`control${round}A`, 4);
			const rowsB = blockRows(`control${round}B`, 4);
			const blockA = makeBlock(home, rowsA);
			const blockB = makeBlock(home, rowsB);
			const write = (block: string): Promise<void> =>
				new Promise((resolve) => {
					const child = spawn("bash", ["-c", control, "control", target, block], { stdio: "ignore" });
					child.on("close", () => resolve());
				});
			await Promise.all([write(blockA), write(blockB)]);
			const text = fs.readFileSync(target, "utf8");
			const lost = countRow(text, rowsA[0]) !== 1 || countRow(text, rowsB[0]) !== 1;
			if (lost) brokenRounds += 1;
		}
		assert.ok(brokenRounds >= 1, "the row count must detect a lost update at all");
	});

	test("creates one header for two overlapping appends", async () => {
		const home = makeHome();
		const target = dailyPath(home);
		const blockA = makeBlock(home, ["race row A one", "race row A two"]);
		const blockB = makeBlock(home, ["race row B one", "race row B two"]);
		const results = await Promise.all([
			runAsync(home, appendArgs(blockA)),
			runAsync(home, appendArgs(blockB)),
		]);
		for (const result of results) assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(fileLines(text).filter((row) => row.startsWith("# ")).length, 1, "one header only");
		assert.equal(countRow(text, "race row A one"), 1, "block A must appear once");
		assert.equal(countRow(text, "race row B one"), 1, "block B must appear once");
	});

	test("lets one replace win on an absent target", async () => {
		const home = makeHome();
		const target = weeklyPath(home, "2026-W43");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const blockA = makeBlock(home, ["winner row A"]);
		const blockB = makeBlock(home, ["winner row B"]);
		const stamps = [stampOf(blockA), stampOf(blockB)];
		const replaceArgs = (block: string): string[] => [
			"replace",
			"--agent",
			AGENT,
			"--level",
			"weekly",
			"--name",
			"2026-W43",
			"--block",
			block,
			"--expect",
			"new",
		];
		const results = await Promise.all([
			runAsync(home, replaceArgs(blockA)),
			runAsync(home, replaceArgs(blockB)),
		]);
		assert.deepEqual(
			results.map((entry) => entry.status).sort((left, right) => left - right),
			[0, 3],
			"one replace must win and the other must see a present target",
		);
		const winner = results.findIndex((entry) => entry.status === 0);
		const text = fs.readFileSync(target, "utf8");
		assert.ok(text.startsWith(`${stamps[winner]}\n`), "the winner text must be the target text");
		assert.ok(!fs.existsSync([blockA, blockB][winner]), "the winner block must be removed");
		assert.ok(fs.existsSync([blockA, blockB][1 - winner]), "the loser block must be kept");
	});
	test("refuses a block that gains a text record 2 after validation", async () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), `# ${todayName()}\n\nkept row\n`);
		const before = fs.readFileSync(target);
		const block = makeBlock(home, ["early row"]);
		const holder = holdLock(home);
		try {
			await holder.ready;
			const pending = runChild(home, appendArgs(block, ["--timeout", "60"]));
			// The lock descriptor is the script's own signal that validation is done.
			await waitForLockOpen(pending.pid, home);
			fs.writeFileSync(block, `${stampOf(block)}\nlate text record\n`);
			holder.release();
			const result = await pending.result;
			assert.equal(result.status, 2, result.stderr);
			assert.deepEqual(fs.readFileSync(target), before, "a text record 2 must leave the target whole");
			assert.ok(fs.existsSync(block), "a text record 2 must keep the block");
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
			assert.ok(result.stderr.includes("record 2"), "stderr must name the cause");
		} finally {
			holder.release();
			await holder.exited;
		}
	});
});

describe("the lock", () => {
	test("makes an append wait for the lock", async () => {
		const home = makeHome();
		seedTarget(dailyPath(home), `# ${todayName()}\n\nseed row\n`);
		const block = makeBlock(home, ["waited row"]);
		const holder = holdLock(home, 2);
		try {
			await holder.ready;
			const started = Date.now();
			const result = run(home, appendArgs(block));
			const elapsed = Date.now() - started;
			assert.equal(result.status, 0, result.stderr);
			assert.ok(elapsed >= 1500, `the append must wait for the lock, waited ${elapsed} ms`);
		} finally {
			holder.release();
			await holder.exited;
		}
	});

	test("exits 5 when the lock wait exceeds --timeout", async () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), `# ${todayName()}\n\nseed row\n`);
		const before = fs.readFileSync(target);
		const block = makeBlock(home, ["late row"]);
		const holder = holdLock(home);
		try {
			await holder.ready;
			const result = run(home, appendArgs(block, ["--timeout", "1"]));
			assert.equal(result.status, 5, result.stderr);
			assert.deepEqual(fs.readFileSync(target), before, "a lock timeout must leave the target whole");
			assert.ok(fs.existsSync(block), "a lock timeout must keep the block");
			assert.ok(result.stderr.includes(target), "stderr must name the target");
			assert.ok(result.stderr.includes(block), "stderr must name the block");
			assert.ok(result.stderr.includes("lock wait exceeded"), "stderr must name the lock wait");
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		} finally {
			holder.release();
			await holder.exited;
		}
	});

	test("covers the whole critical section", async () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), `# ${todayName()}\n\nseed row\n`);
		const before = fs.readFileSync(target);
		const block = makeBlock(home, ["late row"]);
		const holder = holdLock(home);
		try {
			await holder.ready;
			const pending = runAsync(home, appendArgs(block));
			const done = didSettle(pending);
			await settle(1000);
			assert.equal(done(), false, "the append must still wait on the lock");
			assert.deepEqual(fs.readFileSync(target), before, "a waiting append must not touch the target");
			holder.release();
			const result = await pending;
			assert.equal(result.status, 0, result.stderr);
			const text = fs.readFileSync(target, "utf8");
			assert.notDeepEqual(fs.readFileSync(target), before, "the released append must write");
			assert.equal(countRow(text, "late row"), 1, "the released append must keep the block");
		} finally {
			holder.release();
			await holder.exited;
		}
	});

	test("exits 4 when the block is lost after validation", async () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), `# ${todayName()}\n\nkept row\n`);
		const before = fs.readFileSync(target);
		const block = makeBlock(home, ["lost row"]);
		const holder = holdLock(home);
		try {
			await holder.ready;
			const pending = runChild(home, appendArgs(block, ["--timeout", "60"]));
			// The lock descriptor is the script's own signal that validation is done.
			await waitForLockOpen(pending.pid, home);
			fs.rmSync(block);
			holder.release();
			const result = await pending.result;
			assert.equal(result.status, 4, result.stderr);
			assert.deepEqual(fs.readFileSync(target), before, "a lost block must leave the target whole");
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
			assert.ok(result.stderr.includes("block read failed"), "stderr must name the block read stage");
			assert.ok(result.stderr.includes(target), "stderr must name the target");
			assert.ok(result.stderr.includes(block), "stderr must name the block path");
		} finally {
			holder.release();
			await holder.exited;
		}
	});
});
