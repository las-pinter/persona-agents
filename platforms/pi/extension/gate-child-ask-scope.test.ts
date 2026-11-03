/**
 * Child ask scope: the grant key, the walked depth, and the fail-closed walk.
 * The gate handler is real and the root prompt is a fake.
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { bindChildAskRegistry, childAskQueue } from "./child-ask.ts";
import { UNKNOWN_RUN_REASON } from "./run-registry.ts";
import {
	CHILD_A,
	CHILD_B,
	CHILD_C,
	CHILD_D,
	CHILD_E,
	CHILD_G,
	MISSING_PARENT,
	ROOT,
	WORKER_CLASS_DENY_REASON,
	captureRoot,
	childAsk,
	childContext,
	rootAsk,
	setup,
} from "./gate-child-ask-fixture.ts";
import { renderPermissionPrompt } from "./permission-prompt.ts";

afterEach(() => {
	bindChildAskRegistry(null);
});

// --- grant scope -------------------------------------------------------------

// Only this case catches a root grant that the root cannot reuse itself.
test("grant scope: a root grant does not cover a child", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Always allow this rule (session)", "Allow once"] });
	await captureRoot(s);
	await rootAsk(s);
	// The root reuses its own grant, so the store is live.
	assert.equal(await rootAsk(s), undefined);
	assert.equal(s.prompter.titles.length, 1, "the root reuses its own grant");
	const result = await childAsk(s, CHILD_A);
	assert.equal(result, undefined);
	assert.equal(s.prompter.titles.length, 2, "the child prompt is not covered by the root grant");
	assert.match(s.prompter.titles[1], /implementer/);
});

// Passes on role difference alone; the same-role case carries the session-id proof.
test("grant scope: a child grant does not cover its sibling", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Always allow this rule (session)", "Allow once"] });
	await captureRoot(s);
	await childAsk(s, CHILD_A);
	await childAsk(s, CHILD_A);
	const sibling = await childAsk(s, CHILD_B);
	assert.equal(sibling, undefined);
	assert.equal(s.prompter.titles.length, 2, "the sibling prompt is not covered by the first child");
	assert.match(s.prompter.titles[1], /tester/);
});

// Only this case catches a grant keyed without the session id.
test("grant scope: a child grant does not cover a same-role sibling", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Always allow this rule (session)", "Allow once"] });
	await captureRoot(s);
	await childAsk(s, CHILD_A);
	assert.equal(await childAsk(s, CHILD_A), undefined, "the granted child reuses its grant");
	const sibling = await childAsk(s, CHILD_C);
	assert.equal(sibling, undefined);
	assert.equal(s.prompter.titles.length, 2, "the session id, not the role, carries the grant");
	assert.match(s.prompter.titles[1], /implementer/);
});

// --- walked depth ------------------------------------------------------------

test("depth: a wrong declared depth still asks through the root queue", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	const result = await childAsk(s, CHILD_D);
	assert.equal(result, undefined, "a real parent link makes the record a child");
	assert.equal(s.prompter.titles.length, 1, "the walked depth reached the queue");
	assert.equal(s.prompter.childUiCalls, 0, "the child surface is never asked");
});

test("depth: a grandchild asks at the top root, not the middle session", { timeout: 2000 }, async () => {
	const seen: { atRoot: string | null; atMiddle: string | null } = { atRoot: null, atMiddle: null };
	const s = setup({
		answers: ["Allow once"],
		render: (ctx, model, signal) => {
			seen.atRoot = childAskQueue()?.visible(ROOT) ?? null;
			seen.atMiddle = childAskQueue()?.visible(CHILD_A) ?? null;
			return renderPermissionPrompt(ctx, model, signal);
		},
	});
	await captureRoot(s);
	const result = await childAsk(s, CHILD_G);
	assert.equal(result, undefined, "the grandchild reaches the root surface");
	assert.equal(seen.atRoot, CHILD_G, "the visible head sits on the top root");
	assert.equal(seen.atMiddle, null, "the middle session has no queue of its own");
	assert.equal(s.prompter.titles.length, 1);
});

// --- fail closed -------------------------------------------------------------

// Only this case catches a broken walk that reads the root agent at a null depth.
test("fail closed: a broken parent link blocks with the missing session id", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	const result = await childAsk(s, CHILD_E);
	assert.deepEqual(result, {
		block: true,
		reason: `Blocked: broken parent chain at session ${MISSING_PARENT}`,
	});
	assert.equal(s.prompter.titles.length, 0, "a broken walk shows no prompt");
	assert.equal(childAskQueue()?.waiting(ROOT), 0);
	assert.equal(childAskQueue()?.rootCount(), 0);

	// The child's own class row answers. A root-agent fallback would allow this read.
	const classVerdict = await s.handler(
		{ toolName: "bash", input: { command: "git status" } },
		childContext(CHILD_E, s.prompter),
	);
	assert.deepEqual(classVerdict, { block: true, reason: WORKER_CLASS_DENY_REASON });
});

// Only this case catches a session with no record that falls back to the root role.
test("fail closed: an unknown session id denies instead of taking the root role", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	const unknown = "never-registered";
	assert.equal(s.registry.get(unknown), undefined, "the registry holds no record for this id");

	// The same command the root just ran is allowed, so the deny comes from the id.
	const result = await s.handler(
		{ toolName: "bash", input: { command: "git status" } },
		childContext(unknown, s.prompter),
	);

	assert.deepEqual(result, { block: true, reason: UNKNOWN_RUN_REASON });
	assert.equal(s.prompter.titles.length, 0, "an unknown session shows no prompt");
	assert.equal(s.prompter.childUiCalls, 0, "the child surface is never asked");
});
