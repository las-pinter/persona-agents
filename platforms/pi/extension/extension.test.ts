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
function makePi(settings: unknown = {}): Harness {
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
		getSettings: () => settings,
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
const mandatoryPath = writeSkill("fixture-mandatory", "Mandatory fixture description.", "MANDATORY_BODY_MARKER");
writeSkill("fixture-both", "Both-lists fixture description.", "BOTH_BODY_MARKER");
const overcapAPath = writeSkill("fixture-overcap-a", "Overcap fixture A.", "OVERCAP_A", 13_000);
const overcapBPath = writeSkill("fixture-overcap-b", "Overcap fixture B.", "OVERCAP_B", 13_000);
const overcapCPath = writeSkill("fixture-overcap-c", "Overcap fixture C.", "OVERCAP_C", 13_000);
// Two bytes per character: 7000 characters cross the cap only as UTF-8.
const multibytePath = writeSkill("fixture-multibyte", "Multi-byte fixture.", "\u00e9".repeat(7_000));
// Small body: quiet under both defaults. Big body: over both defaults.
const fallbackSmallPath = writeSkill("fixture-fallback-small", "Fallback probe, small body.", "FALLBACK_SMALL", 2_000);
const fallbackBigPath = writeSkill("fixture-fallback-big", "Fallback probe, big body.", "FALLBACK_BIG", 30_000);

/** The injected body of a fixture skill: its file content after the frontmatter. */
function fixtureBody(file: string): string {
	const content = fs.readFileSync(file, "utf-8");
	const end = content.indexOf("---", content.indexOf("---") + 3);
	return content.slice(end + 3).trim();
}

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

// `disable-model-invocation: true` marks a skill that only the user starts.
const userOnlySkillPath = writeRawSkill(
	"fixture-user-only",
	"description: User-only fixture description.\ndisable-model-invocation: true",
	"USER_ONLY_BODY_MARKER",
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

test("skills: a user-invoked skill is listed apart from the on-demand index", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ skills: ["fixture-index", "fixture-user-only"] }));

	const prompt = await promptFor(harness, tmpRoot);

	const userSection = prompt.indexOf('## User-invoked skills for "test-agent"');
	assert.ok(userSection > prompt.indexOf("(on-demand index)"), "the user-invoked list must follow the index");
	assert.match(prompt, /only when the user runs its command\. Never load one on your own\./);
	assert.ok(prompt.indexOf("- fixture-user-only:") > userSection, "the user-only skill must sit in its own list");
	assert.ok(prompt.includes(`path: ${userOnlySkillPath}`), "the user-only skill keeps its path for its command");
	assert.doesNotMatch(prompt, /USER_ONLY_BODY_MARKER/, "the skill body must not be injected");
});

test("skills: only user-invoked skills print no on-demand index", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ skills: ["fixture-user-only"] }));

	const prompt = await promptFor(harness, tmpRoot);

	assert.doesNotMatch(prompt, /on-demand index/);
	assert.match(prompt, /## User-invoked skills for "test-agent"/);
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

/** Collect every console.warn line while `run` executes, then restore the console. */
async function withWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		return { result: await run(), warnings };
	} finally {
		console.warn = original;
	}
}

test("a normal sized mandatory skill is injected quietly", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-mandatory"] }));

	const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

	assert.equal(warnings.length, 0, "a body under both defaults raises no warning");
	assert.ok(prompt.includes(fixtureBody(mandatoryPath)), "the small body is injected whole");
});

/** Three 13 KB fixtures: every one is over the cap and the third keeps the total over. */
test("alwaysLoad bodies are injected whole, over the body cap and over the budget", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-overcap-a", "fixture-overcap-b", "fixture-overcap-c"] }));

	const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

	assert.doesNotMatch(prompt, />> SKILL TRUNCATED/, "no size cut and no size drop marker may reach the prompt");
	assert.ok(prompt.includes(fixtureBody(overcapAPath)), "body A must be injected whole");
	assert.ok(prompt.includes(fixtureBody(overcapBPath)), "body B must be injected whole");
	assert.ok(prompt.includes(fixtureBody(overcapCPath)), "body C must be injected whole");
	const promptBytes = Buffer.byteLength(prompt, "utf8");
	assert.ok(
		promptBytes > 24 * 1024,
		`prompt size ${promptBytes} must exceed the 24 KB default budget, so no body was dropped`,
	);

	const capWarnings = warnings.filter((line) => line.includes("body cap"));
	assert.equal(capWarnings.length, 3, "one body-cap warning per oversized skill");
	assert.match(capWarnings[0] ?? "", /fixture-overcap-a/);
	assert.match(capWarnings[0] ?? "", new RegExp(`over the ${12 * 1024} byte body cap`));
	assert.match(capWarnings[0] ?? "", /raise skillBodyCapBytes/);

	// The warning fires for every skill after the total goes over, not only the first.
	const budgetWarnings = warnings.filter((line) => line.includes("injection budget"));
	assert.equal(budgetWarnings.length, 2, "one budget warning per skill past the point where the total goes over");
	assert.match(budgetWarnings[0] ?? "", /fixture-overcap-b/);
	assert.match(budgetWarnings[1] ?? "", /fixture-overcap-c/);
	assert.match(budgetWarnings[0] ?? "", new RegExp(`over the ${24 * 1024} byte injection budget`));
	assert.match(budgetWarnings[0] ?? "", /raise skillInjectionBudgetBytes/);
});

