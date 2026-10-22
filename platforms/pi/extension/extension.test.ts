/**
 * Extension tests: skill injection and the tree-log compaction call site.
 *
 * The pi `before_agent_start` handler injects two payloads:
 *   - `alwaysLoad` — the full skill body (mandatory, budgeted); and
 *   - `skills:` — an on-demand index of name, description, and path.
 *
 * These tests drive the real extension factory with a fake pi, so they fail if
 * the index contract drifts back to full-body injection for `skills:`.
 *
 * The last test drives the same factory through `session_start` to prove the
 * compaction call site reads every record, not the capped tail.
 *
 * Fixtures are written to a temp dir at run time and removed after. The tests
 * are hermetic: they never read or write the operator's agent-notes tree.
 *
 * Run: npm test
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";
import type { AgentConfig } from "./resolver.ts";
import { setActiveAgent, setActivePersona } from "./state.ts";
import { ENV_PARENT_RUN_ID, ENV_RUN_ID, ENV_TREE_LOG } from "./depth.ts";
import { MAX_EVENTS_READ, MAX_LOG_BYTES, readAllEvents, readEvents } from "./tree-log.ts";

const DEBUG_ENV = "PI_AGENT_STACK_DEBUG";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
}

/** A fake pi that records `on` handlers; every other method is a no-op. */
function makePi(): Harness {
	const handlers = new Map<string, Handler[]>();
	const noop = (): void => {};
	const pi: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: noop,
		registerTool: noop,
		registerFlag: noop,
		getFlag: () => undefined,
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

/** Run every `before_agent_start` handler and return the final prompt. */
async function promptFor(harness: Harness, cwd: string): Promise<string> {
	let prompt = "BASE";
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		const result = (await handler({ systemPrompt: prompt }, { cwd })) as
			| { systemPrompt?: string }
			| undefined;
		if (result?.systemPrompt) prompt = result.systemPrompt;
	}
	return prompt;
}

function testAgent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		name: "test-agent",
		description: "test agent",
		systemPrompt: "PROFESSION BODY",
		source: "package",
		filePath: "",
		...overrides,
	};
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ext-skill-injection-"));
const skillsRoot = path.join(tmpRoot, ".pi", "skills");

/** Write a fixture skill with a unique body marker. `bodyBytes` pads the body. */
function writeSkill(name: string, description: string, bodyMarker: string, bodyBytes = 0): string {
	const dir = path.join(skillsRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	const padding = bodyBytes > 0 ? `\n${"x".repeat(bodyBytes)}` : "";
	const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${bodyMarker}${padding}\n`;
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, content);
	return file;
}

const indexSkillPath = writeSkill("fixture-index", "Index fixture description.", "INDEX_BODY_MARKER");
writeSkill("fixture-mandatory", "Mandatory fixture description.", "MANDATORY_BODY_MARKER");
writeSkill("fixture-both", "Both-lists fixture description.", "BOTH_BODY_MARKER");
const overcapAPath = writeSkill("fixture-overcap-a", "Overcap fixture A.", "OVERCAP_A", 13_000);
const overcapBPath = writeSkill("fixture-overcap-b", "Overcap fixture B.", "OVERCAP_B", 13_000);

/** Write a fixture skill whose `description` frontmatter is raw YAML lines. */
function writeRawSkill(name: string, descriptionYaml: string, bodyMarker: string): string {
	const dir = path.join(skillsRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	fs.writeFileSync(file, `---\nname: ${name}\n${descriptionYaml}\n---\n\n# ${name}\n\n${bodyMarker}\n`);
	return file;
}

// A block-scalar description parses to a string with a real newline (fix 3).
const multilineSkillPath = writeRawSkill(
	"fixture-multiline",
	"description: |-\n  Multi line\n  description here.",
	"MULTILINE_BODY_MARKER",
);

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("skills: injects an on-demand index of name, description, and path", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ skills: ["fixture-index"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Agent skills for "test-agent" \(on-demand index\)/);
	assert.match(prompt, /Read a skill file when the task matches its description/);
	assert.match(prompt, /- fixture-index: Index fixture description\./);
	assert.ok(prompt.includes(`path: ${indexSkillPath}`), "the index must carry the skill path");
	assert.doesNotMatch(prompt, /INDEX_BODY_MARKER/, "the skill body must not be injected");
});

test("skills: a block-scalar description collapses to one index line", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ skills: ["fixture-multiline"] }));

	const prompt = await promptFor(harness, tmpRoot);

	// The folded description must sit on the `- id:` line, not leak a newline.
	assert.match(prompt, /- fixture-multiline: Multi line description here\./);
	assert.doesNotMatch(prompt, /Multi line\n\s+description here\./);
	assert.ok(prompt.includes(`  path: ${multilineSkillPath}`), "the path must stay on its own line");
});

