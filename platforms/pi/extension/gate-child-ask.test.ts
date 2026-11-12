/**
 * Child ask routing: the root prompt, the three answers, the deadline, the
 * arrival order, and the fail-closed branches. The gate handler is real and
 * the root prompt is a fake. Most cases inject a deadline of 20 ms, 25 ms, or
 * 40 ms. The cases that inject no deadline use fake timers. The warning cases
 * are the last cases of the deadline block, so this file keeps one
 * responsibility: child ask routing.
 * Run: npm test
 */

import { afterEach, beforeEach, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	CHILD_ASK_DEADLINE_MS,
	CHILD_ASK_NO_SURFACE_REASON,
	bindChildAsk,
	childAskQueue,
	deadlineReason,
	unbindChildAsk,
} from "./child-ask.ts";
import {
	CHILD_A,
	CHILD_B,
	CHILD_E,
	ROOT,
	RootPrompter,
	PROMPT_OPTION_LABELS,
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
import { createAskLog, type AskLogEvent } from "./ask-record.ts";
import { readAllEvents } from "./tree-log.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

/** The log file of the current case, so one case reads no other. */
let caseLog = "";
let caseCounter = 0;

/** The ask rows of the current case, oldest first, folded the way the panel folds them. */
function askRows(): AskLogEvent[] {
	const ring = createAskLog();
	for (const event of readAllEvents(caseLog)) ring.observe(event);
	return ring.rows();
}

/** One row of the ring. */
interface LoggedLine {
	text: string;
}

/** The ask rows of the current case at one stage, oldest first. */
function linesWith(phase: "arrival" | "expiry"): LoggedLine[] {
	return askRows()
		.filter((row) => row.phase === phase)
		.map((row) => ({ text: row.text }));
}

beforeEach(() => {
	caseCounter += 1;
	caseLog = path.join(tmpdir(), `gate-child-ask-log-${process.pid}-${caseCounter}-${Date.now()}.ndjson`);
	process.env[ENV_TREE_LOG] = caseLog;
});

afterEach(() => {
	unbindChildAsk();
	rmSync(caseLog, { force: true });
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
	assert.deepEqual(s.prompter.options[0], PROMPT_OPTION_LABELS);
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

// --- depth read --------------------------------------------------------------

test("depth: the queue reads the walked depth and null when no root is reachable", { timeout: 2000 }, async () => {
	const s = setup();
	await captureRoot(s);

	assert.equal(childAskQueue()?.depth(CHILD_A), 1, "the queue reads the walked depth");
	assert.equal(childAskQueue()?.depth("no-such-session"), null, "an unknown id has no depth");
	assert.equal(childAskQueue()?.depth(CHILD_E), null, "a broken chain has no depth");
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
	assert.deepEqual(result, { block: true, reason: deadlineReason(25) });
	assert.equal(s.prompter.titles.length, 1, "the request was shown once");
	assert.equal(signals.length, 1);
	assert.equal(signals[0].aborted, true, "the timed-out ask must carry an aborted signal");
	assert.equal(childAskQueue()?.waiting(ROOT), 0, "the timed-out request left the queue");
	assert.equal(childAskQueue()?.visible(ROOT), null, "no request stays visible");
	assert.equal(childAskQueue()?.rootCount(), 0, "a drained root is dropped, not retained");
	assert.equal(CHILD_ASK_DEADLINE_MS, 120_000, "the default deadline is 120 s, not a machine instant");
	assert.equal(
		deadlineReason(CHILD_ASK_DEADLINE_MS),
		"Blocked: the permission ask timed out after 120 s with no answer",
	);
	assert.match(String(result && result.reason), /25 ms/, "the reason names the 25 ms timeout");
	assert.ok(!String(result && result.reason).includes("120"), "the default timeout is not reported");
	assert.ok(!deadlineReason(CHILD_ASK_DEADLINE_MS).includes("subagent cannot ask"), "the old denial text is gone");
});

test("deadline reason: a whole second count reads in seconds and a part second reads in ms", () => {
	assert.match(deadlineReason(CHILD_ASK_DEADLINE_MS), / after 120 s with no answer$/);
	assert.match(deadlineReason(120_000), / after 120 s with no answer$/);
	assert.match(deadlineReason(1000), / after 1 s with no answer$/);
	assert.match(deadlineReason(999), / after 999 ms with no answer$/);
	assert.match(deadlineReason(1500), / after 1500 ms with no answer$/);
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
	assert.deepEqual(outcome, { block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) });
	// The default case pins the default text by hand, so a format break cannot pass.
	assert.match(
		String((outcome as { reason?: string } | null)?.reason),
		/after 120 s with no answer$/,
		"the default reason names 120 s in seconds",
	);
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
		assert.deepEqual(firstOutcome, { block: true, reason: deadlineReason(40) });
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
	assert.deepEqual(timedOut, { block: true, reason: deadlineReason(20) });
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
	assert.deepEqual(result, { block: true, reason: deadlineReason(20) });

	// Split by stage, so a missing row names itself in its own assertion.
	const queued = linesWith("arrival");
	const expired = linesWith("expiry");
	assert.equal(queued.length, 1, "one arrival row");
	assert.equal(expired.length, 1, "one deadline row");

	assert.match(
		queued[0].text,
		/^\d{2}:\d{2}:\d{2} implementer\/bash root=\S+ phase=arrival /,
		"the arrival row names the child, the tool, the root, and the stage",
	);
	assert.ok(queued[0].text.includes(`root=${ROOT} `), "the arrival row names the root");
	assert.match(
		queued[0].text,
		/queued=1 shown=none parked=0 surface=yes$/,
		"one request is queued, no panel is visible yet, and the root holds a surface",
	);

	assert.match(
		expired[0].text,
		/^\d{2}:\d{2}:\d{2} implementer\/bash root=\S+ phase=expiry /,
		"the deadline row names the child, the tool, the root, and the stage",
	);
	assert.ok(expired[0].text.includes(`root=${ROOT} `), "the deadline row names the root");
	assert.match(
		expired[0].text,
		/waiting=0 shown=this place=slot parked=1 surface=yes$/,
		"no other request waits, and this request owned the mounted panel",
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
	const queued = linesWith("arrival");
	assert.equal(queued.length, 2, "two arrival rows");
	assert.match(
		queued[1].text,
		/queued=2 shown=other parked=1 surface=yes$/,
		"the waiter is queued behind another request on screen, so its own panel never painted",
	);

	t.mock.timers.tick(20);
	await drainMicrotasks();
	t.mock.timers.tick(20);
	await drainMicrotasks();

	const expired = linesWith("expiry");
	assert.equal(expired.length, 2, "two deadline rows");
	assert.match(
		expired[0].text,
		/implementer\/bash root=\S+ phase=expiry waiting=1 shown=this place=slot /,
		"the head row names its own child, tool, count, panel, and place",
	);
	assert.match(
		expired[1].text,
		/tester\/bash root=\S+ phase=expiry waiting=0 shown=this place=slot /,
		"the next row names its own child, tool, count, panel, and place",
	);

	assert.deepEqual(await first, { block: true, reason: deadlineReason(40) });
	assert.deepEqual(await second, { block: true, reason: deadlineReason(40) });
});

// This case pins `place=slot` for a request whose mount never painted. Four
// other expiry assertions across three cases read `place=slot` too, so the
// value is not unique here.
test("warnings: an expiry at the panel slot says where the request stood", { timeout: 2000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ never: true });
	await captureRoot(s);

	// The root panel holds the only slot until this case answers it.
	const root = rootAsk(s);
	await drainMicrotasks();
	const child = childAsk(s, CHILD_A);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the child waits behind the root panel");

	t.mock.timers.tick(CHILD_ASK_DEADLINE_MS);
	await drainMicrotasks();

	const expired = linesWith("expiry");
	assert.equal(expired.length, 1, "one deadline row");
	assert.match(
		expired[0].text,
		/waiting=0 shown=none place=slot parked=1 surface=yes$/,
		"the row says the mount began, not that the request stayed queued",
	);
	assert.deepEqual(await child, { block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) });

	s.prompter.release("Deny");
	assert.deepEqual(await root, { block: true, reason: DENIED_BY_USER_REASON }, "the root ask denies");
});

