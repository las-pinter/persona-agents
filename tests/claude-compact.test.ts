/**
 * Checks the compaction recovery hooks (compact.mjs): the manifest scan, the
 * summary instructions, the reload context, and the three hook processes.
 *
 * Run: node --experimental-strip-types --test tests/claude-compact.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendLog,
	buildManifest,
	lastBoundary,
	reloadContext,
	summaryInstructions,
} from "../platforms/claude/scripts/compact.mjs";
import { notesListsSession, pinnedDocs, studyPath } from "../platforms/shared/notes/notes.ts";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms", "claude", "scripts", "compact.mjs");
const COMPANION = "persona-agents:companion";

interface Env {
	tmp: string;
	home: string;
	cwd: string;
	notes: string;
	data: string;
}

/** A temp home, a non-git working folder (project "common"), and a plugin data folder. */
function withEnv(fn: (env: Env) => void): void {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-compact-")));
	try {
		const home = path.join(tmp, "home");
		const cwd = path.join(tmp, "work");
		fs.mkdirSync(cwd, { recursive: true });
		fn({ tmp, home, cwd, notes: path.join(home, "agent-notes", "project-notes", "common"), data: path.join(tmp, "data") });
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** One assistant transcript entry with one tool_use. */
function use(name: string, input: Record<string, unknown>, sidechain = false): Record<string, unknown> {
	return { type: "assistant", isSidechain: sidechain, message: { content: [{ type: "tool_use", name, input }] } };
}

function sessionNotesText(study: string, pinned: string[], sessions: string[] = []): string {
	return [
		"# Task",
		"",
		"- **Started:** 2026-01-01",
		"- **Status:** open",
		`- **Study:** ${study}`,
		...(sessions.length ? [`- **Sessions:** ${sessions.join(", ")}`] : []),
		"",
		"## Plan",
		"",
		"- [ ] step",
		"",
		"## Pinned",
		"",
		...pinned.map((p) => `- ${p}`),
		"",
		"## Log",
		"",
		"- 2026-01-01 09:00 — started",
		"",
	].join("\n");
}

describe("compact: manifest scan", () => {
	test("skills come in last-use order, without duplicates and without sidechain calls", () => {
		withEnv(({ notes }) => {
			const manifest = buildManifest(
				[use("Skill", { skill: "a" }), use("Skill", { skill: "b" }), use("Skill", { skill: "a" }), use("Skill", { skill: "x" }, true)],
				notes,
			);
			assert.deepEqual(manifest.skills, ["b", "a"]);
		});
	});

	test("the active session notes are the last ones written; their study and pins are docs", () => {
		withEnv(({ notes, tmp }) => {
			const first = path.join(notes, "sessions", "2026-01-01-one.md");
			const second = path.join(notes, "sessions", "2026-01-02-two.md");
			const study = path.join(notes, "studies", "2026-01-01-s", "study.md");
			const pinned = path.join(tmp, "spec.md");
			write(first, sessionNotesText("none", []));
			write(second, sessionNotesText(study, [pinned]));
			const manifest = buildManifest([use("Write", { file_path: first }), use("Edit", { file_path: second })], notes);
			assert.equal(manifest.sessionNotes, second);
			assert.ok(manifest.docs.includes(study));
			assert.ok(manifest.docs.includes(pinned));
			assert.ok(!manifest.docs.includes(second));
		});
	});

	test("project rules, the summary, and read project notes are docs; source files and journal entries are not", () => {
		withEnv(({ notes, cwd }) => {
			write(path.join(notes, "rules", "r.md"), "# r");
			write(path.join(notes, "summary.md"), "# s");
			const tech = path.join(notes, "tech", "t.md");
			const journal = path.join(notes, "journal", "2026-01-01", "0900-x.md");
			const source = path.join(cwd, "src", "main.ts");
			const manifest = buildManifest(
				[use("Read", { file_path: tech }), use("Read", { file_path: journal }), use("Read", { file_path: source })],
				notes,
			);
			assert.ok(manifest.docs.includes(path.join(notes, "rules", "r.md")));
			assert.ok(manifest.docs.includes(path.join(notes, "summary.md")));
			assert.ok(manifest.docs.includes(tech));
			assert.ok(!manifest.docs.includes(journal));
			assert.ok(!manifest.docs.includes(source));
			assert.equal(manifest.sessionNotes, "");
		});
	});

	test("a typed slash command counts as a skill", () => {
		withEnv(({ notes }) => {
			const typed = {
				type: "user",
				message: { content: "<command-message>persona-agents:retro</command-message>\n<command-name>/persona-agents:retro</command-name>" },
			};
			const manifest = buildManifest([typed, use("Skill", { skill: "persona-agents:study" })], notes);
			assert.deepEqual(manifest.skills, ["persona-agents:retro", "persona-agents:study"]);
		});
	});

	test("a resumed session that only read its notes gets them from the Sessions line", () => {
		withEnv(({ notes }) => {
			const other = path.join(notes, "sessions", "2026-01-01-other.md");
			const mine = path.join(notes, "sessions", "2026-01-02-mine.md");
			write(other, sessionNotesText("none", [], ["another-session"]));
			write(mine, sessionNotesText("none", [], ["sess-9"]));
			const manifest = buildManifest([use("Read", { file_path: other })], notes, "sess-9");
			assert.equal(manifest.sessionNotes, mine);
		});
	});

	test("several files naming the session choose the newest", () => {
		withEnv(({ notes }) => {
			const older = path.join(notes, "sessions", "2026-01-01-old.md");
			const newer = path.join(notes, "sessions", "2026-01-02-new.md");
			write(older, sessionNotesText("none", [], ["sess-9"]));
			write(newer, sessionNotesText("none", [], ["sess-9"]));
			fs.utimesSync(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
			fs.utimesSync(newer, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
			assert.equal(buildManifest([], notes, "sess-9").sessionNotes, newer);
		});
	});

	test("with no id match and no write, the only open notes file is used", () => {
		withEnv(({ notes }) => {
			const only = path.join(notes, "sessions", "2026-01-01-only.md");
			write(only, sessionNotesText("none", []));
			assert.equal(buildManifest([], notes, "sess-unknown").sessionNotes, only);
			write(path.join(notes, "sessions", "2026-01-02-second.md"), sessionNotesText("none", []));
			assert.equal(buildManifest([], notes, "sess-unknown").sessionNotes, "");
		});
	});

	test("the Sessions line matches a whole id, not a substring", () => {
		const text = "- **Sessions:** abc-1, abc-10\n";
		assert.equal(notesListsSession(text, "abc-1"), true);
		assert.equal(notesListsSession(text, "abc"), false);
		assert.equal(notesListsSession("- **Status:** open\n", "abc-1"), false);
	});

	test("pins and the study line accept only absolute paths", () => {
		const text = sessionNotesText("relative/study.md", ["/abs/a.md", "relative.md", "`/abs/b.md`"]);
		assert.deepEqual(pinnedDocs(text), ["/abs/a.md", "/abs/b.md"]);
		assert.equal(studyPath(text), "");
	});
});

describe("compact: texts", () => {
	const scan = { entries: 0, toolUses: 0 };
	const manifest = { sessionNotes: "/n/sessions/2026-01-01-x.md", skills: ["persona-agents:study"], docs: ["/n/summary.md"], scan };

	test("the summary instructions carry the session notes path", () => {
		assert.ok(summaryInstructions(manifest).includes(manifest.sessionNotes));
	});

	test("the reload context lists the notes, the skills, and the docs, under the hook cap", () => {
		const text = reloadContext(manifest);
		for (const item of [manifest.sessionNotes, ...manifest.skills, ...manifest.docs]) assert.ok(text.includes(item), item);
		const big = { sessionNotes: "/n/s.md", skills: Array(12).fill("persona-agents:some-long-skill-name"), docs: Array(20).fill(`/${"d".repeat(200)}.md`), scan };
		assert.ok(reloadContext(big).length < 10_000);
	});

	test("the log line goes under ## Log, and a missing section is created", () => {
		withEnv(({ tmp }) => {
			const withLog = path.join(tmp, "a.md");
			write(withLog, sessionNotesText("none", []).replace("## Log", "## Log").concat("## After\n\ntext\n"));
			assert.ok(appendLog(withLog, "L1"));
			const text = fs.readFileSync(withLog, "utf8");
			assert.ok(text.indexOf("- L1") > text.indexOf("## Log") && text.indexOf("- L1") < text.indexOf("## After"), text);
			const noLog = path.join(tmp, "b.md");
			write(noLog, "# t\n");
			assert.ok(appendLog(noLog, "L2"));
			assert.match(fs.readFileSync(noLog, "utf8"), /## Log\n\n- L2\n$/);
			assert.equal(appendLog(path.join(tmp, "missing.md"), "x"), false);
		});
	});

	test("the last boundary metadata comes from the last compact_boundary line", () => {
		const entries = [
			{ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 1, postTokens: 2 } },
			{ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 300, postTokens: 40 } },
		];
		assert.deepEqual(lastBoundary(entries), { preTokens: 300, postTokens: 40 });
		assert.deepEqual(lastBoundary([]), {});
	});
});

describe("compact: hook processes", () => {
	function run(env: Env, mode: string, input: Record<string, unknown>) {
		return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, mode, `--home=${env.home}`], {
			input: JSON.stringify({ session_id: "s-1", cwd: env.cwd, agent_type: COMPANION, ...input }),
			env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data },
			encoding: "utf8",
		});
	}

	test("pre, post, and reload work together across one compaction", () => {
		withEnv((env) => {
			const notesFile = path.join(env.notes, "sessions", "2026-01-01-task.md");
			write(notesFile, sessionNotesText("none", []));
			const transcript = path.join(env.tmp, "t.jsonl");
			const lines = [use("Skill", { skill: "persona-agents:study" }), use("Write", { file_path: notesFile })];
			write(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));

			const pre = run(env, "pre", { hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript });
			assert.equal(pre.status, 0, pre.stderr);
			assert.ok(pre.stdout.includes(notesFile));

			fs.appendFileSync(transcript, `\n${JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 400000, postTokens: 30000 } })}`);
			const post = run(env, "post", { hook_event_name: "PostCompact", trigger: "auto", transcript_path: transcript, compact_summary: "SUMMARY-TEXT" });
			assert.equal(post.status, 0, post.stderr);
			assert.match(fs.readFileSync(notesFile, "utf8"), /compaction \(auto, 400000 -> 30000 tokens\); reload: 1 skills/);
			assert.match(fs.readFileSync(path.join(env.data, "compact", "s-1.summaries.md"), "utf8"), /SUMMARY-TEXT/);
			const metric = JSON.parse(fs.readFileSync(path.join(env.data, "compact", "metrics.ndjson"), "utf8").trim());
			assert.equal(metric.preTokens, 400000);

			const reload = run(env, "reload", { hook_event_name: "SessionStart", source: "compact", transcript_path: transcript });
			assert.equal(reload.status, 0, reload.stderr);
			const context = JSON.parse(reload.stdout).hookSpecificOutput.additionalContext as string;
			assert.ok(context.includes(notesFile));
			assert.ok(context.includes("persona-agents:study"));
		});
	});

	test("an unrecognized transcript shape still finds the notes and warns", () => {
		withEnv((env) => {
			const notesFile = path.join(env.notes, "sessions", "2026-01-01-task.md");
			write(notesFile, sessionNotesText("none", [], ["s-1"]));
			const transcript = path.join(env.tmp, "t.jsonl");
			write(
				transcript,
				[
					JSON.stringify({ type: "user", message: { content: "hello" } }),
					JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } }),
				].join("\n"),
			);
			const pre = run(env, "pre", { hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript });
			assert.equal(pre.status, 0, pre.stderr);
			assert.ok(pre.stdout.includes(notesFile));
			assert.match(pre.stderr, /no tool calls/);
			run(env, "post", { hook_event_name: "PostCompact", trigger: "auto", transcript_path: transcript, compact_summary: "S" });
			const metric = JSON.parse(fs.readFileSync(path.join(env.data, "compact", "metrics.ndjson"), "utf8").trim());
			assert.equal(metric.entries, 2);
			assert.equal(metric.toolUses, 0);
		});
	});

	test("a transcript with a tool call writes no warning", () => {
		withEnv((env) => {
			const transcript = path.join(env.tmp, "t.jsonl");
			write(transcript, JSON.stringify(use("Read", { file_path: "/x.md" })));
			const pre = run(env, "pre", { hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcript });
			assert.equal(pre.status, 0);
			assert.equal(pre.stderr, "");
		});
	});

	test("another agent gets no output and no state", () => {
		withEnv((env) => {
			for (const mode of ["pre", "post", "reload"]) {
				const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, mode, `--home=${env.home}`], {
					input: JSON.stringify({ session_id: "s-2", cwd: env.cwd, agent_type: "Explore", hook_event_name: "PreCompact" }),
					env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data },
					encoding: "utf8",
				});
				assert.equal(result.status, 0);
				assert.equal(result.stdout, "", mode);
			}
			assert.equal(fs.existsSync(path.join(env.data, "compact")), false);
		});
	});
});
