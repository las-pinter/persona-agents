/**
 * The ask panel slot: one root panel and one child panel never mount on the
 * terminal at the same time.
 *
 * The root ask holds the slot while its panel is live. The child queue takes the
 * slot before it renders, and it keeps its arrival deadline while it waits. The
 * slot is released on every exit, so a throw, a reject, a deny, a cancel, or a
 * timeout leaves the terminal free for the next ask.
 *
 * Run: npm test
 */

import { afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import { askPanelSlot } from "./ask-panel-slot.ts";
import {
	CHILD_ASK_DEADLINE_MS,
	bindChildAsk,
	childAskQueue,
	deadlineReason,
	unbindChildAsk,
	type ChildAskRender,
} from "./child-ask.ts";
import { CHILD_A, CHILD_B, CHILD_C, ROOT, captureRoot, childAsk, deferred, rootAsk, setup } from "./gate-child-ask-fixture.ts";
import {
	buildPromptModel,
	renderRootPermissionPrompt,
	type PermissionChoice,
	type PromptModel,
} from "./permission-prompt.ts";

afterEach(() => {
	unbindChildAsk();
});

const REASON = "publishing is blocked";

function publishModel(): PromptModel {
	return buildPromptModel({
		toolName: "bash",
		probe: "git push",
		segment: "git push",
		segmentStart: 0,
		reason: REASON,
		isSpanning: false,
	});
}

/** Let the pending microtask chain run without advancing a timer. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// --- one panel at a time -----------------------------------------------------

test("slot: a root panel and a child panel never mount together", { timeout: 2000 }, async () => {
	// Both paths use the real renderer, so the fake host counts every live panel.
	const s = setup({ answers: ["Allow once", "Allow once"] });
	await captureRoot(s);

	const root = rootAsk(s);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the root panel mounts alone");
	assert.match(s.prompter.titles[0], /Permission required \(bash\)/, "the root panel shows first");

	const child = childAsk(s, CHILD_A);
	await drainMicrotasks();
	assert.equal(
		s.prompter.titles.length,
		1,
		"the child panel may not mount beside the live root panel",
	);
	assert.equal(askPanelSlot.busy, true, "the root panel holds the slot");
	assert.equal(askPanelSlot.pending, 1, "the child ask waits for the slot");

	assert.equal(await root, undefined, "the owner allowed the root call once");
	assert.equal(await child, undefined, "the child call runs after the owner answers");
	assert.equal(s.prompter.titles.length, 2, "the child panel mounts after the root panel settles");
	assert.match(s.prompter.titles[1], /implementer/, "the second panel is the child prompt");
	assert.equal(s.prompter.maxActive, 1, "two panels never run at the same time");
	assert.equal(askPanelSlot.busy, false, "both panels released the slot");
});

// Only the exact renderRootPermissionPrompt reference is caught. The cast only
// lets this reference reach the child render type; the identity check still runs.
test("slot: bindChildAsk rejects the root renderer", { timeout: 2000 }, () => {
	const rootRenderer = renderRootPermissionPrompt as unknown as ChildAskRender;
	assert.throws(() => bindChildAsk({ render: rootRenderer }), /deadlock/);
});

// --- exception safety --------------------------------------------------------

test("slot: a root panel that throws still frees the slot", { timeout: 2000 }, async () => {
	const host = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom(): never {
				throw new Error("overlay failed");
			},
		},
	} as unknown as Parameters<typeof renderRootPermissionPrompt>[0];

	await assert.rejects(
		renderRootPermissionPrompt(host, publishModel()),
		/overlay failed/,
		"the render error reaches the caller",
	);
	assert.equal(askPanelSlot.busy, false, "the failed panel released the slot");

	// The next root ask proves the slot is usable again, not just reported free.
	const s = setup({ answers: ["Allow once"] });
	await captureRoot(s);
	assert.equal(await rootAsk(s), undefined, "the next root ask is answered");
	assert.equal(s.prompter.titles.length, 1, "the next root panel mounts");
});

test("slot: a child panel that rejects still frees the slot", { timeout: 2000 }, async () => {
	let renders = 0;
	const s = setup({
		render: () => {
			renders += 1;
			return renders === 1
				? Promise.reject(new Error("prompt cancelled"))
				: Promise.resolve("allow-once" as const);
		},
	});
	await captureRoot(s);

	const rejected = await childAsk(s, CHILD_A);
	assert.equal(renders, 1, "the first child panel ran once");
	assert.deepEqual(rejected, { block: true, reason: "Denied by user" }, "a reject denies");
	assert.equal(askPanelSlot.busy, false, "the rejected panel released the slot");

	assert.equal(await childAsk(s, CHILD_A), undefined, "the next child panel still mounts");
	assert.equal(renders, 2, "the second child panel ran");
});

// --- a wait is always bounded ------------------------------------------------

test("slot: a child behind a live panel mounts when the panel settles", { timeout: 2000 }, async () => {
	const s = setup({ answers: ["Deny", "Allow once"] });
	await captureRoot(s);

	const root = rootAsk(s);
	await drainMicrotasks();
	const child = childAsk(s, CHILD_A);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the child waits behind the root panel");

	assert.deepEqual(await root, { block: true, reason: "Denied by user" }, "the root ask denies");
	assert.equal(await child, undefined, "the child ask settles after the root panel closes");
	assert.equal(s.prompter.titles.length, 2, "the child panel mounts on the freed slot");
	assert.equal(s.prompter.maxActive, 1, "one panel at a time");
});

test("slot: a child that expires while it waits never mounts", { timeout: 2000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	// The root panel holds the slot until the test answers it.
	const s = setup({ never: true });
	await captureRoot(s);

	const root = rootAsk(s);
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the root panel holds the slot");

	let settled = false;
	let outcome: unknown = null;
	const child = childAsk(s, CHILD_A);
	void child.then(
		(value) => {
			outcome = value;
			settled = true;
		},
		(error) => assert.fail(`a waiting child ask must settle, not reject: ${String(error)}`),
	);
	await drainMicrotasks();
	assert.equal(settled, false, "the child has no panel yet");
	assert.equal(s.prompter.titles.length, 1, "the child mounts no panel beside the root panel");

	// The deadline counts from arrival, so it fires while the child still waits.
	t.mock.timers.tick(CHILD_ASK_DEADLINE_MS - 1);
	await drainMicrotasks();
	assert.equal(settled, false, "the child is not expired before its deadline");

	t.mock.timers.tick(1);
	await drainMicrotasks();
	assert.equal(settled, true, "the child settles at its arrival deadline");
	assert.deepEqual(outcome, { block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) });

	// Release the root panel, so the parked child mount resumes. It must stop at
	// the settled guard instead of meeting the root surface a second time.
	s.prompter.release("Deny");
	await drainMicrotasks();
	await drainMicrotasks();
	assert.equal(s.prompter.titles.length, 1, "the expired child never mounted a panel");
	assert.deepEqual(await root, { block: true, reason: "Denied by user" }, "the root ask denies");
	assert.equal(childAskQueue()?.waiting(ROOT), 0, "the expired request left the queue");
	assert.equal(childAskQueue()?.rootCount(), 0, "the drained root is dropped");
});

// Only this case follows a live waiter past two expired waiters, so a slot
// that a settled mount keeps after it wakes cannot pass. The third child is
// live when the slot frees, so only it can mount.
test(
	"slot: the third of three children mounts after two expire behind the root",
	{ timeout: 2000 },
	async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const s = setup({ never: true });
		await captureRoot(s);

		// The root panel holds the only slot until this case answers it.
		const root = rootAsk(s);
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "the root panel holds the slot");

		const first = childAsk(s, CHILD_A);
		await drainMicrotasks();
		// Stagger the arrivals, so the three deadlines fall in arrival order.
		t.mock.timers.tick(1000);
		const second = childAsk(s, CHILD_B);
		await drainMicrotasks();
		t.mock.timers.tick(1000);
		const third = childAsk(s, CHILD_C);
		await drainMicrotasks();
		assert.equal(s.prompter.titles.length, 1, "no child panel mounts beside the root panel");
		assert.equal(askPanelSlot.pending, 1, "only the first child waits on the slot");
		assert.equal(childAskQueue()?.waiting(ROOT), 3, "three requests wait on the root");

		// The first two reach their arrival deadlines while the root holds the slot.
		t.mock.timers.tick(CHILD_ASK_DEADLINE_MS - 2000);
		await drainMicrotasks();
		assert.deepEqual(
			await first,
			{ block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) },
			"the first child expires in the wait",
		);
		t.mock.timers.tick(1000);
		await drainMicrotasks();
		assert.deepEqual(
			await second,
			{ block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) },
			"the second child expires in the wait",
		);
		assert.equal(s.prompter.titles.length, 1, "an expired child mounts no panel");
		assert.equal(childAskQueue()?.waiting(ROOT), 1, "only the third child still waits");

		// The third child is still live when the root answers and frees the slot.
		s.prompter.release("Allow once");
		await drainMicrotasks();
		await drainMicrotasks();
		assert.equal(await root, undefined, "the owner allowed the root call once");
		assert.equal(s.prompter.titles.length, 2, "the third child mounts on the freed slot");
		assert.match(s.prompter.titles[1], /implementer/, "the third panel is a child prompt");
		assert.match(s.prompter.titles[1], /1 of 1 waiting/, "the two expired requests left the title");
		assert.equal(childAskQueue()?.visible(ROOT), CHILD_C, "the third child is on screen");

		s.prompter.release("Allow once");
		await drainMicrotasks();
		assert.equal(await third, undefined, "the owner answer reaches the third child");
		assert.equal(askPanelSlot.busy, false, "the last panel released the slot");
		assert.equal(childAskQueue()?.rootCount(), 0, "the drained root is dropped");
	},
);

// --- identity guard ----------------------------------------------------------
test(
	"slot: a stale mount keeps the newer state for the same root",
	{ timeout: 2000 },
	async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const panel = deferred<PermissionChoice>();
		let renders = 0;
		const s = setup({
			never: true,
			render: () => {
				renders += 1;
				return panel.promise;
			},
		});
		await captureRoot(s);

		const root = rootAsk(s);
		await drainMicrotasks();

		// The first child parks behind the root panel and expires in the wait.
		const first = childAsk(s, CHILD_A);
		await drainMicrotasks();
		t.mock.timers.tick(CHILD_ASK_DEADLINE_MS);
		await drainMicrotasks();
		assert.deepEqual(
			await first,
			{ block: true, reason: deadlineReason(CHILD_ASK_DEADLINE_MS) },
			"the first child expires in the wait",
		);
		assert.equal(childAskQueue()?.rootCount(), 0, "the expired root state is dropped");

		// A second child builds a new state for the same root and parks too.
		const second = childAsk(s, CHILD_B);
		await drainMicrotasks();
		assert.equal(childAskQueue()?.rootCount(), 1, "the second child builds a new state");

		// The root answers, so the stale first mount resumes. It must not remove
		// the state that the second child now owns.
		s.prompter.release("Deny");
		await drainMicrotasks();
		await drainMicrotasks();
		assert.equal(renders, 1, "only the newer request mounts a panel");
		assert.equal(childAskQueue()?.rootCount(), 1, "the stale mount kept the newer state");
		assert.equal(childAskQueue()?.visible(ROOT), CHILD_B, "the newer request is on screen");

		panel.resolve("allow-once");
		assert.equal(await second, undefined, "the newer request is answered once");
		assert.deepEqual(await root, { block: true, reason: "Denied by user" }, "the root ask denies");
	},
);