test("the body size is measured in UTF-8 bytes, not UTF-16 code units", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-multibyte"] }));

	const body = fixtureBody(multibytePath);
	const codeUnits = body.length;
	const bytes = Buffer.byteLength(body, "utf8");
	assert.ok(codeUnits < 12 * 1024, `the fixture holds ${codeUnits} code units, under the cap`);
	assert.ok(bytes > 12 * 1024, `the fixture holds ${bytes} bytes, over the cap`);

	const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

	assert.ok(prompt.includes(body), "the multi-byte body is injected whole");
	const capWarnings = warnings.filter((line) => line.includes("body cap"));
	assert.equal(capWarnings.length, 1, "the byte size crosses the cap, so the warning fires");
	assert.ok(capWarnings[0]?.includes(`${bytes} bytes`), "the warning reports the UTF-8 byte size");
});

test("a larger setting raises the budget and silences the budget warning", async () => {
	const harness = makePi({ skillInjectionBudgetBytes: 1024 * 1024, skillBodyCapBytes: 1024 * 1024 });
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-overcap-a", "fixture-overcap-b"] }));

	const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

	assert.ok(prompt.includes(fixtureBody(overcapAPath)), "body A still appears whole");
	assert.ok(prompt.includes(fixtureBody(overcapBPath)), "body B still appears whole");
	assert.equal(warnings.length, 0, "a raised budget and cap leave no warning");
});

test("the budget settings are read on every prompt, not once at registration", async () => {
	const settings: Record<string, unknown> = {
		skillInjectionBudgetBytes: 1024 * 1024,
		skillBodyCapBytes: 1024 * 1024,
	};
	const harness = makePi(settings);
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-overcap-a"] }));

	const first = await withWarnings(() => promptFor(harness, tmpRoot));
	assert.equal(first.warnings.length, 0, "a raised budget stays quiet on the first prompt");

	settings["skillInjectionBudgetBytes"] = 1024;
	const second = await withWarnings(() => promptFor(harness, tmpRoot));
	assert.ok(
		second.warnings.some((line) => line.includes("injection budget")),
		"the lowered budget is read on a later prompt from the same handler",
	);

	settings["skillInjectionBudgetBytes"] = 1024 * 1024;
	const third = await withWarnings(() => promptFor(harness, tmpRoot));
	assert.equal(third.warnings.length, 0, "the raised budget silences the warning again");

	for (const prompt of [first.result, second.result, third.result]) {
		assert.ok(prompt.includes(fixtureBody(overcapAPath)), "the body stays whole on every prompt");
	}
});

interface FallbackCase {
	label: string;
	/** The settings value handed to `getSettings`; `null` is not an object. */
	settings: unknown;
	skill: string;
	body: string;
	/** A warning only the default value can produce; `null` means every warning stays quiet. */
	expect: string | null;
}

// A small body sits under both defaults, so an accepted small setting would warn.
// A big body sits over both defaults, so an accepted non-finite setting would not.
const fallbackCases: FallbackCase[] = [
	{
		label: "a missing key",
		settings: {},
		skill: "fixture-fallback-small",
		body: fixtureBody(fallbackSmallPath),
		expect: null,
	},
	{
		label: "a settings value that is not an object",
		settings: null,
		skill: "fixture-fallback-small",
		body: fixtureBody(fallbackSmallPath),
		expect: null,
	},
	{
		label: "a string where a number is expected",
		settings: { skillInjectionBudgetBytes: "1000", skillBodyCapBytes: "1000" },
		skill: "fixture-fallback-small",
		body: fixtureBody(fallbackSmallPath),
		expect: null,
	},
	{
		label: "a negative number",
		settings: { skillInjectionBudgetBytes: -5, skillBodyCapBytes: -5 },
		skill: "fixture-fallback-small",
		body: fixtureBody(fallbackSmallPath),
		expect: null,
	},
	{
		label: "a not-a-number value",
		settings: { skillInjectionBudgetBytes: Number.NaN, skillBodyCapBytes: 1024 * 1024 },
		skill: "fixture-fallback-big",
		body: fixtureBody(fallbackBigPath),
		expect: "injection budget",
	},
	{
		label: "an infinite value",
		settings: { skillInjectionBudgetBytes: 1024 * 1024, skillBodyCapBytes: Number.POSITIVE_INFINITY },
		skill: "fixture-fallback-big",
		body: fixtureBody(fallbackBigPath),
		expect: "body cap",
	},
];

test("a bad budget setting falls back to the default without a throw", async () => {
	for (const row of fallbackCases) {
		const harness = makePi(row.settings);
		extension(harness.pi);
		setActivePersona(null);
		setActiveAgent(testAgent({ alwaysLoad: [row.skill] }));

		const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

		assert.ok(prompt.includes(row.body), `${row.label}: the body is injected whole`);
		if (row.expect === null) {
			assert.deepEqual(warnings, [], `${row.label}: the defaults keep every warning quiet`);
		} else {
			assert.ok(
				warnings.some((line) => line.includes(row.expect as string)),
				`${row.label}: the default warns (${warnings.join(" | ")})`,
			);
		}
	}
});

test("a zero budget is legal and warns, so it does not fall back", async () => {
	const harness = makePi({ skillInjectionBudgetBytes: 0, skillBodyCapBytes: 1024 * 1024 });
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(testAgent({ alwaysLoad: ["fixture-mandatory"] }));

	const { result: prompt, warnings } = await withWarnings(() => promptFor(harness, tmpRoot));

	assert.ok(prompt.includes(fixtureBody(mandatoryPath)), "the body is still injected whole");
	const budgetWarnings = warnings.filter((line) => line.includes("injection budget"));
	assert.equal(budgetWarnings.length, 1, "a zero budget warns on the first skill");
	assert.match(budgetWarnings[0] ?? "", /over the 0 byte injection budget/);
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
