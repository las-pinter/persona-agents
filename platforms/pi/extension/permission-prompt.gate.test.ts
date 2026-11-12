/**
 * Tests for the real-gate wire-up of the permission prompt.
 *
 * Cohesion: one subject, the installed gate. This file drives the real
 * `installToolCallGate` handler, not a mirror of it, and proves the gate
 * hands the rule's human `reason` to the prompt. A regression that passes
 * `rule.match` instead would leak the regex into the select title and turn
 * these cases red.
 *
 * Runs under plain Node (type stripping):
 *   npm test
 *
 * The prompt model, the labels, and the renderer live in
 * `permission-prompt.test.ts`.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROMPT_OPTION_LABELS } from "./permission-prompt.ts";
import { installToolCallGate } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import { RunRegistry } from "./run-registry.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// An isolated (empty) global permissions file so the repo file cannot interfere.
const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "reason-gate-")),
	"permissions.json",
);
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

type ToolCallContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
};
type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: ToolCallContext,
) => unknown;

/** Install the real gate and return its captured handler. */
function installGate(config: {
	mode: "deny-by-default" | "allow-unless-matched";
	deny?: PermissionRule[];
	ask?: PermissionRule[];
	allow?: PermissionRule[];
}): { handler: ToolCallHandler } {
	let captured: ToolCallHandler | null = null;
	const pi = {
		on(name: string, handler: ToolCallHandler): void {
			if (name === "tool_call") captured = handler;
		},
	};
	const agent: AgentConfig = {
		name: "orchestrator",
		description: "integration test agent",
		systemPrompt: "",
		source: "package",
		filePath: "",
	};
	// The gate reads the compiled table; this fixture source drives the same
	// wiring with the case's own rule set, so the prompt and grant path is real.
	installToolCallGate(pi as unknown as ExtensionAPI, () => agent, () => ({
		ruleSets: {
			globalDeny: [],
			agentDeny: config.deny ?? [],
			globalAsk: [],
			agentAsk: config.ask ?? [],
			agentAllow: config.allow ?? [],
		},
		mode: config.mode,
	}), new RunRegistry());
	assert.ok(captured, "the gate must register a tool_call handler");
	return { handler: captured };
}

/** A non-TUI context whose selector answers with `answer` and records prompts. */
function selectContext(answer: string | undefined, prompts: string[]): ToolCallContext {
	return {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc", // non-TUI: renderPermissionPrompt uses ctx.ui.select
		ui: {
			async select(title: string): Promise<string | undefined> {
				prompts.push(title);
				return answer;
			},
		},
	};
}

/** A non-TUI context that answers prompts from a queue, one answer per call. */
function selectContextQueue(answers: Array<string | undefined>, prompts: string[]): ToolCallContext {
	let next = 0;
	return {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(title: string): Promise<string | undefined> {
				prompts.push(title);
				const answer = answers[Math.min(next, answers.length - 1)];
				next += 1;
				return answer;
			},
		},
	};
}

test("the real gate prompt title carries the rule reason, not the rule regex", async () => {
	const reason = "orchestrator commit requires user approval";
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason }],
	});

	const prompts: string[] = [];
	let capturedOptions: string[] = [];
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(title: string, options: string[]): Promise<string | undefined> {
				prompts.push(title);
				capturedOptions = options;
				return undefined; // cancel => deny (fail closed)
			},
		},
	};

	await handler({ toolName: "bash", input: { command: "git commit -m tinker" } }, ctx);

	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].includes(reason), `title must show the reason: ${prompts[0]}`);
	assert.ok(!prompts[0].includes(regex), `title must not leak the regex: ${prompts[0]}`);
	assert.deepEqual(capturedOptions, PROMPT_OPTION_LABELS);
});

test("the real gate highlights the later occurrence of a repeated segment", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "^git$" }],
		allow: [{ tool: "bash", match: "^git\\b" }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git status && git" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].includes("git status && [git]"), `wrong highlight: ${prompts[0]}`);
});

test("a spanning allow-once runs the command once", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Allow once", prompts);

	const result = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(result, undefined);
	assert.equal(prompts.length, 1);
});

test("a spanning always-allow runs and is remembered", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("a spanning always-allow that covers only part of the command runs once then blocks", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		allow: [{ tool: "bash", match: "^foo$" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined, "the first always-allow runs the call now");
	assert.ok(second && typeof second === "object", "the second call must block fail-closed");
	assert.equal((second as { block?: boolean }).block, true);
	assert.equal(prompts.length, 1, "the remembered rule suppresses the spanning ask");
});

test("a target always-allow runs now and is remembered", async () => {
	const { handler } = installGate({
		mode: "allow-unless-matched",
		ask: [{ tool: "read", match: "^/etc/hosts$" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "read", input: { path: "/etc/hosts" } }, ctx);
	const second = await handler({ toolName: "read", input: { path: "/etc/hosts" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("a segment always-allow is remembered", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "^foo\\b" }],
		allow: [{ tool: "bash", match: "^bar\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContext("Always allow this rule (session)", prompts);

	const first = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);
	const second = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(prompts.length, 1);
});

test("headless ask is a hard block with a stable non-regex reason", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: "commit approval" }],
	});
	let selectCalled = false;
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: false,
		mode: "rpc",
		ui: {
			async select(): Promise<string | undefined> {
				selectCalled = true;
				return undefined;
			},
		},
	};

	const result = await handler({ toolName: "bash", input: { command: "git commit -m tinker" } }, ctx);

	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	const reason = (result as { reason?: string }).reason ?? "";
	assert.equal(reason, "Permission required: bash (orchestrator policy): commit approval");
	assert.ok(!reason.includes(regex), `block reason must not leak the regex: ${reason}`);
	assert.equal(selectCalled, false);
});

