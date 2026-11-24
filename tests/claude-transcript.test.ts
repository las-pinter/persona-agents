/**
 * Checks transcript.ts: a Claude Code transcript mapped to the entry shape
 * the shared compaction and session-log modules read.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { toEntries } from "../platforms/claude/scripts/transcript.ts";

const use = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

describe("claude transcript: the shared entry shape", () => {
	test("a file tool becomes the Pi tool name with its file_path as path", () => {
		// Arrange
		const transcript = [use("Read", { file_path: "/a" }), use("MultiEdit", { file_path: "/b", edits: [] })];

		// Act
		const entries = toEntries(transcript);

		// Assert
		assert.deepEqual(
			entries.map((entry) => (entry.message?.content as { name: string; arguments: { path: unknown } }[])[0]),
			[
				{ type: "toolCall", name: "read", arguments: { file_path: "/a", path: "/a" } },
				{ type: "toolCall", name: "edit", arguments: { file_path: "/b", edits: [], path: "/b" } },
			],
		);
	});

	test("another tool keeps its name and input", () => {
		const entries = toEntries([use("Bash", { command: "ls" })]);
		assert.deepEqual(entries[0].message?.content, [{ type: "toolCall", name: "Bash", arguments: { command: "ls" } }]);
	});

	test("meta and subagent lines are dropped; a compact boundary becomes a compaction", () => {
		const transcript = [
			{ type: "user", isMeta: true, message: { content: "meta" } },
			{ ...use("Write", { file_path: "/side" }), isSidechain: true },
			{ type: "system", subtype: "compact_boundary" },
			{ type: "system", subtype: "other" },
			{ type: "user", message: { content: "hello" } },
		];
		assert.deepEqual(toEntries(transcript), [{ type: "compaction" }, { type: "message", message: { role: "user", content: "hello" } }]);
	});
});
