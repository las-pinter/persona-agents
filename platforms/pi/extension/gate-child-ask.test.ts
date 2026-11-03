/**
 * Child ask routing: the root prompt, the three answers, the deadline, the
 * arrival order, and the fail-closed branches. The gate handler is real and
 * the root prompt is a fake. The deadline is injected per case, at 20 ms, 25 ms,
 * or 40 ms.
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	CHILD_ASK_NO_SURFACE_REASON,
	CHILD_ASK_TIMEOUT_MS,
	CHILD_ASK_TIMEOUT_REASON,
	bindChildAskRegistry,
	childAskQueue,
} from "./child-ask.ts";
import {
	CHILD_A,
	CHILD_B,
	ROOT,
	captureRoot,
	childAsk,
	deferred,
	rootAsk,
	settleOrStall,
	setup,
} from "./gate-child-ask-fixture.ts";
import {
	DENIED_BY_USER_REASON,
	renderPermissionPrompt,
	type PermissionChoice,
} from "./permission-prompt.ts";

afterEach(() => {
	bindChildAskRegistry(null);
});

// --- one root prompt ---------------------------------------------------------

test("one root prompt: two children reach one visible prompt in turn", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once", "Allow once"] });
	await captureRoot(s);
	const [first, second] = await Promise.all([childAsk(s, CHILD_A), childAsk(s, CHILD_B)]);
	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(s.prompter.titles.length, 2, "each child gets one prompt");
	assert.equal(s.prompter.maxActive, 1, "two child asks must never show two prompts");
	assert.match(s.prompter.titles[0], /implementer/);
	assert.match(s.prompter.titles[0], /1 of 2 waiting/);
	assert.match(s.prompter.titles[1], /tester/);
	assert.match(s.prompter.titles[1], /1 of 1 waiting/);
	assert.equal(s.prompter.childUiCalls, 0, "a child context is never asked");
});

test("one root prompt: the root's own ask still renders the shared prompt", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	const result = await rootAsk(s);
	assert.equal(result, undefined);
	assert.equal(s.prompter.titles.length, 1);
	assert.match(s.prompter.titles[0], /Permission required \(bash\)/);
	assert.ok(!s.prompter.titles[0].includes("waiting"), "a root prompt names no child");
	assert.deepEqual(s.prompter.options[0], ["Allow once", "Always allow this rule (session)", "Deny"]);
});

// --- bind order --------------------------------------------------------------

// Only this case catches a gate installed without its registry bind.
test("bind order: the gate install binds the registry, so no separate bind is needed", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"], bindFirst: false });
	await captureRoot(s);
	assert.equal(childAskQueue()?.serves(s.registry), true, "the gate install bound this registry");

	const result = await childAsk(s, CHILD_A);

	assert.equal(result, undefined, "the child ask was answered");
	assert.equal(s.prompter.titles.length, 1, "the child ask reached the root prompt");
	assert.match(s.prompter.titles[0], /implementer/, "the prompt names the child role");
});

// --- three answers -----------------------------------------------------------

test("three answers: deny blocks the child with the user reason", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Deny"] });
	await captureRoot(s);
	const result = await childAsk(s, CHILD_A);
	assert.equal(s.prompter.titles.length, 1);
	assert.deepEqual(result, { block: true, reason: DENIED_BY_USER_REASON });
});

test("three answers: allow once runs the child call on one prompt", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	const result = await childAsk(s, CHILD_A);
	assert.equal(result, undefined);
	assert.equal(s.prompter.titles.length, 1);
});

test("three answers: always allow covers later calls of the same child only", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Always allow this rule (session)"] });
	await captureRoot(s);
	const first = await childAsk(s, CHILD_A);
	const second = await childAsk(s, CHILD_A);
	assert.equal(first, undefined);
	assert.equal(second, undefined);
	assert.equal(s.prompter.titles.length, 1, "the remembered rule suppresses the second ask");
});

// --- timeout -----------------------------------------------------------------

test("timeout: an unanswered request leaves the queue and blocks with the deadline reason", { timeout: 2000 }, async () => {
	const signals: AbortSignal[] = [];
	const s = setup({
		never: true,
		timeoutMs: 25,
		render: (ctx, model, signal) => {
			signals.push(signal);
			return renderPermissionPrompt(ctx, model, signal);
		},
	});
	await captureRoot(s);
	const result = await childAsk(s, CHILD_A);
	assert.deepEqual(result, { block: true, reason: CHILD_ASK_TIMEOUT_REASON });
	assert.equal(s.prompter.titles.length, 1, "the request was shown once");
	assert.equal(signals.length, 1);
	assert.equal(signals[0].aborted, true, "the timed-out ask must carry an aborted signal");
	assert.equal(childAskQueue()?.waiting(ROOT), 0, "the timed-out request left the queue");
	assert.equal(childAskQueue()?.visible(ROOT), null, "no request stays visible");
	assert.equal(childAskQueue()?.rootCount(), 0, "a drained root is dropped, not retained");
	assert.equal(CHILD_ASK_TIMEOUT_MS, 120_000);
	assert.equal(CHILD_ASK_TIMEOUT_REASON, "Blocked: the permission request timed out after 120 s");
});

/** Let the queue's microtask pump run without advancing a timer. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

test(
	"timeout: a queued request counts its deadline from arrival, not display",
	{ timeout: 2000 },
	async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const s = setup({ never: true, timeoutMs: 40 });
		await captureRoot(s);

		let firstSettled = false;
		let secondSettled = false;
		let firstOutcome: unknown = null;
		const first = childAsk(s, CHILD_A);
		void first.then((outcome) => {
			firstOutcome = outcome;
			firstSettled = true;
		});
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "the head shows on arrival");

		// The head's deadline counts from t=0, so it fires at t=40.
		t.mock.timers.tick(20);
		await drainMicrotasks();
		const second = childAsk(s, CHILD_B);
		void second.then(() => {
			secondSettled = true;
		});
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "the queued request waits behind the head");
		assert.equal(childAskQueue()?.waiting(ROOT), 2, "both requests are queued");

		t.mock.timers.tick(20);
		await drainMicrotasks();
		assert.equal(firstSettled, true, "the head times out at its arrival deadline");
		assert.deepEqual(firstOutcome, { block: true, reason: CHILD_ASK_TIMEOUT_REASON });
		assert.equal(secondSettled, false, "the queued request is not settled by the head's deadline");
		assert.equal(s.prompter.titles.length, 2, "the head leaves, then the next request is shown");
		assert.equal(childAskQueue()?.visible(ROOT), CHILD_B, "the second request is on screen");

		// A display-based deadline would start here and fire at t=80.
		t.mock.timers.tick(19);
		await drainMicrotasks();
		assert.equal(secondSettled, false, "19 ms on screen is not yet its arrival deadline");
		assert.equal(s.prompter.titles.length, 2, "the queued request still waits");

		t.mock.timers.tick(1);
		await drainMicrotasks();
		assert.equal(secondSettled, true, "the queued request times out at arrival + 40 ms");
		assert.equal(childAskQueue()?.waiting(ROOT), 0, "both requests left the queue");
		assert.equal(childAskQueue()?.visible(ROOT), null, "no request stays visible");
		assert.equal(childAskQueue()?.rootCount(), 0, "the drained root is dropped");
	},
);

test("timeout: an answer that arrives after the deadline changes nothing", { timeout: 2000 }, async () => {
	const first = deferred<PermissionChoice>();
	let renders = 0;
	const s = setup({
		timeoutMs: 20,
		render: () => {
			renders += 1;
			return renders === 1 ? first.promise : Promise.resolve<PermissionChoice>("allow-once");
		},
	});
	await captureRoot(s);
	const timedOut = await childAsk(s, CHILD_A);
	assert.deepEqual(timedOut, { block: true, reason: CHILD_ASK_TIMEOUT_REASON });
	// The late answer is a stale panel choice, so it must grant nothing.
	first.resolve("always-allow");
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.equal(await childAsk(s, CHILD_A), undefined);
	assert.equal(renders, 2, "the late always-allow granted nothing");
});

// --- FIFO --------------------------------------------------------------------

test("FIFO: arrival order holds and a denied head shows the next request", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Deny", "Allow once"] });
	await captureRoot(s);
	const first = childAsk(s, CHILD_A);
	const second = childAsk(s, CHILD_B);
	assert.deepEqual(await first, { block: true, reason: DENIED_BY_USER_REASON });
	assert.equal(await second, undefined);
	assert.equal(s.prompter.titles.length, 2);
	assert.match(s.prompter.titles[0], /implementer/);
	assert.match(s.prompter.titles[0], /1 of 2 waiting/);
	assert.match(s.prompter.titles[1], /tester/);
	assert.match(s.prompter.titles[1], /1 of 1 waiting/);
});

// --- fail closed -------------------------------------------------------------

test("fail closed: a child ask with no captured root surface blocks", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	const result = await childAsk(s, CHILD_A);
	assert.deepEqual(result, { block: true, reason: CHILD_ASK_NO_SURFACE_REASON });
	assert.equal(s.prompter.titles.length, 0, "no surface means no prompt");
});

test(
	"fail closed: a headless root binds no surface, so the child blocks at once",
	{ timeout: 2000 },
	async () => {
		const s = setup({ answers: ["Allow once"] });
		// The call is allowed, so the gate reaches the capture with no prompt.
		await captureRoot(s, s.headless);
		const result = await settleOrStall(childAsk(s, CHILD_A), 500);
		assert.notEqual(result, "stalled", "a headless root must not stall the child");
		assert.deepEqual(result, { block: true, reason: CHILD_ASK_NO_SURFACE_REASON });
		assert.equal(s.prompter.titles.length, 0, "a headless root shows no prompt");
		assert.equal(childAskQueue()?.rootCount(), 0, "the drained root is dropped");
	},
);

test("fail closed: a rejected prompt blocks the child with the user reason", { timeout: 2000 }, async () => {
	const s = setup({ render: () => Promise.reject(new Error("prompt cancelled")) });
	await captureRoot(s);
	const result = await childAsk(s, CHILD_A);
	assert.deepEqual(result, { block: true, reason: DENIED_BY_USER_REASON });
});
