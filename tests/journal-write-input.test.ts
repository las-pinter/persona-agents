/**
 * Tests for the journal write script: the flags, the help, and bad input.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 *
 * Run: npm test
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT,
	BLOCK_MAX_ROWS,
	appendArgs,
	cleanup,
	countRow,
	dailyPath,
	fileLines,
	journalsDir,
	makeBlock,
	makeHome,
	makeTree,
	namedBlock,
	rawBlock,
	run,
	runRaw,
	seedTarget,
	stampOf,
	STAMP_TIME,
	todayName,
} from "./journal-write.fixtures.ts";

afterEach(cleanup);

/** A daily target with one kept row, for a case that must change nothing. */
function seededDaily(home: string): { target: string; before: Buffer } {
	const target = seedTarget(dailyPath(home), `# ${todayName()}\n\nkept row\n`);
	return { target, before: fs.readFileSync(target) };
}

describe("command line", () => {
	test("exits 1 on an unknown flag", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["unused row"]);
		const result = run(home, appendArgs(block, ["--nope"]));
		assert.equal(result.status, 1, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a usage error must leave the target whole");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("unknown flag"), "stderr must name the cause");
		assert.ok(!result.stderr.includes("none"), "the target slot must not hold a placeholder");
	});

	test("exits 1 on a missing value", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const result = run(home, ["append", "--agent"]);
		assert.equal(result.status, 1, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a missing value must leave the target whole");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("missing value"), "stderr must name the cause");
	});

	test("exits 1 when a flag ends the argument list", () => {
		const home = makeHome();
		const block = makeBlock(home, ["unused row"]);
		const result = runRaw(home, ["append", "--agent", AGENT, "--block", block, "--section"]);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("missing value for --section"), "stderr must name the flag");
		assert.ok(!result.stderr.includes("none"), "the target slot must not hold a placeholder");
		assert.ok(fs.existsSync(block), "a usage error must keep the block");
	});

	test("exits 1 on a repeated flag", () => {
		const home = makeHome();
		const block = makeBlock(home, ["unused row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha", "--section", "beta"]));
		assert.equal(result.status, 1, result.stderr);
		assert.ok(result.stderr.includes("repeated flag"), "stderr must name the cause");
		assert.ok(fs.existsSync(block), "a usage error must keep the block");
	});

	test("prints the help with every flag and every exit code", () => {
		const home = makeHome();
		const result = run(home, ["--help"]);
		assert.equal(result.status, 0, result.stderr);
		for (const word of ["append", "check", "replace"]) {
			assert.ok(result.stdout.includes(word), `the help must name ${word}`);
		}
		for (const flag of [
			"--agent",
			"--block",
			"--section",
			"--level",
			"--name",
			"--expect",
			"--show",
			"--home",
			"--timeout",
			"-h",
			"--help",
		]) {
			assert.ok(result.stdout.includes(flag), `the help must name ${flag}`);
		}
		for (const code of ["0", "1", "2", "3", "4", "5"]) {
			assert.ok(new RegExp(`^  ${code}  `, "m").test(result.stdout), `the help must name exit code ${code}`);
		}
		const causes = ["temp create", "temp read", "temp write", "block read", "target read", "chmod", "rename"];
		for (const cause of causes) assert.ok(result.stdout.includes(cause), `the help must name ${cause} as an exit-4 cause`);
		assert.ok(result.stdout.includes("usage error"), "the help must name a usage error");
		assert.ok(result.stdout.includes("bad input"), "the help must name bad input");
	});
});

