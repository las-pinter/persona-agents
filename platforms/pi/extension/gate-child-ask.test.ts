/**
 * Child ask routing: the root prompt, the three answers, the deadline, the
 * arrival order, and the fail-closed branches. The gate handler is real and
 * the root prompt is a fake. Most cases inject a deadline of 20 ms, 25 ms, or
 * 40 ms. The cases that inject no deadline use fake timers.
 * Run: npm test
 */

import { after, afterEach, before, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	CHILD_ASK_DEADLINE_MS,
	CHILD_ASK_DEADLINE_REASON,
	CHILD_ASK_NO_SURFACE_REASON,
	bindChildAsk,
	childAskQueue,
	unbindChildAsk,
} from "./child-ask.ts";
import {
	CHILD_A,
	CHILD_B,
	ROOT,
	RootPrompter,
	THREE_LABELS,
	captureRoot,
	childAsk,
	childContext,
	deferred,
	installGate,
	registryOf,
	rootAsk,
	rootContext,
	settleOrStall,
	setup,
	type Setup,
	type ToolCallContext,
} from "./gate-child-ask-fixture.ts";
import {
	DENIED_BY_USER_REASON,
	renderPermissionPrompt,
	type PermissionChoice,
} from "./permission-prompt.ts";
import { newRunRecord } from "./run-registry.ts";

/** Every console line the extension logs, so a case reads it and no case prints it. */
const logged: string[] = [];
const realConsole = { error: console.error, warn: console.warn };

// Every child ask case logs two lines, so one stub for the file lives here.
before(() => {
	const record = (...args: unknown[]): void => {
		logged.push(args.map((arg) => String(arg)).join(" "));
	};
	console.error = record;
	console.warn = record;
});

after(() => {
	console.error = realConsole.error;
	console.warn = realConsole.warn;
});

