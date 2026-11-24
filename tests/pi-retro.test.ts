/**
 * `/retro` session facts (platforms/shared/retro/retro.ts).
 *
 * The retro is print-only and evidence-based: these tests pin what it counts,
 * what it caps, and that a broken log line never breaks the retro.
 *
 * Run: node --experimental-strip-types --test tests/pi-retro.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import type { EntryLike } from "../platforms/shared/compaction/manifest.ts";
import { parseDecisions, RETRO_INSTRUCTION, retroMessage, sessionDecisions, summarizeSession, toolCalls } from "../platforms/shared/retro/retro.ts";

function assistant(...calls: { name: string; args: Record<string, unknown> }[]): EntryLike {
	return {
		type: "message",
		message: { role: "assistant", content: calls.map((call, index) => ({ type: "toolCall", id: `c${index}`, name: call.name, arguments: call.args })) },
	};
}

/** An entry as the retro reads it: tool calls, reviews, and a compaction summary. */
type FactEntry = EntryLike & { customType?: string; data?: unknown; summary?: string };

const decision = (overrides: Record<string, unknown>): string => JSON.stringify({ at: "2026-01-01T00:00:00Z", session: "s1", agent: "persona-agents:companion", ...overrides });

describe("pi retro: the decisions log", () => {
	test("bad and blank lines are skipped, good ones are kept", () => {
		const text = [decision({ tool: "bash", verdict: "allow" }), "", "{ not json", decision({ tool: "bash", verdict: "ask" }), ""].join("\n");
		const lines = parseDecisions(text);
		assert.equal(lines.length, 2);
		assert.deepEqual(lines.map((line) => line.verdict), ["allow", "ask"]);
	});

	test("one session's lines are told apart from another's", () => {
		const lines = parseDecisions([decision({ verdict: "allow" }), decision({ session: "s2", verdict: "deny" })].join("\n"));
		const mine = sessionDecisions(lines, "s1");
		assert.equal(mine.length, 1);
		assert.equal(mine[0].verdict, "allow");
	});
});

describe("pi retro: the facts", () => {
	test("tool calls are counted and the changed files are listed", () => {
		const entries = [
			assistant({ name: "read", args: { path: "a.ts" } }, { name: "read", args: { path: "b.ts" } }),
			assistant({ name: "write", args: { path: "src/gate.ts" } }),
			assistant({ name: "edit", args: { path: "src/gate.ts" } }),
		];
		assert.equal(toolCalls(entries).length, 4);
		const facts = summarizeSession({ entries, decisions: [] });
		assert.match(facts, /tool calls: 4 \(read ×2, write ×1, edit ×1\)/);
		assert.match(facts, /files changed: 1/);
		assert.match(facts, /- src\/gate\.ts/);
	});

	test("compactions, reviews, and permission verdicts are reported", () => {
		const entries: FactEntry[] = [
			{ type: "compaction", summary: "s" },
			{ type: "custom", customType: "persona-agents:review", data: { verdict: "Approve" } },
			{ type: "custom", customType: "persona-agents:review", data: { verdict: "Request Changes" } },
		];
		const decisions = parseDecisions(
			[
				decision({ tool: "bash", verdict: "allow" }),
				decision({ tool: "bash", verdict: "ask", reason: "publishing needs approval" }),
				decision({ tool: "write", verdict: "deny", reason: "read-only" }),
			].join("\n"),
		);
		const facts = summarizeSession({ entries, decisions });
		assert.match(facts, /compactions: 1/);
		assert.match(facts, /independent reviews: 2 \(Approve, Request Changes\)/);
		assert.match(facts, /permission decisions: 3 \(allow 1, ask 1, deny 1\)/);
		assert.match(facts, /ask bash — publishing needs approval/);
		assert.match(facts, /deny write — read-only/);
	});

	test("long lists are capped instead of flooding the retro", () => {
		const files = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
		const entries = files.map((file) => assistant({ name: "write", args: { path: file } }));
		const facts = summarizeSession({ entries, decisions: [] });
		assert.match(facts, /files changed: 25/);
		assert.match(facts, /… and 5 more/);
	});

	test("journal entries and the instruction are named", () => {
		const facts = summarizeSession({ entries: [], decisions: [], journal: ["/notes/journal/2026-01-01/1200-s1.md"] });
		assert.match(facts, /journal:/);
		assert.match(facts, /1200-s1\.md/);
		assert.match(RETRO_INSTRUCTION, /print only/);
		assert.match(RETRO_INSTRUCTION, /Write nothing durable/);
	});

	test("the retro message names the skill file before the facts", () => {
		const message = retroMessage("/pkg/content/skills/retro/SKILL.md", "facts: none");
		assert.match(message, /^Read the retro skill at \/pkg\/content\/skills\/retro\/SKILL\.md/);
		assert.match(message, /facts: none$/);
	});
});