test("the real gate drops a reason equal to the regex from the prompt title", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex, reason: regex }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(!prompts[0].includes(regex), `title must not leak the regex: ${prompts[0]}`);
	assert.ok(
		prompts[0].includes("matches a permission rule"),
		`title must use the fallback: ${prompts[0]}`,
	);
});

test("a cancel answer denies the call fail-closed", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("an unknown selection denies the call fail-closed", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext("a choice that does not exist", prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("an explicit deny answer blocks the call", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: "\\bgit\\s+commit\\b" }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext("Deny", prompts),
	);

	assert.equal(prompts.length, 1);
	assert.deepEqual(result, { block: true, reason: "Denied by user" });
});

test("a deny rule wins over an ask rule and never prompts", async () => {
	const regex = "^git\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		deny: [{ tool: "bash", match: regex }],
		ask: [{ tool: "bash", match: regex }],
	});
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "git status" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0, "deny must short-circuit before any prompt");
	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	assert.ok(!JSON.stringify(result).includes(regex), `deny reason leaks the regex: ${JSON.stringify(result)}`);
});

test("a headless spanning ask is a hard block with a non-regex reason", async () => {
	const regex = "foo\\s*&&\\s*bar";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex }],
		allow: [{ tool: "bash", match: "\\b(foo|bar)\\b" }],
	});
	let selectCalled = false;
	const ctx: ToolCallContext = {
		cwd: repoRoot,
		hasUI: false,
		mode: "rpc",
		ui: {
			async select(): Promise<string | undefined> {
				selectCalled = true;
				return undefined;
			},
		},
	};

	const result = await handler({ toolName: "bash", input: { command: "foo && bar" } }, ctx);

	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	const reason = (result as { reason?: string }).reason ?? "";
	assert.equal(reason, "Permission required: bash (orchestrator policy)");
	assert.ok(!reason.includes(regex), `block reason leaks the regex: ${reason}`);
	assert.equal(selectCalled, false);
});

test("an unnamed reason does not leak the regex into the prompt title", async () => {
	const regex = "\\bgit\\s+commit\\b";
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [{ tool: "bash", match: regex }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "git commit -m tinker" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(!prompts[0].includes(regex), `title leaks the regex: ${prompts[0]}`);
	assert.ok(prompts[0].includes("matches a permission rule"));
});

test("a segment always-allow re-evaluates and prompts for the next blocked segment", async () => {
	const { handler } = installGate({
		mode: "deny-by-default",
		ask: [
			{ tool: "bash", match: "^foo\\b" },
			{ tool: "bash", match: "^baz\\b" },
		],
		allow: [{ tool: "bash", match: "^bar\\b" }],
	});
	const prompts: string[] = [];
	const ctx = selectContextQueue(["Always allow this rule (session)", "Allow once"], prompts);

	const result = await handler(
		{ toolName: "bash", input: { command: "foo && bar && baz" } },
		ctx,
	);

	assert.equal(result, undefined);
	assert.equal(prompts.length, 2, "the approved foo segment must not hide the baz ask");
	assert.ok(prompts[1].includes("baz"), `the second prompt must show baz: ${prompts[1]}`);
});

test("a folded segment that cannot be sliced uses the Blocked part fallback", async () => {
	const { handler } = installGate({
		mode: "allow-unless-matched",
		ask: [{ tool: "bash", match: "git\\s+commit" }],
	});
	const prompts: string[] = [];

	await handler(
		{ toolName: "bash", input: { command: "cd a &&  git commit" } },
		selectContext(undefined, prompts),
	);

	assert.equal(prompts.length, 1);
	assert.ok(
		prompts[0].includes("Blocked part: cd a && git commit"),
		`the fallback line must name the folded segment: ${prompts[0]}`,
	);
	assert.ok(
		!prompts[0].includes("[cd a && git commit]"),
		`a segment that is not a literal slice must not be bracketed: ${prompts[0]}`,
	);
});

test("an empty command is blocked fail-closed under deny-by-default", async () => {
	const { handler } = installGate({ mode: "deny-by-default" });
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0, "an empty command must never prompt");
	assert.ok(result && typeof result === "object");
	assert.equal((result as { block?: boolean }).block, true);
	assert.match((result as { reason?: string }).reason ?? "", /empty command/);
});

test("an empty command runs under allow-unless-matched", async () => {
	const { handler } = installGate({ mode: "allow-unless-matched" });
	const prompts: string[] = [];

	const result = await handler(
		{ toolName: "bash", input: { command: "" } },
		selectContext("Allow once", prompts),
	);

	assert.equal(prompts.length, 0);
	assert.equal(result, undefined);
});
