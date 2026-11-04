/**
 * A child session cannot ask: the gate denies an ask verdict at once, with a
 * reason that names the fix. The root ask still renders the shared prompt.
 *
 * The walked depth places the call, never the record's own copy of it: a record
 * that declares depth 0 is still a child. A walk that stops short, or a session
 * id the registry never saw, is refused rather than given the root role. A root
 * session grant is keyed to its session, so it does not cover a child.
 *
 * The gate handler is real and the root prompt is a fake. No case advances a
 * clock: the child case counts every timer the gate schedules.
 *
 * Run: npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_A,
	CHILD_D0,
	CHILD_E,
	MISSING_PARENT,
	ROOT,
	RootPrompter,
	THREE_LABELS,
	childContext,
	registryOf,
	rootContext,
} from "./gate-fixture.ts";
import { CHILD_ASK_DENIED_REASON, installToolCallGate, type GateRuleSourceFactory } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import { sessionDepthOf, UNKNOWN_RUN_REASON } from "./run-registry.ts";

type Gate = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

/** The reason text, written out, so a rename of the constant cannot hide a change. */
const REASON =
	"Blocked: a subagent cannot ask for permission. Use a repository-relative path or an allowed command form.";

/** Install the real gate over one fixture table: a push asks, a status allows. */
function installGate(): Gate {
	const registry = registryOf();
	let captured: Gate | null = null;
	const pi = {
		on(name: string, handler: Gate): void {
			if (name === "tool_call") captured = handler;
		},
	};
	const agent: AgentConfig = {
		name: "orchestrator",
		description: "gate fixture",
		systemPrompt: "",
		source: "package",
		filePath: "",
	};
	const ask: PermissionRule[] = [{ tool: "bash", match: "^git\\s+push\\b", reason: "publishing" }];
	const allow: PermissionRule[] = [{ tool: "bash", match: "^git\\s+status\\b" }];
	const source: GateRuleSourceFactory = () => ({
		ruleSets: { globalDeny: [], agentDeny: [], globalAsk: [], agentAsk: ask, agentAllow: allow },
		mode: "deny-by-default",
	});
	installToolCallGate(pi as unknown as ExtensionAPI, () => agent, source, registry);
	assert.ok(captured, "the gate must register a tool_call handler");
	return captured;
}

/** The publish ask, which the fixture table turns into an ask verdict. */
const PUBLISH = { toolName: "bash", input: { command: "git push" } };

test("child ask: the ask verdict is a deny at once, and no timer is scheduled", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	const ctx = childContext(CHILD_A, prompter);

	// Count every timer the gate schedules, so a deadline would show up here.
	const scheduled: Array<number | undefined> = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void, ms?: number, ...rest: unknown[]) => {
		scheduled.push(ms);
		// A flat rest signature, so the generic setTimeout overload cannot fight the spread.
		return (realSetTimeout as unknown as (cb: () => void, ms?: number, ...a: unknown[]) => unknown)(
			callback,
			ms,
			...rest,
		);
	}) as unknown as typeof setTimeout;
	let result: unknown;
	try {
		result = await handler(PUBLISH, ctx);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}

	assert.deepEqual(result, { block: true, reason: REASON }, "the child is denied with the exact reason");
	assert.equal(CHILD_ASK_DENIED_REASON, REASON, "the exported constant holds that text");
	assert.deepEqual(scheduled, [], "a child ask schedules no timer");
	assert.equal(prompter.titles.length, 0, "a child ask renders no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

test("child ask: a context with a prompt surface still denies the child, before any prompt", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];
	// A child id on a UI-bearing context: the child branch must win.
	const ctx = { ...rootContext(prompter), sessionManager: { getSessionId: () => CHILD_A } };

	const result = await handler(PUBLISH, ctx);

	assert.deepEqual(result, { block: true, reason: REASON });
	assert.equal(prompter.titles.length, 0, "the ask never reaches the prompt");
});

