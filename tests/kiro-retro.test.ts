/**
 * The Kiro retro facts (platforms/kiro/scripts/retro.ts).
 *
 * A fixture V3 session store and adapter state stand in for a real session:
 * tool calls, a denial, a reviewer verdict, credits, context usage, compaction
 * metrics, permission decisions, and a session log. The retro writes nothing.
 *
 * Run: node --experimental-strip-types --test tests/kiro-retro.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { retroFacts } from "../platforms/kiro/scripts/retro.ts";
import { projectDir } from "../platforms/shared/notes/notes-paths.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retroScript = path.join(repoRoot, "platforms", "kiro", "scripts", "retro.ts");
const sessionId = "sess_abcdefab-1111-2222-3333-444444444444";
const otherSession = "sess_other";

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-kiro-retro-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

interface Fixture {
	kiro: string;
	home: string;
	cwd: string;
	notes: string;
	sessionLog: string;
}

function fixture(root: string): Fixture {
	const kiro = path.join(root, "kiro");
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	const notes = projectDir(cwd, home);
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(notes, "tasks"), { recursive: true });
	const taskNotes = path.join(notes, "tasks", "2026-11-20-task.md");
	fs.writeFileSync(taskNotes, "# Task\n");
	const day = "2026-11-20";
	const sessionLog = path.join(notes, "session-logs", day, `1200-${sessionId}.md`);
	fs.mkdirSync(path.dirname(sessionLog), { recursive: true });
	fs.writeFileSync(sessionLog, "# entry\n");
	const dir = path.join(kiro, "sessions", "hash", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const payloads = [
		{ type: "tool_call", toolName: "read_file", args: { path: path.join(notes, "tech", "a.md") } },
		{ type: "tool_call", toolName: "fs_write", args: { path: taskNotes, text: "# Task" } },
		{ type: "tool_call", toolName: "execute_bash", args: { command: "npm test" } },
		{ type: "tool_result", status: "denied", title: "Run Command", content: "blocked" },
		{ type: "sub_agent_start", subSessionId: "sub-1", subAgentName: "ca-reviewer", prompt: "Change key: 0123456789abcdef" },
		{ type: "sub_agent_complete", subSessionId: "sub-1", subAgentName: "ca-reviewer", response: "## Verdict\nApprove - fine.", status: "success" },
		{ type: "ContextualHookInvoked", name: "kiro-session-start" },
		{ type: "session_metadata", key: "creditSplit", value: { main: 1.5, delegated: 0.5, auxiliary: 0.25 } },
		{ type: "session_metadata", key: "contextUsage", value: { usagePercentage: 81.5 } },
	];
	fs.writeFileSync(path.join(dir, "messages.jsonl"), `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`);
	fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ id: sessionId, agentMode: "ca-companion", modelId: "claude-haiku-4.5" }));
	const state = path.join(kiro, "companion-agents", "state");
	fs.mkdirSync(path.join(state, "compact"), { recursive: true });
	fs.writeFileSync(
		path.join(state, "decisions.ndjson"),
		`${JSON.stringify({ session: sessionId, agent: "companion", tool: "execute_bash", verdict: "ask", reason: "push" })}\n${JSON.stringify({ session: otherSession, agent: "companion", tool: "execute_bash", verdict: "deny", reason: "other" })}\n`,
	);
	fs.writeFileSync(
		path.join(state, "compact", "metrics.ndjson"),
		`${JSON.stringify({ session: sessionId, skills: 2, docs: 3 })}\n${JSON.stringify({ session: otherSession })}\n`,
	);
	fs.writeFileSync(path.join(state, "compact", `${sessionId}.summaries.md`), "summary\n");
	return { kiro, home, cwd, notes, sessionLog };
}

describe("kiro retro: the facts", () => {
	test("the facts count the tools, the files, the denial, the review, the compaction, and the credits", () => {
		withTemp((root) => {
			const f = fixture(root);
			const result = retroFacts(f.kiro, sessionId, { cwd: f.cwd, home: f.home, now: new Date(2026, 10, 20, 12, 0) });
			assert.ok(result);
			assert.match(result.facts, /tool calls: 3/);
			assert.match(result.facts, /files changed: 1/);
			assert.match(result.facts, /independent reviews: 1 \(Approve\)/);
			assert.match(result.facts, /permission decisions: 1 \(ask 1\)/);
			assert.match(result.facts, /compactions: 1/);
			assert.match(result.facts, /credits: main 1\.5, delegated 0.5, auxiliary 0.25/);
			assert.match(result.facts, /context usage: 81\.5%/);
			assert.match(result.facts, /sub-agent runs: 1 \(reviewer 1\)/);
			assert.match(result.facts, /hook calls: kiro-session-start ×1/);
			assert.match(result.facts, new RegExp(f.sessionLog.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.facts, /model: claude-haiku-4\.5/);
			assert.match(result.instruction, /blameless retro/);
		});
	});

	test("a missing session returns null", () => {
		withTemp((root) => {
			const f = fixture(root);
			assert.equal(retroFacts(f.kiro, "sess_missing", { cwd: f.cwd, home: f.home }), null);
		});
	});

	test("the CLI prints the instruction and the facts", () => {
		withTemp((root) => {
			const f = fixture(root);
			const run = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					retroScript,
					`--session=${sessionId}`,
					`--cwd=${f.cwd}`,
					`--home=${f.home}`,
					`--kiro-home=${f.kiro}`,
				],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /blameless retro/);
			assert.match(run.stdout, /## Session facts/);
			assert.match(run.stdout, /tool calls: 3/);
		});
	});

	test("a missing session is an error, not empty facts", () => {
		withTemp((root) => {
			const f = fixture(root);
			const run = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", retroScript, "--session=sess_missing", `--home=${f.home}`, `--kiro-home=${f.kiro}`],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 1);
			assert.match(run.stderr, /no sess_missing/);
		});
	});
});

describe("kiro retro: the skill branch", () => {
	test("the shared retro skill branches to the Kiro reference", () => {
		const skill = fs.readFileSync(path.join(repoRoot, "content", "skills", "retro", "SKILL.md"), "utf8");
		assert.match(skill, /Running in Kiro CLI/);
		assert.match(skill, /references\/kiro\.md/);
		const reference = fs.readFileSync(path.join(repoRoot, "content", "skills", "retro", "references", "kiro.md"), "utf8");
		assert.match(reference, /retro\.ts/);
		assert.match(reference, /Session Facts/);
	});
});