afterEach(() => {
	unbindChildAsk();
	logged.length = 0;
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

test("root ask: the shared prompt renders", { timeout: 2000 }, async () => {
	const s = setup({ never: true });
	await captureRoot(s);
	void rootAsk(s);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the root ask renders the shared prompt");
	assert.match(s.prompter.titles[0], /Permission required \(bash\)/);
	assert.ok(!s.prompter.titles[0].includes("waiting"), "a root prompt names no child");
	assert.deepEqual(s.prompter.options[0], THREE_LABELS);
});

// --- bind order --------------------------------------------------------------

// Only this case catches a gate installed without its registry bind.
test("bind order: the gate install binds the registry, so no separate bind is needed", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"], bindFirst: false });
	await captureRoot(s);
	assert.equal(childAskQueue()?.depth(CHILD_A), 1, "the gate install bound this registry");

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

// The one case that proves an owner answer travels back to the child verdict.
test("answer flows back: the root's allow once becomes the child's grant", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);

	const result = await childAsk(s, CHILD_A);

	assert.equal(result, undefined, "the child call runs, so the verdict is a grant");
	assert.notEqual((result as { block?: boolean } | undefined)?.block, true, "the verdict is no block");
	assert.equal(s.prompter.titles.length, 1, "the owner answered exactly one prompt");
	assert.match(s.prompter.titles[0], /implementer/, "the prompt named the asking child");
	assert.equal(s.prompter.childUiCalls, 0, "the child surface was never asked");
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
	assert.deepEqual(result, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
	assert.equal(s.prompter.titles.length, 1, "the request was shown once");
	assert.equal(signals.length, 1);
	assert.equal(signals[0].aborted, true, "the timed-out ask must carry an aborted signal");
	assert.equal(childAskQueue()?.waiting(ROOT), 0, "the timed-out request left the queue");
	assert.equal(childAskQueue()?.visible(ROOT), null, "no request stays visible");
	assert.equal(childAskQueue()?.rootCount(), 0, "a drained root is dropped, not retained");
	assert.equal(CHILD_ASK_DEADLINE_MS, 120_000, "the default deadline is 120 s, not a machine instant");
	assert.equal(
		CHILD_ASK_DEADLINE_REASON,
		"Blocked: the permission ask timed out after 120 seconds with no answer",
	);
	assert.ok(!CHILD_ASK_DEADLINE_REASON.includes("subagent cannot ask"), "the old denial text is gone");
});

test("fast fail: a render that never settles refuses a child at 120 s, with fake timers", { timeout: 2000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	// No injected deadline: this case proves the shipped default.
	const s = setup({ never: true });
	await captureRoot(s);
	let settled = false;
	let outcome: unknown = null;
	const pending = childAsk(s, CHILD_A);
	void pending.then(
		(value) => {
			outcome = value;
			settled = true;
		},
		(error) => assert.fail(`the child ask must settle, not reject: ${String(error)}`),
	);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the child ask still reaches the root prompt");

	t.mock.timers.tick(CHILD_ASK_DEADLINE_MS - 1);
	await drainMicrotasks();
	assert.equal(settled, false, "the child is not refused before the deadline");

	t.mock.timers.tick(1);
	await drainMicrotasks();
	assert.equal(settled, true, "the child is refused at the shipped deadline");
	assert.deepEqual(outcome, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
	assert.equal(childAskQueue()?.waiting(ROOT), 0, "the refused request left the queue");
	assert.equal(childAskQueue()?.rootCount(), 0, "the drained root is dropped");
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
		void first.then(
			(outcome) => {
				firstOutcome = outcome;
				firstSettled = true;
			},
			(error) => assert.fail(`the head ask must settle, not reject: ${String(error)}`),
		);
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "the head shows on arrival");

		// The head's deadline counts from t=0, so it fires at t=40.
		t.mock.timers.tick(20);
		await drainMicrotasks();
		const second = childAsk(s, CHILD_B);
		void second.then(
			() => {
				secondSettled = true;
			},
			(error) => assert.fail(`the queued ask must settle, not reject: ${String(error)}`),
		);
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "the queued request waits behind the head");
		assert.equal(childAskQueue()?.waiting(ROOT), 2, "both requests are queued");

		t.mock.timers.tick(20);
		await drainMicrotasks();
		assert.equal(firstSettled, true, "the head times out at its arrival deadline");
		assert.deepEqual(firstOutcome, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
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
	assert.deepEqual(timedOut, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
	// The late answer is a stale panel choice, so it must grant nothing.
	first.resolve("always-allow");
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.equal(await childAsk(s, CHILD_A), undefined);
	assert.equal(renders, 2, "the late always-allow granted nothing");
});

// --- visible deadline --------------------------------------------------------

// Only this case catches a deadline that leaves the terminal with no trace.
test("warnings: an arrival line and a deadline line name the ask and its state", { timeout: 2000 }, async () => {
	const s = setup({ never: true, timeoutMs: 20 });
	await captureRoot(s);

	const result = await childAsk(s, CHILD_A);
	assert.deepEqual(result, { block: true, reason: CHILD_ASK_DEADLINE_REASON });

	// Split by source, so a missing line names itself in its own assertion.
	const queued = logged.filter((line) => line.startsWith("agent-stack: child ask queued "));
	const expired = logged.filter((line) => line.startsWith("agent-stack: child ask expired "));
	assert.equal(queued.length, 1, "one arrival line");
	assert.equal(expired.length, 1, "one deadline line");

	assert.match(queued[0], new RegExp(`root=${ROOT} `), "the arrival line names the root");
	assert.match(queued[0], /child=implementer /, "the arrival line names the child role");
	assert.match(queued[0], /tool=bash /, "the arrival line names the tool");
	assert.match(
		queued[0],
		/waiting=1 shown=none parked=0 surface=yes$/,
		"one request waits, no panel is visible yet, and the root holds a surface",
	);

	assert.match(
		expired[0],
		/^agent-stack: child ask expired with no answer before the deadline /,
		"the deadline line says plainly that no answer arrived",
	);
	assert.match(expired[0], new RegExp(`root=${ROOT} `), "the deadline line names the root");
	assert.match(expired[0], /child=implementer /, "the deadline line names the child role");
	assert.match(expired[0], /tool=bash /, "the deadline line names the tool");
	assert.match(
		expired[0],
		/waiting=1 shown=this parked=1 surface=yes$/,
		"the deadline line shows that this request held the mounted panel",
	);
});

// Only this case catches a flag that claims the panel for a request on screen
// when the panel belongs to the request ahead of it.
test("warnings: a waiter reports the panel of the request ahead, not its own", { timeout: 2000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ never: true, timeoutMs: 40 });
	await captureRoot(s);

	const first = childAsk(s, CHILD_A);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the head shows on arrival");

	t.mock.timers.tick(20);
	const second = childAsk(s, CHILD_B);
	await drainMicrotasks();

	// The second request waits behind the first, which owns the only panel.
	const queued = logged.filter((line) => line.startsWith("agent-stack: child ask queued "));
	assert.equal(queued.length, 2, "two arrival lines");
	assert.match(
		queued[1],
		/waiting=2 shown=other parked=1 surface=yes$/,
		"the waiter reports another request on screen, so its own panel never painted",
	);

	t.mock.timers.tick(20);
	await drainMicrotasks();
	t.mock.timers.tick(20);
	await drainMicrotasks();

	const expired = logged.filter((line) => line.startsWith("agent-stack: child ask expired "));
	assert.equal(expired.length, 2, "two deadline lines");
	assert.match(expired[0], /shown=this /, "the head held the mounted panel when it expired");
	assert.match(expired[1], /shown=this /, "the second request held the panel when it expired");

	assert.deepEqual(await first, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
	assert.deepEqual(await second, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
});

// Only this case reaches the cut branch of the short-id helper.
test("warnings: a root id over twelve characters is cut on the line", { timeout: 2000 }, async () => {
	const longRoot = "root-session-1234567890";
	const registry = registryOf();
	registry.register(
		newRunRecord({
			sessionId: longRoot,
			role: "orchestrator",
			class: "orchestrator",
			source: "package",
			skills: [],
			alwaysLoad: [],
			depth: 0,
			parentSessionId: null,
			sessionFile: null,
			startedAt: 0,
		}),
	);
	registry.register(
		newRunRecord({
			sessionId: CHILD_A,
			role: "implementer",
			class: "worker",
			source: "package",
			skills: [],
			alwaysLoad: [],
			depth: 1,
			parentSessionId: longRoot,
			sessionFile: null,
			startedAt: 0,
		}),
	);
	const prompter = new RootPrompter();
	prompter.never = true;
	bindChildAsk({ timeoutMs: 20 });
	const handler = installGate(registry);
	const longRootContext: ToolCallContext = {
		...rootContext(prompter),
		sessionManager: { getSessionId: () => longRoot },
	};
	const allowed = await handler({ toolName: "bash", input: { command: "git status" } }, longRootContext);
	assert.equal(allowed, undefined, "the long root call runs, so the gate captured its surface");

	const result = await handler(
		{ toolName: "bash", input: { command: "git push" } },
		childContext(CHILD_A, prompter),
	);

	assert.deepEqual(result, { block: true, reason: CHILD_ASK_DEADLINE_REASON });
	const queued = logged.filter((line) => line.startsWith("agent-stack: child ask queued "));
	assert.equal(queued.length, 1, "one arrival line");
	assert.match(queued[0], new RegExp(`root=${longRoot.slice(0, 12)} `), "the line carries the cut root id");
	assert.ok(!queued[0].includes(longRoot), "the whole long root id never reaches the line");
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
	// The missing-surface reason is its own text, apart from the deadline reason.
	assert.equal(CHILD_ASK_NO_SURFACE_REASON, "Blocked: the root session has no prompt surface");
	assert.notEqual(CHILD_ASK_NO_SURFACE_REASON, CHILD_ASK_DEADLINE_REASON);
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

// Only this case catches a surface that outlives the install which captured it.
test("surfaces: a second install over one registry starts with no surface", { timeout: 2000 }, async () => {
	const prompter = new RootPrompter();
	prompter.answers = ["Allow once"];
	const registry = registryOf();
	const first: Setup = {
		handler: installGate(registry),
		prompter,
		root: rootContext(prompter),
		headless: rootContext(prompter, false),
		registry,
	};
	// The first gate captures the root surface on one allowed call.
	await captureRoot(first);

	// The second install keeps the same queue and registry, so only a clear can part them.
	const second: Setup = { ...first, handler: installGate(registry) };
	const result = await childAsk(second, CHILD_A);

	assert.deepEqual(result, { block: true, reason: CHILD_ASK_NO_SURFACE_REASON });
	assert.equal(prompter.titles.length, 0, "the earlier surface may not render a later install");
});
