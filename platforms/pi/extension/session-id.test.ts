/**
 * The one session-id reader.
 *
 * Every caller that needs the pi session id reads it in `session-id.ts`. A
 * manager that throws must not block a tool call, and the ask record for that
 * same call must carry the id and the role the gate judged.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_ROOT_RUN_ID } from "./ask-record.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { installToolCallGate } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import { RunRegistry } from "./run-registry.ts";
import { parentSessionIdOf, sessionIdOf } from "./session-id.ts";
import { setActiveAgent } from "./state.ts";

// An isolated (empty) global permissions file so the repo file cannot interfere.
const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "session-id-")),
	"permissions.json",
);
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

type ToolCallContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	sessionManager?: { getSessionId?: () => string };
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
};
type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: ToolCallContext,
) => Promise<unknown>;

const AGENT: AgentConfig = {
	name: "implementer",
	description: "session-id test agent",
	systemPrompt: "",
	source: "package",
	filePath: "",
};

setActiveAgent(AGENT);

let restoreLog: (() => void) | null = null;

afterEach(() => {
	restoreLog?.();
	restoreLog = null;
});

/** Install the real gate over one ask rule and return its handler. */
function installGate(ask: PermissionRule[]): ToolCallHandler {
	let captured: ToolCallHandler | null = null;
	const pi = {
		on(name: string, handler: ToolCallHandler): void {
			if (name === "tool_call") captured = handler;
		},
	};
	installToolCallGate(
		pi as unknown as ExtensionAPI,
		() => AGENT,
		() => ({
			ruleSets: {
				globalDeny: [],
				agentDeny: [],
				globalAsk: [],
				agentAsk: ask,
				agentAllow: [],
			},
			mode: "deny-by-default",
		}),
		new RunRegistry(),
	);
	assert.ok(captured, "the gate must register a tool_call handler");
	return captured;
}

/** A context whose manager throws on every id read. */
function throwingContext(prompts: string[]): ToolCallContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		mode: "rpc",
		sessionManager: {
			getSessionId(): string {
				throw new Error("manager lost the id");
			},
		},
		ui: {
			async select(title: string): Promise<string | undefined> {
				prompts.push(title);
				return "Allow once";
			},
		},
	};
}

/** The `ask` records in one log file, in file order. */
function askEvents(logPath: string): Array<{ runId: string; ask: { role: string } }> {
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string })
		.filter((event) => event.type === "ask") as Array<{ runId: string; ask: { role: string } }>;
}

// --- the reader --------------------------------------------------------------

test("sessionIdOf returns the id the manager holds", () => {
	assert.equal(sessionIdOf({ sessionManager: { getSessionId: () => "root-1" } }), "root-1");
	const ctx = { sessionManager: { getSessionId: () => "root-1" } };
	assert.equal(parentSessionIdOf(ctx), "root-1", "the parent alias reads the same id");
});

test("a manager that throws gives null, not an error", () => {
	const ctx = {
		sessionManager: {
			getSessionId(): string {
				throw new Error("manager lost the id");
			},
		},
	};
	assert.doesNotThrow(() => sessionIdOf(ctx), "the reader never throws");
	assert.equal(sessionIdOf(ctx), null);
});

test("a context with no session manager gives null", () => {
	assert.equal(sessionIdOf({}), null);
	assert.equal(sessionIdOf({ sessionManager: {} }), null);
	assert.equal(sessionIdOf(undefined), null);
});

// --- the gate and the record -------------------------------------------------

test("a throwing manager does not block the call, so the call is evaluated", async () => {
	const handler = installGate([{ tool: "read", match: "^/etc/hosts$" }]);
	const prompts: string[] = [];

	const result = await handler({ toolName: "read", input: { path: "/etc/hosts" } }, throwingContext(prompts));

	assert.equal(prompts.length, 1, "the ask reached the owner");
	assert.equal(result, undefined, "the owner's allow ran the call");
});

test("the ask record of that call carries the id and role the gate judged", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-log-"));
	const logPath = path.join(dir, "tree.ndjson");
	const previous = process.env[ENV_TREE_LOG];
	process.env[ENV_TREE_LOG] = logPath;
	restoreLog = () => {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
	};
	const handler = installGate([{ tool: "read", match: "^/etc/hosts$" }]);

	await handler({ toolName: "read", input: { path: "/etc/hosts" } }, throwingContext([]));

	const events = askEvents(logPath);
	assert.equal(events.length, 1, "the settled ask wrote one record");
	assert.equal(events[0].runId, ASK_ROOT_RUN_ID, "a lost id reads as the root, not a placeholder");
	assert.equal(events[0].ask.role, AGENT.name, "the record names the role the gate judged");
	assert.ok(
		!fs.readFileSync(logPath, "utf8").includes("unknown"),
		"the record holds no unknown placeholder",
	);
});