describe("input validation", () => {
	test("exits 2 on a block without a stamp", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = rawBlock(home, "plain first row\nplain second row\n");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a bad stamp must leave the target whole");
		assert.ok(fs.existsSync(block), "a bad stamp must keep the block");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
	});

	test("exits 2 on a stamp for another agent", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["planner row"], "planner");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a foreign stamp must leave the target whole");
		assert.ok(fs.existsSync(block), "a foreign stamp must keep the block");
	});

	test("exits 2 on a block over the record limit", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const rows = Array.from({ length: BLOCK_MAX_ROWS + 1 }, (_unused, index) => `long row ${index + 1}`);
		const block = makeBlock(home, rows);
		assert.equal(fileLines(fs.readFileSync(block, "utf8")).length, 201, "the block must hold 201 records");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a long block must leave the target whole");
		assert.ok(fs.existsSync(block), "a long block must be kept");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
	});

	test("writes a block at the record limit", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const rows = Array.from({ length: BLOCK_MAX_ROWS }, (_unused, index) => `limit row ${index + 1}`);
		const block = makeBlock(home, rows);
		assert.equal(fileLines(fs.readFileSync(block, "utf8")).length, 200, "the block must hold 200 records");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(countRow(fs.readFileSync(target, "utf8"), "limit row 1"), 1, "the block must be written");
		assert.ok(result.stdout.includes("gate over"), "a 201-row target must report the gate as over");
	});

	test("exits 2 on a missing block", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const result = run(home, appendArgs("/nonexistent/x.md"));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a missing block must leave the target whole");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
	});

	test("exits 2 on a block outside the incoming folder", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const outside = path.join(home, "agent-notes", AGENT, "block.md");
		fs.writeFileSync(outside, `<!-- session: 2026-10-28T21:40:12Z ${AGENT} outside -->\n\noutside row\n`);
		const result = run(home, appendArgs(outside));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a foreign block must leave the target whole");
		assert.ok(result.stderr.includes("outside the incoming folder"), "stderr must name the cause");
	});

	test("exits 2 on an invalid agent name", () => {
		const home = makeHome();
		const block = makeBlock(home, ["evil row"]);
		const result = run(home, ["append", "--agent", "../evil", "--block", block]);
		assert.equal(result.status, 2, result.stderr);
		assert.ok(!fs.existsSync(path.join(home, "evil")), "no folder may appear outside the agent folder");
		assert.ok(!fs.existsSync(path.join(journalsDir(home), "daily")), "no daily folder may appear");
	});

	test("exits 2 on a --home folder with no agent-notes", () => {
		const tree = makeTree();
		const result = run(tree, ["check", "--agent", AGENT]);
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("no agent-notes"), "stderr must name the cause");
		assert.ok(!result.stderr.includes("none"), "the target slot must not hold a placeholder");
	});

	test("exits 2 on a block whose second record holds text", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = rawBlock(home, `<!-- session: ${STAMP_TIME} ${AGENT} rec2 -->\ntext record\n`);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a text record 2 must leave the target whole");
		assert.ok(fs.existsSync(block), "a text record 2 must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("record 2"), "stderr must name the cause");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
	});

	test("accepts a block with no second record", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const block = rawBlock(home, `<!-- session: ${STAMP_TIME} ${AGENT} rec2absent -->\n`);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			fs.readFileSync(target, "utf8"),
			`# ${todayName()}\n\n${stamp}\n`,
			"an absent record 2 must splice the stamp alone",
		);
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});

	test("prints a relative block path as given on one line", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const cases = [
			["incoming/block.md", "incoming/block.md"],
			["incoming/break\nrow.md", "incoming/break row.md"],
		];
		for (const [given, slot] of cases) {
			const result = run(home, ["append", "--agent", AGENT, "--block", given]);
			assert.equal(result.status, 2, result.stderr);
			const want = `Error: block path is not absolute: ${target} (block kept: ${slot})\n`;
			assert.equal(result.stderr, want, "one line, and the block slot must hold the path as given");
		}
		assert.deepEqual(fs.readFileSync(target), before, "a refused block must leave the target whole");
	});

	test("splices a block path that holds a backslash", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const block = namedBlock(home, "back\\slash.md", ["backslash row"]);
		assert.ok(block.includes("\\"), "the case must use a path with a backslash");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(countRow(text, "backslash row"), 1, "the block body must appear once");
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});
});

describe("IO failure", () => {
	test("exits 4 on a read-only target folder", (t) => {
		const uid = process.getuid?.() ?? -1;
		if (uid === 0) {
			t.skip("runner is root, so a read-only folder still takes a write");
			return;
		}
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const dailyDir = path.dirname(target);
		const block = makeBlock(home, ["blocked row"]);
		fs.chmodSync(dailyDir, 0o500);
		try {
			const result = run(home, appendArgs(block));
			assert.equal(result.status, 4, result.stderr);
			assert.deepEqual(fs.readFileSync(target), before, "an IO failure must leave the target whole");
			assert.ok(fs.existsSync(block), "an IO failure must keep the block");
			assert.ok(result.stderr.includes(target), "stderr must name the target");
			assert.ok(result.stderr.includes(block), "stderr must name the block");
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		} finally {
			fs.chmodSync(dailyDir, 0o700);
		}
	});

	test("exits 4 when the lock path is not a file", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		fs.mkdirSync(path.join(journalsDir(home), ".journal-write.lock"));
		const block = makeBlock(home, ["locked row"]);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 4, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a bad lock path must leave the target whole");
		assert.ok(fs.existsSync(block), "a bad lock path must keep the block");
		assert.ok(result.stderr.includes("lock file open failed"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
	});
});
