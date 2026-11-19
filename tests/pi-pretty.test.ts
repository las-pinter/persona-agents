/**
 * The shaping behind the pretty results (platforms/pi/scripts/pretty.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-pretty.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { bashLines, groupGrep, treeLines } from "../platforms/pi/scripts/pretty.ts";

describe("pi pretty: a path list as a tree", () => {
	test("shared parents are drawn once, files under them", () => {
		assert.deepEqual(treeLines(["platforms/pi/scripts/a.ts", "platforms/pi/b.ts"]), [
			"└── platforms/",
			"    └── pi/",
			"        ├── scripts/",
			"        │   └── a.ts",
			"        └── b.ts",
		]);
	});

	test("siblings are sorted, directories before files", () => {
		const lines = treeLines(["src/z.ts", "src/a.ts", "src/lib/m.ts"]);
		assert.deepEqual(lines, ["└── src/", "    ├── lib/", "    │   └── m.ts", "    ├── a.ts", "    └── z.ts"]);
	});

	test("a leading ./ and a trailing slash are normalised, and nothing is empty", () => {
		assert.deepEqual(treeLines(["./a.ts", "b/"]), ["├── b/", "└── a.ts"]);
		assert.deepEqual(treeLines([]), []);
		assert.deepEqual(treeLines([""]), []);
	});
});

describe("pi pretty: grep grouped", () => {
	test("matches land under their file, with line and text", () => {
		const groups = groupGrep("src/a.ts:3:const x = 1\nsrc/a.ts:9:return x\nsrc/b.ts:1:use b\n");
		assert.deepEqual(groups, [
			{ file: "src/a.ts", matches: ["3:const x = 1", "9:return x"] },
			{ file: "src/b.ts", matches: ["1:use b"] },
		]);
	});

	test("a line with no location keeps its own group, so nothing is dropped", () => {
		assert.deepEqual(groupGrep("No matches found.\n"), [{ file: "No matches found.", matches: [] }]);
		assert.deepEqual(groupGrep(""), []);
	});
});

describe("pi pretty: bash output classified", () => {
	test("a failure line wins over a pass on the same line", () => {
		const lines = bashLines("ok 12 passed\nFAIL 2 failed\n  error[E0308]: mismatched types\n");
		assert.deepEqual(
			lines.map((line) => line.kind),
			["pass", "fail", "fail"],
		);
	});

	test("a warning is neither a pass nor a failure", () => {
		assert.deepEqual(
			bashLines("warning: unused import\n").map((line) => line.kind),
			["warn"],
		);
	});

	test("ordinary output stays plain, and the trailing newline adds no empty row", () => {
		const lines = bashLines("building\ndone\n");
		assert.equal(lines.length, 2);
		assert.deepEqual(
			lines.map((line) => line.kind),
			["plain", "plain"],
		);
	});
});
