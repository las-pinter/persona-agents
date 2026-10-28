/**
 * Tests for the journal write script: the read-only check report.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
	AGENT,
	cleanup,
	dailyPath,
	digestOf,
	fileLines,
	makeHome,
	reportDigest,
	run,
	seedTarget,
	todayName,
} from "./journal-write.fixtures.ts";

afterEach(cleanup);

describe("check", () => {
	test("prints the digest and the body of a present target", () => {
		const home = makeHome();
		const text = `# ${todayName()}\n\nday row one\nday row two\n`;
		const target = seedTarget(dailyPath(home), text);
		const result = run(home, ["check", "--agent", AGENT, "--show"]);
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(result.stdout);
		assert.ok(rows.includes(`path ${target}`), "the report must name the target");
		assert.ok(rows.includes("state present"), "a present target must report present");
		assert.ok(rows.includes(`lines ${fileLines(text).length}`), "the report must count the rows");
		assert.ok(rows.includes("limit 100"), "the report must print the limit");
		const digest = reportDigest(result.stdout);
		assert.match(digest, /^[0-9a-f]{64}$/, "the digest must be 64 lowercase hex digits");
		assert.equal(digest, digestOf(fs.readFileSync(target)), "the digest must cover the target bytes");
		const open = result.stdout.indexOf("--- body ---\n");
		const close = result.stdout.indexOf("--- end body ---", open);
		assert.ok(open >= 0 && close > open, "the body must sit between the two markers");
		assert.equal(result.stdout.slice(open + "--- body ---\n".length, close), text);
	});

	test("reports an absent target as new", () => {
		const home = makeHome();
		const result = run(home, ["check", "--agent", AGENT]);
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(result.stdout);
		assert.ok(rows.includes("state absent"), "a missing target must report absent");
		assert.ok(rows.includes("lines 0"), "a missing target has no rows");
		assert.ok(rows.includes("digest new"), "a missing target has no digest");
	});

	test("prints an empty body between the markers", () => {
		const home = makeHome();
		seedTarget(dailyPath(home), "");
		const result = run(home, ["check", "--agent", AGENT, "--show"]);
		assert.equal(result.status, 0, result.stderr);
		const rows = fileLines(result.stdout);
		assert.ok(rows.includes("state present"), "an empty target is present");
		assert.ok(rows.includes("lines 0"), "an empty target has no rows");
		assert.equal(reportDigest(result.stdout), digestOf(""), "the digest must cover the empty text");
		assert.equal(result.stdout.split("--- body ---\n").length, 2, "the body opens once");
		assert.equal(result.stdout.split("--- end body ---\n").length, 2, "the body closes once");
	});

	test("prints a body with no final newline and still closes it", () => {
		const home = makeHome();
		seedTarget(dailyPath(home), "# 2026-10-28\n\nlast row");
		const result = run(home, ["check", "--agent", AGENT, "--show"]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes("last row\n--- end body ---\n"), "the marker starts a new row");
	});
});