test("alwaysLoad: still injects the full skill body", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-mandatory"], skills: ["fixture-index"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Mandatory skill: fixture-mandatory/);
	assert.match(prompt, /MANDATORY_BODY_MARKER/, "the mandatory body must be injected");
	assert.match(prompt, /on-demand index/, "the on-demand index still injects alongside");
	assert.doesNotMatch(prompt, /INDEX_BODY_MARKER/);
});

test("a skill in both lists is injected once, as a full mandatory body", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-both"], skills: ["fixture-both"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /## Mandatory skill: fixture-both/);
	assert.match(prompt, /BOTH_BODY_MARKER/);
	assert.doesNotMatch(prompt, /on-demand index/, "alwaysLoad wins and the skill is not indexed");
	assert.doesNotMatch(prompt, /- fixture-both:/, "the deduped skill is not an index entry");
});

test("missing alwaysLoad entries warn and leave a visible marker", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-does-not-exist"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, /MISSING skill for alwaysLoad entry: fixture-does-not-exist/);
});

test("alwaysLoad bodies stay under the 12 KB cap and the 24 KB budget", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-overcap-a", "fixture-overcap-b"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.match(prompt, />> SKILL TRUNCATED: fixture-overcap-a/);
	assert.match(prompt, />> SKILL TRUNCATED: fixture-overcap-b/);
	assert.ok(
		prompt.includes(`>> SKILL TRUNCATED: fixture-overcap-a (path: ${overcapAPath})`),
		"the cap-truncated marker must carry the skill path",
	);
	assert.ok(
		prompt.includes(`>> SKILL TRUNCATED: fixture-overcap-b (path: ${overcapBPath})`),
		"the budget-dropped marker must carry the path so the agent can still read the skill",
	);
	// Two 13 KB bodies would be ~26 KB; the budget forces the second body out.
	assert.ok(prompt.length < 24 * 1024, `prompt length ${prompt.length} must stay under the budget`);
});

/** One tree-log line for `runId`; `status` follows the record type. */
function logLine(runId: string, type: "update" | "end"): string {
	return JSON.stringify({
		v: 1,
		type,
		runId,
		parentRunId: null,
		depth: 0,
		agent: "orchestrator",
		persona: null,
		status: type === "end" ? "done" : "running",
		at: new Date(0).toISOString(),
	});
}

/** Save the first value of `key`, then set it, or delete it when `value` is undefined. */
function setEnv(saved: Map<string, string | undefined>, key: string, value: string | undefined): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** Put every saved environment key back as it was, and delete the rest. */
function restoreEnv(saved: Map<string, string | undefined>): void {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// This test must stay last in the file. It leaves the tree-root module state
// set, and it needs that state empty at the start.
test("the compaction call site keeps a quiet live run outside the read window", async () => {
	const logFile = path.join(tmpRoot, "call-site-log.ndjson");
	// The quiet run has only `update` records, so a capped read drops it.
	const lines = [logLine("quiet", "update"), logLine("quiet", "update")];
	let bytes = lines.reduce((sum, line) => sum + line.length + 1, 0);
	while (bytes <= MAX_LOG_BYTES + 8192) {
		const line = logLine("filler", "update");
		lines.push(line);
		bytes += line.length + 1;
	}
	// The filler run is finished, so compaction may drop all but the tail.
	lines.push(logLine("filler", "end"));
	fs.writeFileSync(logFile, `${lines.join("\n")}\n`);

	assert.ok(bytes > MAX_LOG_BYTES, "the log is over the compaction threshold");
	assert.ok(lines.length > 600, "the quiet records sit outside the compaction tail");
	assert.ok(
		readEvents(logFile).every((event) => event.runId !== "quiet"),
		"the capped read drops every quiet record",
	);

	// The real call site is `compactIfNeeded`, reached through `session_start`.
	const saved = new Map<string, string | undefined>();
	const harness = makePi();
	try {
		setEnv(saved, ENV_RUN_ID, "call-site-root");
		setEnv(saved, ENV_PARENT_RUN_ID, undefined);
		setEnv(saved, ENV_TREE_LOG, logFile);
		setEnv(saved, DEBUG_ENV, undefined);
		extension(harness.pi);
		for (const handler of harness.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start" }, { cwd: tmpRoot });
		}

		const events = readAllEvents(logFile);
		assert.equal(
			events.filter((event) => event.runId === "quiet").length,
			2,
			"the call site keeps the quiet live run",
		);
		assert.ok(
			events.some((event) => event.runId === "call-site-root"),
			"the root run stays",
		);
		assert.ok(events.length < MAX_EVENTS_READ, "the call site compacted the log");
	} finally {
		// A quit reason writes the root `end` and stops the sidebar timers.
		for (const handler of harness.handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown", reason: "quit" }, { cwd: tmpRoot });
		}
		restoreEnv(saved);
	}
});
