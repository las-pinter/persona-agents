/**
 * The shell lexer contract for the operator before each segment
 * (platforms/shared/shell/shell-parse.ts).
 *
 * The operator is how a filter knows it reads from a pipe, and how the cd fold
 * keeps the separator of the segment it folds into. Run:
 * node --experimental-strip-types --test tests/shell-parse.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parseShellCommand } from "../platforms/shared/shell/shell-parse.ts";

function parsed(command: string): { segments: string[]; separators: string[] } {
	const result = parseShellCommand(command);
	return { segments: result.segments, separators: result.separators };
}

describe("shell parser: the operator before each segment", () => {
	test("a plain command starts at the start", () => {
		assert.deepEqual(parsed("git status"), { segments: ["git status"], separators: ["start"] });
	});

	test("a pipe and a pipe-and mark the segment that reads from it", () => {
		assert.deepEqual(parsed("git log | tail -5"), { segments: ["git log", "tail -5"], separators: ["start", "|"] });
		assert.deepEqual(parsed("git log | grep x | head -1").separators, ["start", "|", "|"]);
		assert.deepEqual(parsed("git log |& tail -5").separators, ["start", "|&"]);
	});

	test("every compound operator is recorded", () => {
		const { segments, separators } = parsed("a && b; c\nd || e & f |& g");
		assert.deepEqual(segments, ["a", "b", "c", "d", "e", "f", "g"]);
		assert.deepEqual(separators, ["start", "&&", ";", "\n", "||", "&", "|&"]);
	});

	test("the cd fold keeps the folded segment's first operator", () => {
		assert.deepEqual(parsed("cd x && git commit"), { segments: ["cd x && git commit"], separators: ["start"] });
		assert.deepEqual(parsed("a; cd x && git commit"), {
			segments: ["a", "cd x && git commit"],
			separators: ["start", ";"],
		});
	});

	test("a segment from a substitution is marked sub, not a pipe member", () => {
		assert.deepEqual(parsed("echo $(git log) && git commit"), {
			segments: ["echo $(git log)", "git commit", "git log"],
			separators: ["start", "&&", "sub"],
		});
	});

	test("an unsupported command still carries one separator per segment", () => {
		const result = parseShellCommand("cat <<EOF\ngit push\nEOF");
		assert.equal(result.unsupported, "heredoc");
		assert.equal(result.separators.length, result.segments.length);
	});
});
