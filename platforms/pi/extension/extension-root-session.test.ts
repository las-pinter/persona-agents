/**
 * Extension root session: the `session_start` registration and the
 * `session_shutdown` close.
 *
 * A lost registration makes the gate deny every call from the root, and a lost
 * close leaves the root record open for the retention sweep. Both cases drive
 * the real factory with a fake pi, so they fail when either call site goes.
 *
 * The fixture overlay is empty, so the operator's live file adds no verdict.
 * Run: npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";
import type { AgentConfig } from "./resolver.ts";
import { newRunRecord, type RunRegistry } from "./run-registry.ts";
import { getRunRegistry } from "./subagent-run.ts";
import { getActiveAgent, setActiveAgent, setActivePersona } from "./state.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ext-root-session-"));
const overlayFile = path.join(tmpRoot, "permissions.json");
fs.writeFileSync(overlayFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = overlayFile;

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
		getSettings: () => ({}),
		appendEntry: noop,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getAllTools: () => [],
		getMcpServers: () => [],
		events: { on: () => () => {}, emit: noop },
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

/** The root agent. A `git status` read is allowed for its class. */
const ROOT_AGENT: AgentConfig = {
	name: "orchestrator",
	description: "root session fixture",
	systemPrompt: "",
	source: "package",
	filePath: "",
	permissionClass: "orchestrator",
};

/** The root tool context: one session id, one working directory, a UI. */
function rootContext(sessionId: string): Record<string, unknown> {
	return {
		cwd: tmpRoot,
		hasUI: true,
		mode: "rpc",
		sessionManager: { getSessionId: () => sessionId },
		ui: { select: async () => undefined },
	};
}

/** Run every handler of one event with the same event payload and context. */
async function fire(harness: Harness, event: string, payload: unknown, ctx: unknown): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) await handler(payload, ctx);
}

/** The gate verdict for one call. The last registered handler is the live gate. */
async function gateCall(harness: Harness, ctx: unknown, command: string): Promise<unknown> {
	let verdict: unknown;
	for (const handler of harness.handlers.get("tool_call") ?? []) {
		verdict = await handler({ toolName: "bash", input: { command } }, ctx);
	}
	return verdict;
}

/** Close one root session, so the sidebar timers stop even when a case fails. */
async function closeSession(harness: Harness, ctx: unknown): Promise<void> {
	await fire(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}

test("session_start registers the root, so a gated call keeps the root role", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(ROOT_AGENT);
	const rootId = "root-start";
	const ctx = rootContext(rootId);

	try {
		await fire(harness, "session_start", { type: "session_start" }, ctx);

		const record = getRunRegistry().get(rootId);
		assert.ok(record, "session_start registers the root session");
		assert.equal(record.depth, 0, "the root record sits at depth 0");
		assert.equal(record.parentSessionId, null, "the root record has no parent");
		assert.equal(record.role, getActiveAgent()?.name ?? "unknown", "the record names the active agent");

		// A lost registration denies this allowed read as an unknown session.
		const verdict = await gateCall(harness, ctx, "git status");
		assert.equal(verdict, undefined, "the root keeps the live role at depth 0");
	} finally {
		await closeSession(harness, ctx);
	}
});

test("session_shutdown finishes the root record and leaves the child running", async () => {
	const harness = makePi();
	extension(harness.pi);
	setActivePersona(null);
	setActiveAgent(ROOT_AGENT);
	const rootId = "root-shutdown";
	const childId = "child-shutdown";
	const ctx = rootContext(rootId);

	try {
		await fire(harness, "session_start", { type: "session_start" }, ctx);
		const registry: RunRegistry = getRunRegistry();
		registry.register(
			newRunRecord({
				sessionId: childId,
				role: "implementer",
				class: "worker",
				source: "package",
				skills: [],
				alwaysLoad: [],
				depth: 1,
				parentSessionId: rootId,
				sessionFile: null,
				startedAt: 0,
			}),
		);
		assert.equal(registry.get(rootId)?.status, "running", "the root record is open before the close");

		await closeSession(harness, ctx);

		assert.equal(registry.get(rootId)?.status, "done", "the root record is finished");
		assert.equal(registry.get(childId)?.status, "running", "a child record is left to the builder");
	} finally {
		await closeSession(harness, ctx);
	}
});
