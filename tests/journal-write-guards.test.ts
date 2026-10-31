/**
 * Tests for the journal write script block guards: headings, empty text, and
 * stamp anchors.
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
	appendArgs,
	cleanup,
	countRow,
	dailyPath,
	fileLines,
	journalsDir,
	lockPath,
	makeBlock,
	makeHome,
	rawBlock,
	run,
	seededDaily,
	seedTarget,
	stampOf,
	STAMP_TIME,
} from "./journal-write.fixtures.ts";

afterEach(cleanup);

describe("block guards", () => {
	const stampRow = (session: string): string => `<!-- session: ${STAMP_TIME} ${AGENT} ${session} -->`;

	test("exits 2 on the Work Log heading in the block text", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["## Work Log", "plain row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a heading copy must leave the target whole");
		assert.ok(fs.existsSync(block), "a heading copy must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("Work Log heading"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
	});

	test("exits 2 on a heading with odd spacing or a leading space", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const cases: Array<{ rows: string[]; cause: string }> = [
			{ rows: ["plain row", "##\tWork Log"], cause: "Work Log heading" },
			{ rows: ["plain row", "##  Work Log"], cause: "Work Log heading" },
			{ rows: ["plain row", " ### alpha"], cause: "section heading" },
		];
		for (const { rows, cause } of cases) {
			const block = makeBlock(home, rows);
			const result = run(home, appendArgs(block, ["--section", "alpha"]));
			assert.equal(result.status, 2, `rows ${JSON.stringify(rows)}: ${result.stderr}`);
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
			assert.ok(result.stderr.includes(cause), `rows ${JSON.stringify(rows)} must name ${cause}`);
			assert.ok(fs.existsSync(block), "a refused block must be kept");
		}
		assert.deepEqual(fs.readFileSync(target), before, "a refused block must leave the target whole");
	});

	test("exits 2 when the first text line is a level-2 or a level-3 heading", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		for (const row of ["## Details", "### Notes"]) {
			const block = makeBlock(home, [row, "- body row"]);
			const result = run(home, appendArgs(block, ["--section", "alpha"]));
			assert.equal(result.status, 2, `${row}: ${result.stderr}`);
			assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
			assert.ok(result.stderr.includes("first text line"), `${row} must name the cause`);
			assert.ok(result.stderr.includes(block), `${row} must name the block path`);
			assert.ok(fs.existsSync(block), `${row} must keep the block`);
		}
		assert.deepEqual(fs.readFileSync(target), before, "a heading block must leave the target whole");
	});

	test("refuses a first-line heading before it takes the lock", () => {
		// A fresh home holds no daily and no lock file, so nothing but the
		// pre-lock scan can refuse this block.
		const home = makeHome();
		const block = makeBlock(home, ["## Details", "- body row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("first text line"), "stderr must name the cause");
		assert.equal(
			fs.existsSync(lockPath(home)),
			false,
			"a refused block must leave no lock file in the journals folder",
		);
		assert.deepEqual(
			fs.readdirSync(journalsDir(home)),
			["incoming"],
			"a refused block must leave the journals folder as it was",
		);
		assert.ok(!fs.existsSync(path.dirname(dailyPath(home))), "a refused block must create no daily folder");
		assert.ok(fs.existsSync(block), "a refused block must be kept");
	});

	test("exits 2 when the first text line is a level-1 heading", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["# Details", "- body row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("first text line"), "stderr must name the cause");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
		assert.ok(fs.existsSync(block), "a level-1 heading block must keep the block");
		assert.deepEqual(fs.readFileSync(target), before, "a level-1 heading block must leave the target whole");
		const deep = makeBlock(home, ["#### Details", "- body row"]);
		const deepRun = run(home, appendArgs(deep, ["--section", "alpha"]));
		assert.equal(deepRun.status, 0, deepRun.stderr);
		assert.equal(countRow(fs.readFileSync(target, "utf8"), "#### Details"), 1, "a level-4 heading stays allowed");
	});

	test("exits 2 on the section heading with trailing spaces", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["plain row", "### alpha   "]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a section heading copy must leave the target whole");
		assert.ok(fs.existsSync(block), "a section heading copy must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("section heading"), "stderr must name the cause");
	});

	test("exits 2 on the Work Log heading with a closing hash sequence", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["## Work Log ###", "plain row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a heading copy must leave the target whole");
		assert.ok(fs.existsSync(block), "a heading copy must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("Work Log heading"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
	});

	test("exits 2 on the section heading with a closing hash sequence", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["plain row", "### alpha ##"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a section heading copy must leave the target whole");
		assert.ok(fs.existsSync(block), "a section heading copy must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("section heading"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target");
		assert.ok(result.stderr.includes(block), "stderr must name the block path");
	});

	test("splices into a section whose heading closes with a hash sequence", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\n### alpha ##\n\nalpha row\n\n### beta\n\nbeta row\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["alpha late row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(fs.readFileSync(target, "utf8"));
		const stampAt = rows.indexOf(stamp);
		assert.ok(stampAt > rows.indexOf("alpha row"), "the block must land after the last alpha row");
		assert.ok(stampAt < rows.indexOf("### beta"), "the block must land before the next subsection");
		assert.equal(countRow(fs.readFileSync(target, "utf8"), "### alpha ##"), 1, "the old heading must stay once");
		assert.equal(countRow(fs.readFileSync(target, "utf8"), "### alpha"), 0, "no second heading may appear");
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});

	test("agrees on a section row whose text ends in a hash run", () => {
		const home = makeHome();
		// The heading text is "alpha ##", so the last "##" is the closing run.
		// Both sides must treat the row as text, not as the section "alpha".
		const heading = "### alpha ## ##";
		const { target } = seededDaily(home);
		const block = makeBlock(home, ["- row one", heading]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
		assert.equal(countRow(fs.readFileSync(target, "utf8"), heading), 1, "the block row must be written once");
		const seed = `# 2026-10-28\n\n## Work Log\n\n${heading}\n\nalpha row\n`;
		const second = seedTarget(dailyPath(home), seed);
		const late = makeBlock(home, ["- row two"]);
		const stamp = stampOf(late);
		const lateRun = run(home, appendArgs(late, ["--section", "alpha"]));
		assert.equal(lateRun.status, 0, lateRun.stderr);
		const after = fs.readFileSync(second, "utf8");
		const rows = fileLines(after);
		assert.equal(countRow(after, "### alpha"), 1, "the target row is not the section, so one heading is added");
		assert.equal(countRow(after, heading), 1, "the hash-run row must stay once");
		assert.ok(rows.indexOf(stamp) > rows.indexOf(heading), "the block must land after the hash-run row");
		assert.ok(!fs.existsSync(late), "a written append must remove the block");
	});

	test("agrees on a Work Log row whose heading text ends in a hash run", () => {
		const home = makeHome();
		// The heading text is "Work Log ##", so one trim leaves a hash run that
		// stays in the text. Both sides must treat the row as text, not as the
		// Work Log heading, so one strip runs per row.
		const row = "## Work Log ## ##";
		const block = makeBlock(home, ["- row one", row]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
		const first = fs.readFileSync(dailyPath(home), "utf8");
		assert.equal(countRow(first, row), 1, "the block row must be written once");
		const seed = `# 2026-10-28\n\n${row}\n\nkept row\n`;
		const second = seedTarget(dailyPath(home), seed);
		const late = makeBlock(home, ["- row two"]);
		const stamp = stampOf(late);
		const lateRun = run(home, appendArgs(late, ["--section", "alpha"]));
		assert.equal(lateRun.status, 0, lateRun.stderr);
		const after = fs.readFileSync(second, "utf8");
		const rows = fileLines(after);
		assert.equal(countRow(after, "## Work Log"), 1, "the target row is not the Work Log heading, so one heading is added");
		assert.equal(countRow(after, row), 1, "the hash-run row must stay once");
		assert.ok(rows.indexOf(stamp) > rows.indexOf(row), "the block must land after the hash-run row");
		assert.ok(!fs.existsSync(late), "a written append must remove the block");
	});

	test("splices into a section whose heading holds a leading space", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\n ### alpha\n\nalpha row\n\n### beta\n\nbeta row\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["alpha late row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		const rows = fileLines(text);
		const stampAt = rows.indexOf(stamp);
		assert.ok(stampAt > rows.indexOf("alpha row"), "the block must land after the last alpha row");
		assert.ok(stampAt < rows.indexOf("### beta"), "the block must land before the next subsection");
		assert.equal(countRow(text, " ### alpha"), 1, "the leading-space heading must stay once");
		assert.equal(countRow(text, "### alpha"), 0, "no second heading may appear");
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});

	test("splices into a work log group whose heading closes with a hash sequence", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log ###\n\nwork row\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["alpha row"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		const rows = fileLines(text);
		const stampAt = rows.indexOf(stamp);
		assert.ok(stampAt > rows.indexOf("work row"), "the block must land after the work log row");
		assert.equal(countRow(text, "## Work Log ###"), 1, "the old work log heading must stay once");
		assert.equal(countRow(text, "## Work Log"), 0, "no second work log heading may appear");
		assert.equal(countRow(text, "### alpha"), 1, "the section heading must appear once");
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});

	test("exits 2 on a block of blank lines", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = makeBlock(home, ["", "   "]);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a block of blank lines must leave the target whole");
		assert.ok(fs.existsSync(block), "a block of blank lines must keep the block");
		assert.ok(result.stderr.includes("no text line"), "stderr must name the cause");
	});

	test("exits 2 when the section group ends on a bare stamp", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\n### alpha\n\nalpha row\n${stampRow("earlier")}\n\n### beta\n\nbeta row\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["late row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), seed, "a stamp anchor must leave the target whole");
		assert.ok(fs.existsSync(block), "a stamp anchor must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("session stamp"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target path");
	});

	test("exits 2 when the Work Log group ends on a bare stamp", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\nwork row\n${stampRow("logtail")}\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["late row"]);
		const result = run(home, appendArgs(block, ["--section", "gamma"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), seed, "a stamp anchor must leave the target whole");
		assert.ok(fs.existsSync(block), "a stamp anchor must keep the block");
		assert.ok(result.stderr.includes("session stamp"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target path");
	});

	test("exits 2 when the file ends on a bare stamp with trailing space", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\n### alpha\n\nalpha row\n${stampRow("filetail")} \t\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["tail row"]);
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), seed, "a stamp anchor must leave the target whole");
		assert.ok(fs.existsSync(block), "a stamp anchor must keep the block");
		assert.ok(result.stderr.includes("session stamp"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target path");
	});

	test("exits 2 on a target that holds the date and a bare stamp", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n${stampRow("lonely")}\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["- late row"]);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 2, result.stderr);
		assert.equal(fs.readFileSync(target, "utf8"), seed, "a stamp anchor must leave the target whole");
		assert.ok(fs.existsSync(block), "a stamp anchor must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("session stamp"), "stderr must name the cause");
		assert.ok(result.stderr.includes(target), "stderr must name the target path");
		const leftovers = fs
			.readdirSync(path.dirname(target))
			.filter((name) => name.startsWith(".journal-write."));
		assert.deepEqual(leftovers, [], "a refused call must leave no temp file");
	});

	test("exits 2 on a block that holds one stamp row only", () => {
		const home = makeHome();
		const { target, before } = seededDaily(home);
		const block = rawBlock(home, `<!-- session: ${STAMP_TIME} ${AGENT} onerow -->\n`);
		assert.equal(fileLines(fs.readFileSync(block, "utf8")).length, 1, "the block must hold the stamp row only");
		const result = run(home, appendArgs(block));
		assert.equal(result.status, 2, result.stderr);
		assert.deepEqual(fs.readFileSync(target), before, "a bare stamp must leave the target whole");
		assert.ok(fs.existsSync(block), "a bare stamp must keep the block");
		assert.equal(fileLines(result.stderr).length, 1, "one stderr line only");
		assert.ok(result.stderr.includes("no text line"), "stderr must name the cause");
	});

	test("appends a block that starts with text and keeps a lower heading", () => {
		const home = makeHome();
		const seed = `# 2026-10-28\n\n## Work Log\n\n### alpha\n\nalpha row\n`;
		const target = seedTarget(dailyPath(home), seed);
		const block = makeBlock(home, ["- guard row", "### Key Decisions", "- keep the limit"]);
		const stamp = stampOf(block);
		const result = run(home, appendArgs(block, ["--section", "alpha"]));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(countRow(text, "## Work Log"), 1, "the daily must hold one Work Log heading");
		assert.equal(countRow(text, "### alpha"), 1, "the daily must hold one section heading");
		assert.equal(countRow(text, "- guard row"), 1, "the block text must appear once");
		assert.equal(countRow(text, stamp), 1, "the stamp must appear once");
		assert.ok(!fs.existsSync(block), "a written append must remove the block");
	});

	test("appends a second section after a block that carries a heading", () => {
		const home = makeHome();
		const target = dailyPath(home);
		const first = makeBlock(home, ["- alpha row", "### Key Decisions", "- alpha note"]);
		const firstRun = run(home, appendArgs(first, ["--section", "alpha"]));
		assert.equal(firstRun.status, 0, firstRun.stderr);
		const second = makeBlock(home, ["- beta row"]);
		const result = run(home, appendArgs(second, ["--section", "beta"]));
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(target, "utf8");
		assert.equal(countRow(text, "## Work Log"), 1, "the daily must hold one Work Log heading");
		assert.equal(countRow(text, "### alpha"), 1, "the daily must hold one alpha heading");
		assert.equal(countRow(text, "### beta"), 1, "the daily must hold one beta heading");
		assert.equal(countRow(text, "- beta row"), 1, "the second block must appear once");
		assert.ok(!fs.existsSync(second), "a written append must remove the block");
	});
});
