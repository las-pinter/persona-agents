/**
 * Tests for the journal write script: append, check, replace, and the splice.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(); no case touches the real home folder.
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
	AGENT,
	appendArgs,
	cleanup,
	countRow,
	dailyPath,
	fileLines,
	makeBlock,
	makeHome,
	reportDigest,
	run,
	seedTarget,
	stampOf,
	todayName,
	weeklyPath,
} from "./journal-write.fixtures.ts";

afterEach(cleanup);

/** A daily target with two project subsections under one Work Log. */
const SECTIONED = `# 2026-10-28\n\n## Work Log\n\n### alpha\n\nalpha row\n\n### beta\n\nbeta row\n`;

/** A daily target whose Work Log has no subsection yet. */
const BARE_LOG = `# 2026-10-28\n\n## Work Log\n\nwork row\n\n## Notes\n\nnote row\n`;

describe("append", () => {
	test("creates one header on an absent target", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const block = makeBlock(home, ["first row", "second row"]);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(fileLines(text)[0], `# ${todayName()}`, "an absent target gets one header row");
		assert.equal(countRow(text, "first row"), 1, "the block body must appear once");
		assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "the target must end with one newline");
	});

	test("adds one header to an empty target", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), "");
		const block = makeBlock(home, ["empty file row"]);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(fileLines(text).filter((row) => row.startsWith("# ")).length, 1, "one header only");
		assert.equal(countRow(text, "empty file row"), 1, "the block body must appear once");
	});

	test("keeps the stamp one row above the block text", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const block = makeBlock(home, ["stamped row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		const rows = fileLines(text);
		assert.equal(countRow(text, stamp), 1, "the stamp must appear once");
		assert.equal(rows[rows.indexOf(stamp) + 1], "stamped row", "the stamp must sit above the block text");
	});

	test("appends without a section at the end of the file", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), SECTIONED);
		const block = makeBlock(home, ["tail row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(fs.readFileSync(target, "utf8"));
		assert.equal(rows[rows.length - 1], "tail row", "the block must be the last text");
		assert.equal(rows[rows.indexOf(stamp) - 1], "", "one blank row must sit before the block");
	});

	test("splices into an existing subsection", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), SECTIONED);
		const block = makeBlock(home, ["alpha new row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(fs.readFileSync(target, "utf8"));
		const stampAt = rows.indexOf(stamp);
		assert.ok(stampAt > rows.indexOf("alpha row"), "the block must land after the last alpha row");
		assert.ok(stampAt < rows.indexOf("### beta"), "the block must land before the next subsection");
		assert.equal(rows[stampAt - 1], "", "one blank row must sit before the block");
	});

	test("creates a missing subsection inside the Work Log", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), BARE_LOG);
		const block = makeBlock(home, ["gamma row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "gamma"]));
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(fs.readFileSync(target, "utf8"));
		const headingAt = rows.indexOf("### gamma");
		assert.equal(rows.filter((row) => row === "### gamma").length, 1, "one gamma heading only");
		assert.ok(headingAt > rows.indexOf("## Work Log"), "the heading must sit inside the Work Log");
		assert.ok(headingAt < rows.indexOf("## Notes"), "the heading must sit before the next top heading");
		const stampAt = rows.indexOf(stamp);
		assert.ok(stampAt > headingAt && stampAt < rows.indexOf("## Notes"), "the block must sit under the heading");
	});

	test("creates a Work Log heading on a target that holds text only", () => {
		const home = makeHome();
		const seed = "# 2026-10-28\n\nkept row\n";
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["new log row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const want = `${seed}\n## Work Log\n\n### alpha\n\n${stamp}\nnew log row\n`;
		assert.equal(fs.readFileSync(target, "utf8"), want, "the heading, the subsection, and the block go at the end");
	});

	test("creates a Work Log heading on an absent target", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const block = makeBlock(home, ["fresh log row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const want = `# ${todayName()}\n\n## Work Log\n\n### alpha\n\n${stamp}\nfresh log row\n`;
		assert.equal(fs.readFileSync(target, "utf8"), want, "the header, the heading, and the block must appear once");
	});

	test("changes no byte outside the insert", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), SECTIONED);
		const block = makeBlock(home, ["kept row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const expected = SECTIONED.replace("alpha row\n", `alpha row\n\n${stamp}\nkept row\n`);
		assert.equal(fs.readFileSync(target, "utf8"), expected, "only the insert may change");

		const tailHome = makeHome();
		const tailTarget = seedTarget(dailyPath(tailHome), SECTIONED);
		const tailBlock = makeBlock(tailHome, ["tail kept row"]);
		const tailStamp = stampOf(tailBlock);
		const tailResult = run(tailHome, appendArgs(tailBlock));
		assert.equal(tailResult.status, 0, tailResult.stderr);
		const tailExpected = `${SECTIONED.replace(/\n+$/, "")}\n\n${tailStamp}\ntail kept row\n`;
		assert.equal(fs.readFileSync(tailTarget, "utf8"), tailExpected, "the original rows must stay whole");
	});

	test("compares a dotted section name literally", () => {
		const home = makeHome();
		const target = seedTarget(
			dailyPath(home),
			`# 2026-10-28\n\n## Work Log\n\n### axb\n\naxb row\n\n### v1.2\n\ndot row\n\n## Notes\n\nnote row\n`,
		);
		const block = makeBlock(home, ["dotted row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "v1.2"]));
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(fs.readFileSync(target, "utf8"));
		const stampAt = rows.indexOf(stamp);
		const axbAt = rows.indexOf("### axb");
		const dotAt = rows.indexOf("### v1.2");
		assert.equal(rows.filter((row) => row === "### v1.2").length, 1, "one dotted heading only");
		assert.ok(axbAt < dotAt, "the plain heading must come first");
		assert.ok(stampAt > dotAt, "the block must land under the dotted heading");
		assert.ok(stampAt > rows.indexOf("dot row"), "the block must land after the last dotted row");
		assert.ok(stampAt < rows.indexOf("## Notes"), "the block must stay inside the Work Log");
		assert.ok(!rows.slice(axbAt, dotAt).includes(stamp), "the wildcard match must stay untouched");
	});

	test("splices a target with no final newline", () => {
		const home = makeHome();
		const target = seedTarget(dailyPath(home), "# 2026-10-28\n\nrow one");
		const block = makeBlock(home, ["after row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(text, `# 2026-10-28\n\nrow one\n\n${stamp}\nafter row\n`, "the old last row stays whole");
		assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), "the target must end with one newline");
	});

	test("refuses a CRLF target", () => {
		const home = makeHome();
		const crlf = "# 2026-10-28\r\n\r\n## Work Log\r\n\r\n### alpha\r\n\r\nalpha row\r\n";
		const target = seedTarget(dailyPath(home), crlf);
		const block = makeBlock(home, ["crlf row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), crlf, "a refused target must stay byte-identical");
		assert.ok(fs.existsSync(block), "a refused target must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("carriage return"), "stderr must name the cause");
	});
});

describe("replace", () => {
	const replaceArgs = (block: string, extra: string[]): string[] => [
		"replace",
		"--agent",
		AGENT,
		"--level",
		"weekly",
		"--name",
		"2026-W43",
		"--block",
		block,
		...extra,
	];

	test("refuses a stale --expect digest", () => {
		const home = makeHome();
		const target = seedTarget(weeklyPath(home, "2026-W43"), "week row 1\nweek row 2\nweek row 3\n");
		const before = run(home, ["check", "--agent", AGENT, "--level", "weekly", "--name", "2026-W43"]);
		assert.equal(before.status, 0, before.stderr);
		const stale = reportDigest(before.stdout);
		fs.appendFileSync(target, "outside row\n");
		const outside = fs.readFileSync(target);
		const block = makeBlock(home, ["merged row"]);
		const result = run(home, replaceArgs(block, ["--expect", stale]));
		assert.equal(result.status, 3, result.stderr);
		assert.deepEqual(fs.readFileSync(target), outside, "a stale digest must leave the target whole");
		assert.ok(fs.existsSync(block), "a stale digest must keep the block");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
		assert.ok(result.stderr.includes(block), "stderr must name the block");
	});

	test("writes the merged block when the digest matches", () => {
		const home = makeHome();
		const target = seedTarget(weeklyPath(home, "2026-W43"), "week row 1\nweek row 2\nweek row 3\n");
		const fresh = run(home, ["check", "--agent", AGENT, "--level", "weekly", "--name", "2026-W43"]);
		assert.equal(fresh.status, 0, fresh.stderr);
		const block = makeBlock(home, ["merged row one", "merged row two"]);
		const stamp = stampOf(block);
		const result = run(home, replaceArgs(block, ["--expect", reportDigest(fresh.stdout)]));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), `${stamp}\nmerged row one\nmerged row two\n`);
		assert.ok(!fs.existsSync(block), "a written replace must remove the block");
	});

	test("refuses the daily level", () => {
		const home = makeHome();
		const block = makeBlock(home, ["daily replace row"]);
		const result = run(home, [
			"replace",
			"--agent",
			AGENT,
			"--level",
			"daily",
			"--block",
			block,
			"--expect",
			"new",
		]);
		assert.equal(result.status, 2, result.stderr);
		assert.ok(!fs.existsSync(dailyPath(home)), "a refused replace must write nothing");
		assert.ok(fs.existsSync(block), "a refused replace must keep the block");
	});
});
