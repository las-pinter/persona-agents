/**
 * The Kiro compaction hooks (platforms/kiro/scripts/compact.ts).
 *
 * A fixture V3 session store and notes tree prove the manifest names the
 * task notes, the skills, and the documents, and that PostCompact keeps the
 * summary, writes one metrics line, and prints the reload list. The tests never
 * compact a real session.
 *
 * Run: node --experimental-strip-types --test tests/kiro-compact.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	finishCompaction,
	manifestFile,
	metricsFile,
	prepareCompaction,
	summariesFile,
} from "../platforms/kiro/scripts/compact.ts";
import { readSession } from "../platforms/kiro/scripts/session-store.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compactScript = path.join(repoRoot, "platforms", "kiro", "scripts", "compact.ts");
const sessionId = "sess_12345678-1234-1234-1234-123456789012";

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-kiro-compact-"));
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
	taskNotes: string;
	doc: string;
}

/** A session that read a doc, wrote its task notes, and loaded a skill. */
function fixture(root: string): Fixture {
	const kiro = path.join(root, "kiro");
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	const notes = path.join(home, "agent-notes", "project-notes", "common");
	fs.mkdirSync(path.join(notes, "rules"), { recursive: true });
	fs.mkdirSync(path.join(notes, "tech"), { recursive: true });
	fs.mkdirSync(path.join(notes, "tasks"), { recursive: true });
	fs.writeFileSync(path.join(notes, "rules", "one.md"), "# One\n");
	fs.writeFileSync(path.join(notes, "summary.md"), "# Summary\n");
	fs.writeFileSync(path.join(notes, "tech", "a.md"), "# Tech\n");
	const taskNotes = path.join(notes, "tasks", "2026-11-20-task.md");
	fs.writeFileSync(taskNotes, "# Task\n\n- **Study:** none\n\n## Pinned\n");
	const dir = path.join(kiro, "sessions", "hash", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const payloads = [
		{ type: "tool_call", toolName: "read_file", args: { path: path.join(notes, "tech", "a.md") } },
		{ type: "tool_call", toolName: "fs_write", args: { path: taskNotes, text: "# Task" } },
		{ type: "tool_call", toolName: "load_resource", args: { id: "skill::study" } },
		{ type: "session_metadata", key: "contextUsage", value: { usagePercentage: 81.5 } },
	];
	fs.writeFileSync(path.join(dir, "messages.jsonl"), `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`);
	return { kiro, home, cwd, notes, taskNotes, doc: path.join(notes, "tech", "a.md") };
}

describe("kiro compaction: the manifest", () => {
	test("the state names the task notes, the skill, and the docs", () => {
		withTemp((root) => {
			const f = fixture(root);
			const { manifest, instructions } = prepareCompaction(f.kiro, f.cwd, f.home, sessionId, new Date("2026-11-20T10:00:00Z"));
			assert.equal(manifest.taskNotes, f.taskNotes);
			assert.deepEqual(manifest.skills, ["study"]);
			assert.ok(manifest.docs.includes(f.doc));
			assert.ok(manifest.docs.includes(path.join(f.notes, "summary.md")));
			assert.match(instructions, /Compaction instructions/);
			assert.match(instructions, new RegExp(f.taskNotes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.ok(fs.existsSync(manifestFile(path.join(f.kiro, "persona-agents", "state"), sessionId)));
		});
	});

	test("a resumed session that only read its notes gets them from the Sessions line", () => {
		withTemp((root) => {
			const f = fixture(root);
			const notesFile = path.join(f.notes, "tasks", "2026-11-20-task.md");
			fs.writeFileSync(notesFile, `# Task\n\n- **Status:** open\n- **Sessions:** ${sessionId}\n`);
			// A second open file makes the only-open fallback useless, so only the
			// Sessions line can choose the target.
			fs.writeFileSync(path.join(f.notes, "tasks", "2026-11-19-other.md"), "# Other\n\n- **Status:** open\n");
			const dir = path.join(f.kiro, "sessions", "hash", sessionId);
			fs.writeFileSync(path.join(dir, "messages.jsonl"), `${JSON.stringify({ type: "tool_call", toolName: "read_file", args: { path: f.doc } })}\n`);
			const { manifest } = prepareCompaction(f.kiro, f.cwd, f.home, sessionId, new Date("2026-11-20T10:00:00Z"));
			assert.equal(manifest.taskNotes, notesFile);
			assert.equal(manifest.session, sessionId);
		});
	});

	test("a missing session store yields an empty manifest, not a failure", () => {
		withTemp((root) => {
			const f = fixture(root);
			const { manifest, instructions } = prepareCompaction(f.kiro, f.cwd, f.home, "sess_missing", new Date("2026-11-20T10:00:00Z"));
			assert.equal(manifest.taskNotes, "");
			assert.deepEqual(manifest.skills, []);
			assert.match(instructions, /Compaction instructions/);
		});
	});
});

describe("kiro compaction: the summary and the reload", () => {
	test("PostCompact keeps the summary, writes metrics, and prints the reload list", () => {
		withTemp((root) => {
			const f = fixture(root);
			prepareCompaction(f.kiro, f.cwd, f.home, sessionId, new Date("2026-11-20T10:00:00Z"));
			const { reload } = finishCompaction(
				f.kiro,
				f.cwd,
				f.home,
				sessionId,
				{ summary: "We were porting Kiro.", summaryPath: "/tmp/summary.md", trigger: "auto", contextUsage: 81.5 },
				new Date("2026-11-20T10:01:00Z"),
			);
			const state = path.join(f.kiro, "persona-agents", "state");
			assert.match(fs.readFileSync(summariesFile(state, sessionId), "utf8"), /We were porting Kiro\./);
			assert.match(reload, /Read the task notes file first/);
			assert.match(reload, new RegExp(f.taskNotes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(reload, /- study/);
			assert.match(reload, /load_resource/);
			const metrics = fs.readFileSync(metricsFile(state), "utf8").trim().split("\n");
			assert.equal(metrics.length, 1);
			const line = JSON.parse(metrics[0]) as { session: string; skills: number; docs: number; contextUsage: number };
			assert.equal(line.session, sessionId);
			assert.equal(line.skills, 1);
			assert.ok(line.docs >= 2);
			assert.equal(line.contextUsage, 81.5);
		});
	});

	test("a PostCompact without a saved manifest rebuilds it from the store", () => {
		withTemp((root) => {
			const f = fixture(root);
			const state = path.join(f.kiro, "persona-agents", "state");
			fs.mkdirSync(path.join(state, "compact"), { recursive: true });
			const { reload } = finishCompaction(f.kiro, f.cwd, f.home, sessionId, { summary: "s" }, new Date("2026-11-20T10:01:00Z"));
			assert.match(reload, new RegExp(f.taskNotes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});
	});

	test("a PostCompact rebuild uses the session id when no manifest was saved", () => {
		withTemp((root) => {
			const f = fixture(root);
			const notesFile = path.join(f.notes, "tasks", "2026-11-20-task.md");
			fs.writeFileSync(notesFile, `# Task\n\n- **Status:** open\n- **Sessions:** ${sessionId}\n`);
			// Only the Sessions line can choose the target; the fallback sees two open files.
			fs.writeFileSync(path.join(f.notes, "tasks", "2026-11-19-other.md"), "# Other\n\n- **Status:** open\n");
			const dir = path.join(f.kiro, "sessions", "hash", sessionId);
			fs.writeFileSync(path.join(dir, "messages.jsonl"), `${JSON.stringify({ type: "tool_call", toolName: "read_file", args: { path: f.doc } })}\n`);
			const state = path.join(f.kiro, "persona-agents", "state");
			fs.mkdirSync(path.join(state, "compact"), { recursive: true });
			const { reload } = finishCompaction(f.kiro, f.cwd, f.home, sessionId, { summary: "s" }, new Date("2026-11-20T10:01:00Z"));
			assert.ok(reload.includes(notesFile));
			assert.ok(reload.includes(`Session id: ${sessionId}`));
		});
	});
});

describe("kiro compaction: the CLI", () => {
	const run = (mode: string, f: Fixture, input: Record<string, unknown>) =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", compactScript, mode, `--home=${f.home}`, `--kiro-home=${f.kiro}`],
			{ input: JSON.stringify(input), encoding: "utf8" },
		);

	test("PreCompact and PostCompact read their events from stdin", () => {
		withTemp((root) => {
			const f = fixture(root);
			const pre = run("pre", f, { session_id: sessionId, cwd: f.cwd, hook_event_name: "PreCompact" });
			assert.equal(pre.status, 0, pre.stderr);
			assert.match(pre.stdout, /Compaction instructions/);
			const post = run("post", f, {
				session_id: sessionId,
				cwd: f.cwd,
				hook_event_name: "PostCompact",
				summary: "the summary",
				summary_path: "/tmp/summary.md",
			});
			assert.equal(post.status, 0, post.stderr);
			assert.match(post.stdout, /After compaction: reload before you continue/);
			assert.equal(readSession(f.kiro, sessionId)?.contextUsage, 81.5);
		});
	});
});