test("root ask: the shared prompt still renders unchanged", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];

	const result = await handler(PUBLISH, rootContext(prompter));

	assert.equal(result, undefined, "the owner's allow runs the root call");
	assert.equal(sessionDepthOf(ROOT), 0, "the walk reaches the root at depth 0");
	assert.equal(prompter.titles.length, 1, "the root ask renders one prompt");
	assert.match(prompter.titles[0], /Permission required \(bash\)/, "the root keeps the shared title");
	assert.deepEqual(prompter.options[0], THREE_LABELS, "the three choices are unchanged");
});

test("root ask: the owner's deny still blocks with the user reason", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Deny"];

	const result = await handler(PUBLISH, rootContext(prompter));

	assert.deepEqual(result, { block: true, reason: "Denied by user" });
	assert.equal(prompter.titles.length, 1, "the root prompt rendered once");
});

// --- walked depth ------------------------------------------------------------

// Only this case catches a gate that trusts the record's own depth copy.
test("depth: a record that declares depth 0 is still denied as a child", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	// The record names the root as its parent, so the walk places it one hop down.
	assert.equal(sessionDepthOf(CHILD_D0), 1, "the walk sets the depth, not the record");

	const result = await handler(PUBLISH, childContext(CHILD_D0, prompter));

	assert.deepEqual(result, { block: true, reason: REASON }, "the child is denied at once");
	assert.equal(prompter.titles.length, 0, "a child ask renders no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

// --- fail closed -------------------------------------------------------------

// Only this case catches a session with no record that falls back to the root role.
test("fail closed: an unknown session id denies instead of taking the root role", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Always allow this rule (session)"];
	// The root runs and keeps the same rule, so the deny below comes from the id alone.
	assert.equal(await handler(PUBLISH, rootContext(prompter)), undefined, "the root runs the granted rule");

	const result = await handler(PUBLISH, childContext("never-registered", prompter));

	assert.equal(UNKNOWN_RUN_REASON, "Blocked: no permission record for this session", "the exported text is fixed");
	assert.deepEqual(result, { block: true, reason: UNKNOWN_RUN_REASON });
	assert.equal(prompter.titles.length, 1, "an unknown session shows no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

// Only this case catches a broken walk that reads the root agent at a null depth.
test("fail closed: a broken parent link blocks with the missing session id", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	const broken = { block: true, reason: `Blocked: broken parent chain at session ${MISSING_PARENT}` };

	const result = await handler(PUBLISH, childContext(CHILD_E, prompter));

	assert.deepEqual(result, broken);
	assert.equal(prompter.titles.length, 0, "a broken walk shows no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");

	// A read the root would allow is refused too, so no root role covers the child.
	const read = await handler({ toolName: "bash", input: { command: "git status" } }, childContext(CHILD_E, prompter));
	assert.deepEqual(read, broken, "the broken walk refuses a read as well");
});

// --- grant scope -------------------------------------------------------------

// Only this case catches a child ask that a live root grant answers.
test("grant scope: a root session grant does not cover a child", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Always allow this rule (session)"];

	assert.equal(await handler(PUBLISH, rootContext(prompter)), undefined, "the root runs the granted rule");
	assert.equal(await handler(PUBLISH, rootContext(prompter)), undefined, "the root reuses its own grant");
	assert.equal(prompter.titles.length, 1, "the root grant store is live");

	// CHILD_D0 holds the root's role, so only the session id separates the keys.
	const result = await handler(PUBLISH, childContext(CHILD_D0, prompter));

	assert.deepEqual(result, { block: true, reason: REASON }, "the root grant does not answer for the child");
	assert.equal(prompter.titles.length, 1, "the child ask renders no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

// --- the bound registry ------------------------------------------------------

// Only this case catches an install that never binds the registry a reader uses.
test("bind: the installed gate binds the run registry a reader reads", () => {
	installGate();

	assert.equal(sessionDepthOf(CHILD_A), 1, "a child session reads depth 1");
	assert.equal(sessionDepthOf(ROOT), 0, "a root session reads depth 0");
});