// This case pins `place=queue`: the waiter's mount never began while the
// head's mount began and waited for the shared panel slot.
test("warnings: an expiry still in the queue says where the request stood", { timeout: 2000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ never: true });
	await captureRoot(s);

	const root = rootAsk(s);
	await drainMicrotasks();
	const first = childAsk(s, CHILD_A);
	await drainMicrotasks();
	// Stagger the arrivals, so the two deadlines fall in arrival order.
	t.mock.timers.tick(1000);
	const second = childAsk(s, CHILD_B);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "no child panel mounts beside the root panel");

	t.mock.timers.tick(CHILD_ASK_DEADLINE_MS - 1000);
	await drainMicrotasks();
	t.mock.timers.tick(1000);
	await drainMicrotasks();

	const expired = linesWith("expiry");
	assert.equal(expired.length, 2, "two deadline rows");
	assert.match(
		expired[0].text,
		/implementer\/bash root=\S+ phase=expiry waiting=1 shown=none place=slot /,
		"the head's mount began while the root held the slot",
	);
	assert.match(
		expired[1].text,
		/tester\/bash root=\S+ phase=expiry waiting=0 shown=none place=queue parked=1 /,
		"the waiter never began a mount, so it stayed queued",
	);
	assert.deepEqual(await first, { block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) });
	assert.deepEqual(await second, { block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) });

	s.prompter.release("Deny");
	assert.deepEqual(await root, { block: true, reason: DENIED_BY_USER_REASON }, "the root ask denies");
});

