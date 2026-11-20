/**
 * The Kiro V3 session-store reader (platforms/kiro/scripts/session-store.ts).
 *
 * A fixture `messages.jsonl` is built in a temp Kiro home, so the test never
 * reads the owner's real sessions. The reader maps Kiro payloads onto the
 * shared entry shape; the shared manifest and retro are exercised over the
 * result to prove the mapping carries what they need.
 *
 * Run: node --experimental-strip-types --test tests/kiro-session.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildManifest } from "../platforms/shared/compaction/manifest.ts";
import { summarizeSession } from "../platforms/shared/retro/retro.ts";
import {
	findSessionDir,
	mapPayloads,
	readJsonLines,
	readSession,
	sessionDirs,
} from "../platforms/kiro/scripts/session-store.ts";

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-session-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const sessionId = "sess_11111111-2222-3333-4444-555555555555";

function writeSession(root: string, payloads: Record<string, unknown>[], meta?: Record<string, unknown>): string {
	const dir = path.join(root, "sessions", "abc123", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	// The real V3 store wraps each payload; the reader must unwrap it.
	const lines = payloads.map((payload) => JSON.stringify({ timestamp: "2026-11-20T00:00:00.000Z", payload }));
	fs.writeFileSync(path.join(dir, "messages.jsonl"), `${lines.join("\n")}\n`);
	if (meta) fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(meta));
	return dir;
}

const payloads = (): Record<string, unknown>[] => [
	{ type: "user", content: "Please fix the bug." },
	{ type: "assistant", content: "On it." },
	{ type: "tool_call", toolName: "read_file", args: { path: "/repo/src/a.ts", offset: null, limit: null } },
	{ type: "tool_result", status: "completed", content: "source" },
	{ type: "tool_call", toolName: "load_resource", args: { id: "skill::probe-skill" } },
	{ type: "tool_call", toolName: "fs_write", args: { path: "/repo/src/a.ts", text: "fixed" } },
	{ type: "tool_call", toolName: "execute_bash", args: { command: "npm test" } },
	{ type: "tool_result", status: "denied", title: "Run Command", content: "blocked by the gate" },
	{ type: "sub_agent_start", subSessionId: "sub-1", subAgentName: "pa-reviewer", prompt: "Change key: abc123def456" },
	{
		type: "sub_agent_complete",
		subSessionId: "sub-1",
		subAgentName: "pa-reviewer",
		response: "## Summary\nFine.\n\n## Verdict\nApprove - the change is small.",
		status: "success",
	},
	{ type: "ContextualHookInvoked", name: "probe-stop", status: "completed" },
	{ type: "session_metadata", key: "creditSplit", value: { main: 1.5, delegated: 0.5, auxiliary: 0.25 } },
	{ type: "session_metadata", key: "contextUsage", value: { usagePercentage: 12.5 } },
];

describe("kiro session store: finding and reading", () => {
	test("a bad JSONL line is skipped and the rest survive", () => {
		withTemp((root) => {
			const dir = writeSession(root, []);
			fs.writeFileSync(path.join(dir, "messages.jsonl"), '{"type":"user","content":"a"}\nnot json\n{"type":"assistant","content":"b"}\n');
			assert.equal(readJsonLines(path.join(dir, "messages.jsonl")).length, 2);
		});
	});

	test("the session folder is found across workspace hashes and a bad id is refused", () => {
		withTemp((root) => {
			const dir = writeSession(root, payloads());
			assert.equal(findSessionDir(root, sessionId), dir);
			assert.equal(findSessionDir(root, "sess_../../etc"), null);
			assert.equal(findSessionDir(root, "sess_missing"), null);
			assert.equal(findSessionDir(root, "11111111"), null);
		});
	});

	test("readSession reads the metadata and the facts", () => {
		withTemp((root) => {
			writeSession(root, payloads(), { id: sessionId, agentMode: "pa-companion", modelId: "claude-haiku-4.5" });
			const session = readSession(root, sessionId);
			assert.ok(session);
			assert.equal(session.meta?.agentMode, "pa-companion");
			assert.equal(session.hooks.length, 1);
			assert.equal(session.credits?.main, 1.5);
			assert.equal(session.contextUsage, 12.5);
			assert.equal(readSession(root, "sess_nope"), null);
			assert.equal(sessionDirs(root).length, 1);
		});
	});
});

describe("kiro session store: the shared entry shape", () => {
	test("tools map to the neutral names and keep their paths", () => {
		const facts = mapPayloads(payloads(), { skillsDir: "/kiro/skills" });
		const calls = facts.entries.flatMap((entry) =>
			entry.type === "message" && Array.isArray(entry.message?.content)
				? entry.message.content.flatMap((block) =>
						(block as { type?: string }).type === "toolCall"
							? [(block as { name: string; arguments: Record<string, unknown> })]
							: [],
					)
				: [],
		);
		assert.deepEqual(
			calls.map((call) => call.name),
			["read", "read", "write", "bash"],
		);
		assert.equal(calls[0].arguments.path, "/repo/src/a.ts");
		assert.equal(calls[1].arguments.path, "/kiro/skills/probe-skill/SKILL.md");
		assert.equal(calls[2].arguments.path, "/repo/src/a.ts");
		assert.equal(calls[3].arguments.command, "npm test");
	});

	test("a denied call, a reviewer verdict, credits, and usage survive", () => {
		const facts = mapPayloads(payloads(), { skillsDir: "/kiro/skills" });
		assert.equal(facts.denials.length, 1);
		assert.match(facts.denials[0].message, /blocked by the gate/);
		assert.equal(facts.subAgents.length, 1);
		assert.equal(facts.subAgents[0].agent, "pa-reviewer");
		assert.equal(facts.subAgents[0].status, "success");
		const review = facts.entries.find((entry) => entry.customType === "persona-agents:review");
		assert.ok(review);
		assert.equal((review.data as { verdict: string }).verdict, "Approve");
		assert.equal(facts.credits?.delegated, 0.5);
		assert.equal(facts.contextUsage, 12.5);
	});

	test("a reviewer run with no verdict adds no review entry", () => {
		const facts = mapPayloads(
			[{ type: "sub_agent_start", subSessionId: "s", subAgentName: "pa-reviewer", prompt: "" }, { type: "sub_agent_complete", subSessionId: "s", subAgentName: "pa-reviewer", response: "no heading", status: "success" }],
			{ skillsDir: "/kiro/skills" },
		);
		assert.equal(facts.subAgents.length, 1);
		assert.equal(facts.entries.some((entry) => entry.customType === "persona-agents:review"), false);
	});
});

describe("kiro session store: the shared modules read the mapping", () => {
	test("the compaction manifest finds the skill, the session notes, and the docs", () => {
		withTemp((root) => {
			const notes = path.join(root, "notes");
			const sessions = path.join(notes, "sessions");
			fs.mkdirSync(sessions, { recursive: true });
			const sessionNotes = path.join(sessions, "2026-11-20-task.md");
			fs.writeFileSync(sessionNotes, "# Task\n\n- **Study:** none\n\n## Pinned\n");
			const doc = path.join(notes, "summary.md");
			fs.writeFileSync(doc, "# Summary\n");
			const facts = mapPayloads(
				[
					{ type: "tool_call", toolName: "read_file", args: { path: doc } },
					{ type: "tool_call", toolName: "fs_write", args: { path: sessionNotes, text: "# Task" } },
					{ type: "tool_call", toolName: "load_resource", args: { id: "skill::study" } },
				],
				{ skillsDir: path.join(root, "skills") },
			);
			const manifest = buildManifest(facts.entries, notes);
			assert.equal(manifest.sessionNotes, sessionNotes);
			assert.deepEqual(manifest.skills, ["study"]);
			assert.ok(manifest.docs.includes(doc));
		});
	});

	test("the retro counts the tool calls, the changed files, and the review", () => {
		withTemp(() => {
			const facts = mapPayloads(payloads(), { skillsDir: "/kiro/skills" });
			const text = summarizeSession({ entries: facts.entries, decisions: [], journal: [] });
			assert.match(text, /tool calls: 4/);
			assert.match(text, /files changed: 1/);
			assert.match(text, /independent reviews: 1 \(Approve\)/);
		});
	});
});
