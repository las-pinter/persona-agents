/**
 * The inert-part grammar (platforms/shared/shell/inert.ts): a project
 * formatter and a read-only filter. Run:
 * node --experimental-strip-types --test tests/shell-inert.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { isFormatter, isInertFilter } from "../platforms/shared/shell/inert.ts";

describe("shell inert: a formatter", () => {
	const YES: [string, string[]][] = [
		["cargo", ["fmt"]],
		["cargo", ["fmt", "--", "--check"]],
		["rustfmt", []],
		["rustfmt", ["src/main.rs"]],
		["ruff", ["format"]],
		["black", ["."]],
		["prettier", ["--write", "src/a.ts"]],
		["prettier", ["-w", "src/a.ts"]],
		["gofmt", ["-w", "main.go"]],
		["gofmt", ["-lw", "."]],
	];
	for (const [command, args] of YES) {
		test(`${command} ${args.join(" ")}`, () => {
			assert.equal(isFormatter(command, args), true);
		});
	}

	const NO: [string, string[]][] = [
		["cargo", []],
		["cargo", ["test"]],
		["cargo", ["+nightly", "fmt"]],
		["ruff", ["check", "--fix"]],
		["prettier", ["src/a.ts"]],
		["gofmt", ["main.go"]],
		["npm", ["run", "fmt"]],
		["npx", ["prettier", "--write"]],
	];
	for (const [command, args] of NO) {
		test(`not a formatter: ${command} ${args.join(" ")}`, () => {
			assert.equal(isFormatter(command, args), false);
		});
	}
});

describe("shell inert: a read-only filter", () => {
	const YES: [string, string[]][] = [
		["grep", ["-v", "Passed"]],
		["grep", ["-A", "3", "foo"]],
		["grep", ["-A3", "foo"]],
		["grep", ["-e", "foo"]],
		["grep", ["-ve", "foo"]],
		["grep", ["--regexp=foo"]],
		["grep", ["--include=*.ts", "foo"]],
		["grep", ["-i", "foo"]],
		["grep", ["-c", "pat"]],
		["grep", ["-l", "pat"]],
		["head", ["-n", "5"]],
		["head", ["-n5"]],
		["tail", ["-5"]],
		["tail", ["-f"]],
		["tail", ["-n", "5"]],
		["wc", []],
		["wc", ["-l"]],
		["sort", ["-rn"]],
		["sort", ["-k1,1"]],
		["sort", ["-k", "1,1"]],
		["sort", ["-t,"]],
		["sort", ["-t", ","]],
		["uniq", []],
		["uniq", ["-c"]],
		["uniq", ["-f", "2"]],
		// GNU accepts an unambiguous long-option prefix; a safe value option
		// keeps the filter inert.
		["sort", ["--ke", "1,1"]],
		["sort", ["--ke=1,1"]],
		["grep", ["--regex", "foo"]],
	];
	for (const [command, args] of YES) {
		test(`${command} ${args.join(" ")}`, () => {
			assert.equal(isInertFilter(command, args), true);
		});
	}

	const NO: [string, string[]][] = [
		["grep", ["foo", "file"]],
		["grep", ["-r", "foo", "."]],
		["grep", ["-f", "pats", "foo"]],
		["grep", ["--file=pats", "foo"]],
		["grep", ["-r", "foo"]],
		["grep", ["-R", "foo"]],
		["grep", ["--recursive", "foo"]],
		["grep", ["foo", "--"]],
		["head", ["file"]],
		["tail", ["file"]],
		["wc", ["file"]],
		["wc", ["--files0-from=names"]],
		["sort", ["file"]],
		["sort", ["-o", "out"]],
		["sort", ["-oout"]],
		["sort", ["--output=out"]],
		["sort", ["--compress-program=gzip"]],
		["sort", ["--files0-from=list"]],
		// A blocked long option matches by prefix too, as GNU getopt does.
		["sort", ["--out=out"]],
		["sort", ["--outp=out"]],
		["sort", ["--compress-prog=gzip"]],
		["sort", ["--compress-prog", "gzip"]],
		["sort", ["--files0=list"]],
		["sort", ["--random-sourc=seed"]],
		["wc", ["--files0=names"]],
		["grep", ["--exclude-f=pats", "foo"]],
		["grep", ["--recursiv", "foo"]],
		["uniq", ["in"]],
		["uniq", ["in", "out"]],
		["cat", []],
	];
	for (const [command, args] of NO) {
		test(`not an inert filter: ${command} ${args.join(" ")}`, () => {
			assert.equal(isInertFilter(command, args), false);
		});
	}
});