// Only this case reaches the cut branch of the short-id helper.
test("warnings: a 29-character root id is cut and marked on the line", { timeout: 2000 }, async () => {
	const longRoot = "root-session-0123456789abcdef";
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

	assert.deepEqual(result, { block: true, reason: deadlineReason(20) });
	const queued = linesWith("arrival");
	assert.equal(queued.length, 1, "one arrival row");
	assert.ok(queued[0].text.includes(`root=${longRoot.slice(0, 12)}… `), "the cut id carries its marker");
	assert.ok(!queued[0].text.includes(longRoot), "the whole long root id never reaches the row");
});

// Only this case pins the writer guard: a throw inside the log write may not
// skip the deadline block or leave the request in the queue.
test("warnings: a log writer that throws still blocks the child at the deadline", { timeout: 2000 }, async () => {
	const s = setup({ never: true, timeoutMs: 20 });
	await captureRoot(s);

	// The writer reads the log path from the environment. Only that one key
	// throws, so the rest of the gate keeps its own environment.
	const realEnv = process.env;
	const envDescriptor = Object.getOwnPropertyDescriptor(process, "env");
	Object.defineProperty(process, "env", {
		configurable: true,
		get(): NodeJS.ProcessEnv {
			return new Proxy(realEnv, {
				get(target, key, receiver): unknown {
					if (key === ENV_TREE_LOG) throw new Error("the log environment is gone");
					return Reflect.get(target, key, receiver);
				},
			});
		},
	});
	try {
		const result = await childAsk(s, CHILD_A);
		assert.deepEqual(
			result,
			{ block: true, reason: deadlineReason(20) },
			"the deadline block must arrive although the write threw",
		);
		assert.equal(childAskQueue()?.waiting(ROOT), 0, "the request left the queue");
	} finally {
		if (envDescriptor) Object.defineProperty(process, "env", envDescriptor);
	}
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
	assert.notEqual(CHILD_ASK_NO_SURFACE_REASON, deadlineReason(CHILD_ASK_DEADLINE_MS));
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
