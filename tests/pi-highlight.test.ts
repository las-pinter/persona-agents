/**
 * The tokenizer behind the pretty read (platforms/pi/scripts/highlight.ts).
 *
 * Run: node --experimental-strip-types --test tests/pi-highlight.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { highlightLines, languageOf, type Span } from "../platforms/pi/scripts/highlight.ts";

/** The spans of the first line, as `kind:text` pairs. */
function firstLine(path: string, text: string): string[] {
	const line = highlightLines(path, text)[0] ?? [];
	return line.map((span: Span) => `${span.kind}:${span.text}`);
}

describe("pi highlight: the language of a path", () => {
	test("known extensions map to their language, everything else is plain", () => {
		assert.equal(languageOf("src/a.ts"), "ts");
		assert.equal(languageOf("src/a.tsx"), "ts");
		assert.equal(languageOf("src/lib.rs"), "rust");
		assert.equal(languageOf("run.py"), "python");
		assert.equal(languageOf("package.json"), "json");
		assert.equal(languageOf("README.md"), "markdown");
		assert.equal(languageOf("install.sh"), "shell");
		assert.equal(languageOf("notes.txt"), "plain");
	});
});

describe("pi highlight: the tokens", () => {
	test("a Rust line colours the keyword, the number, and the comment", () => {
		assert.deepEqual(firstLine("a.rs", "fn run() { let n = 42; // note"), [
			"keyword:fn",
			"plain: run() { ",
			"keyword:let",
			"plain: n = ",
			"number:42",
			"plain:; ",
			"comment:// note",
		]);
	});

	test("a template literal stays one string span", () => {
		const spans = firstLine("a.ts", "const s = `a ${b} c`;");
		assert.deepEqual(spans, ["keyword:const", "plain: s = ", "string:`a ${b} c`", "plain:;"]);
	});

	test("a Python comment starts at the hash", () => {
		const spans = firstLine("a.py", "def go():  # note");
		assert.deepEqual(spans, ["keyword:def", "plain: go():  ", "comment:# note"]);
	});

	test("an unterminated string runs to the end of the line and does not throw", () => {
		const spans = firstLine("a.ts", 'let s = "abc');
		assert.deepEqual(spans, ["keyword:let", "plain: s = ", "string:\"abc"]);
	});

	test("an unknown path is plain text, one span per line", () => {
		const lines = highlightLines("notes.txt", "fn let 42\n# not a comment");
		assert.deepEqual(lines, [
			[{ text: "fn let 42", kind: "plain" }],
			[{ text: "# not a comment", kind: "plain" }],
		]);
	});

	test("a markdown heading is one keyword span", () => {
		assert.deepEqual(firstLine("README.md", "## Layout"), ["keyword:## Layout"]);
	});

	test("the line count is preserved, blank lines included", () => {
		assert.equal(highlightLines("a.rs", "fn a() {}\n\n\nfn b() {}").length, 4);
	});
});
