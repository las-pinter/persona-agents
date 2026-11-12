/**
 * Child gate verdicts: the walked depth places every call, a captured root
 * surface renders the child ask, and the fail-closed guards still hold.
 *
 * A child ask with a captured root surface renders the shared prompt, and the
 * owner's answer becomes the child's verdict. A child ask with no captured root
 * surface blocks at once with the no-surface reason. The walked depth places the
 * call, never the record's own copy of it: a record that declares depth 0 is
 * still a child. A walk that stops short, or a session id the registry never
 * saw, is refused rather than given the root role. A root session grant is keyed
 * to its session, so it does not cover a child.
 *
 * The gate handler is real and the root prompt is a fake.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_ASK_NO_SURFACE_REASON, unbindChildAsk } from "./child-ask.ts";
import {
	CHILD_A,
	CHILD_D0,
	CHILD_E,
	MISSING_PARENT,
	ROOT,
	RootPrompter,
	PROMPT_OPTION_LABELS,
	childContext,
	registryOf,
	rootContext,
} from "./gate-fixture.ts";
import { installToolCallGate, type GateRuleSourceFactory } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import { sessionDepthOf, UNKNOWN_RUN_REASON } from "./run-registry.ts";

afterEach(() => {
	unbindChildAsk();
});

type Gate = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<unknown>;

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

/** One allowed root call, which captures the root prompt surface. */
async function captureRoot(handler: Gate, prompter: RootPrompter): Promise<void> {
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, rootContext(prompter));
	assert.equal(result, undefined, "the root setup call must run");
}

// --- a child ask on the root surface ----------------------------------------

test("child ask: the captured root surface renders the prompt and the answer is the verdict", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];
	await captureRoot(handler, prompter);

	const result = await handler(PUBLISH, childContext(CHILD_A, prompter));

	assert.equal(result, undefined, "the owner's allow grants the child call");
	assert.equal(prompter.titles.length, 1, "the child ask renders the shared prompt");
	assert.match(prompter.titles[0], /implementer/, "the prompt names the asking child");
	assert.match(prompter.titles[0], /1 of 1 waiting/, "the prompt counts the waiting child");
	assert.deepEqual(prompter.options[0], PROMPT_OPTION_LABELS, "the three choices are unchanged");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

test("child ask: no captured root surface blocks at once with its own reason", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];

	const result = await handler(PUBLISH, childContext(CHILD_A, prompter));

	assert.deepEqual(result, { block: true, reason: CHILD_ASK_NO_SURFACE_REASON });
	assert.notEqual(CHILD_ASK_NO_SURFACE_REASON, UNKNOWN_RUN_REASON, "the no-surface text is its own");
	assert.equal(prompter.titles.length, 0, "no surface means no prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

test("child ask: a UI-bearing child context is not its own root surface", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];
	// A child id on a UI-bearing context: the child branch must still win.
	const ctx = { ...rootContext(prompter), sessionManager: { getSessionId: () => CHILD_A } };

	const result = await handler(PUBLISH, ctx);

	assert.deepEqual(result, { block: true, reason: CHILD_ASK_NO_SURFACE_REASON });
	assert.equal(prompter.titles.length, 0, "a child context never renders its own prompt");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
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
	assert.deepEqual(prompter.options[0], PROMPT_OPTION_LABELS, "the three choices are unchanged");
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
test("depth: a record that declares depth 0 still asks as a child", async () => {
	const handler = installGate();
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];
	await captureRoot(handler, prompter);
	// The record names the root as its parent, so the walk places it one hop down.
	assert.equal(sessionDepthOf(CHILD_D0), 1, "the walk sets the depth, not the record");

	const result = await handler(PUBLISH, childContext(CHILD_D0, prompter));

	assert.equal(result, undefined, "the owner's allow grants the child call");
	assert.equal(prompter.titles.length, 1, "the child ask renders no root-style title");
	assert.match(prompter.titles[0], /1 of 1 waiting/, "the child title, not the root title");
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
	prompter.answers = ["Always allow this rule (session)", "Allow once"];
	await captureRoot(handler, prompter);

	assert.equal(await handler(PUBLISH, rootContext(prompter)), undefined, "the root runs the granted rule");
	assert.equal(await handler(PUBLISH, rootContext(prompter)), undefined, "the root reuses its own grant");
	assert.equal(prompter.titles.length, 1, "the root grant store is live");

	// CHILD_D0 holds the root's role, so only the session id separates the keys.
	const result = await handler(PUBLISH, childContext(CHILD_D0, prompter));

	assert.equal(result, undefined, "the child prompt is answered on its own");
	assert.equal(prompter.titles.length, 2, "the root grant does not answer for the child");
	assert.match(prompter.titles[1], /orchestrator/, "the child prompt names the same role");
	assert.equal(prompter.childUiCalls, 0, "the child surface is never asked");
});

// --- the bound registry ------------------------------------------------------

// Only this case catches an install that never binds the registry a reader uses.
test("bind: the installed gate binds the run registry a reader reads", () => {
	installGate();

	assert.equal(sessionDepthOf(CHILD_A), 1, "a child session reads depth 1");
	assert.equal(sessionDepthOf(ROOT), 0, "a root session reads depth 0");
});
