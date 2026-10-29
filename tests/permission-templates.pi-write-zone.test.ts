/**
 * Permission regression harness for the pi orchestrator write zone.
 *
 * The orchestrator may write the repository, the agent-notes tree, and the
 * /tmp zone. Every other path asks. The gate cannot resolve a path against the
 * working directory, so the rules name the path forms directly:
 *
 *   - a relative path with no parent segment allows;
 *   - a path with a parent segment asks, with no exception;
 *   - an absolute path that holds an agent-notes segment and no parent segment
 *     allows;
 *   - an absolute path in the /tmp zone allows;
 *   - a home-relative path asks;
 *   - any other absolute path asks.
 *
 * Residual: the agent-notes allow cannot be anchored to one home folder, so
 * any absolute path with an agent-notes segment and no parent segment allows.
 * A symlink planted in the /tmp zone points outside it, because the gate does
 * not resolve a link.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCommandRules, type Decision } from "../platforms/pi/extension/command-segments.ts";
import { loadAgentRules } from "./permission-templates.fixtures.ts";

/** Path tools that carry a write zone. */
const WRITE_TOOLS = ["edit", "write"] as const;
type WriteTool = (typeof WRITE_TOOLS)[number];

/** Verdict kind for one agent, one path tool, and one path. */
function pathVerdict(agent: string, tool: WriteTool, target: string): Decision["kind"] {
	const { mode, ruleSets } = loadAgentRules(agent);
	return evaluateCommandRules(target, false, ruleSets, mode, tool, agent).kind;
}

/** Assert one verdict for every path in a list, with the path as the message. */
function assertEach(agent: string, tool: WriteTool, paths: string[], expected: Decision["kind"]): void {
	for (const target of paths) {
		assert.equal(pathVerdict(agent, tool, target), expected, `${tool} ${target}`);
	}
}

describe("pi orchestrator write zone", () => {
	for (const tool of WRITE_TOOLS) {
		test(`${tool}: a relative repository path allows`, () => {
			assertEach("orchestrator", tool, [
				"src/a.ts",
				"platforms/pi/README.md",
				"content/skills/common/project-notes/SKILL.md",
				"agent-notes/session.md",
				"agent-notes/project-notes/study.md",
				"./src/a.ts",
				"a/..b/c.md",
				"notes..md",
			], "allow");
		});

		test(`${tool}: an absolute repository path asks`, () => {
			assertEach("orchestrator", tool, [
				"/home/dev/persona-agents/src/a.ts",
				"/repo/README.md",
				"/repo/agent-notes-file.md",
				"/repo/my-agent-notes/a.md",
			], "ask");
		});

		test(`${tool}: an absolute agent-notes path allows`, () => {
			assertEach("orchestrator", tool, [
				"/agent-notes/session.md",
				"/home/dev/agent-notes/session.md",
				"/home/dev/agent-notes/project-notes/study.md",
				"/home/dev/agent-notes",
			], "allow");
		});

		test(`${tool}: the /tmp zone allows`, () => {
			assertEach("orchestrator", tool, ["/tmp", "/tmp/a.txt", "/tmp/a/b/c.txt", "/tmp/agent-notes/x"], "allow");
		});

		test(`${tool}: a relative tmp path allows`, () => {
			// These allow by the relative-path rule, not the /tmp zone rule.
			assertEach("orchestrator", tool, ["tmp/x", "tmp/x/y.md"], "allow");
		});

		test(`${tool}: any parent segment asks`, () => {
			assertEach("orchestrator", tool, [
				"agent-notes/../../x",
				"agent-notes/../../.bashrc",
				"agent-notes/../x",
				"../x",
				"..",
				"a/../b.md",
				"a/..",
				"/home/dev/agent-notes/../../.bashrc",
				"/home/dev/agent-notes/../x",
				"/home/dev/../.bashrc",
				"/tmp/agent-notes/../x",
				"/tmp/../etc/passwd",
			], "ask");
		});

		test(`${tool}: a home-relative path asks`, () => {
			assertEach("orchestrator", tool, [
				"~/.bashrc",
				"~/x",
				"~/agent-notes/session.md",
			], "ask");
		});

		test(`${tool}: any other absolute path asks`, () => {
			assertEach("orchestrator", tool, [
				"/etc/passwd",
				"/home/dev/.bashrc",
				"/srv/notes/agent-notes.md",
				"/tmpfoo",
				"/tmp2/x",
				"/tmpdir",
				"/TMPDIR/x",
				"/etc/tmp",
				"/alphabet/tmp",
			], "ask");
		});
	}

	test("a non-orchestrator write zone stays narrow", () => {
		// The planner writes the project notes and nothing else.
		assert.equal(pathVerdict("planner", "edit", "agent-notes/project-notes/repo/study.md"), "allow");
		assert.equal(pathVerdict("planner", "write", "agent-notes/project-notes/repo/study.md"), "allow");
		assert.equal(pathVerdict("planner", "edit", "/home/dev/agent-notes/project-notes/repo/study.md"), "allow");
		assert.equal(pathVerdict("planner", "edit", "agent-notes/orchestrator/j.md"), "default");
		assert.equal(pathVerdict("planner", "write", "agent-notes/researcher/x.md"), "default");
		// The researcher writes its own folder and nothing else.
		assert.equal(pathVerdict("researcher", "edit", "agent-notes/researcher/a.md"), "allow");
		assert.equal(pathVerdict("researcher", "write", "/home/dev/agent-notes/researcher/a.md"), "allow");
		assert.equal(pathVerdict("researcher", "edit", "agent-notes/project-notes/a.md"), "default");
		assert.equal(pathVerdict("researcher", "write", "agent-notes/orchestrator/a.md"), "default");
		// Neither of them gains the repository that the orchestrator holds.
		assert.equal(pathVerdict("planner", "edit", "src/a.ts"), "default");
		assert.equal(pathVerdict("researcher", "write", "content/professions/orchestrator.md"), "default");
	});
});
