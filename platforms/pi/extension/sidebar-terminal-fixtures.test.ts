/**
 * Self-test for the sidebar terminal fakes in `sidebar-terminal-fixtures.ts`.
 *
 * The two paint counters must stay separate, and both paint entry points must
 * stay own properties of the returned object, because the sidebar disposer
 * restores the original through an own property descriptor and then deletes
 * the wrapper. A merged counter or a prototype method leaves the sidebar suite
 * green while the fake stops matching pi.
 *
 *   npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	makeTerminal,
	makeTui,
	paintCalls,
	resetPaints,
} from "./sidebar-terminal-fixtures.ts";

describe("sidebar terminal fixtures", () => {
	test("a fresh tui starts with both paint counters at zero", () => {
		const tui = makeTui(makeTerminal());
		assert.equal(tui.requestRenderCalls, 0, "a fresh tui starts with no requested render");
		assert.equal(tui.doRenderCalls, 0, "a fresh tui starts with no direct render");
	});

	test("one requestRender bumps only the request counter", () => {
		const tui = makeTui(makeTerminal());
		tui.requestRender();
		assert.equal(tui.requestRenderCalls, 1, "requestRender did not bump its own counter");
		assert.equal(tui.doRenderCalls, 0, "requestRender bumped the direct render counter");
	});

	test("one doRender runs the wrapped render body once and bumps only the direct counter", () => {
		let renders = 0;
		const tui = makeTui(makeTerminal(), () => {
			renders += 1;
		});
		tui.doRender();
		assert.equal(renders, 1, "doRender did not run the wrapped render body once");
		assert.equal(tui.doRenderCalls, 1, "doRender did not bump its own counter");
		assert.equal(tui.requestRenderCalls, 0, "the paint counters are not independent");
	});

	test("paintCalls sums both counters and resetPaints zeroes both", () => {
		const tui = makeTui(makeTerminal());
		tui.requestRender();
		tui.doRender();
		tui.doRender();
		assert.equal(tui.requestRenderCalls, 1);
		assert.equal(tui.doRenderCalls, 2);
		assert.equal(paintCalls(tui), 3, "paintCalls did not sum both paint paths");

		resetPaints(tui);
		assert.equal(tui.doRenderCalls, 0, "resetPaints did not zero the direct counter");
		assert.equal(tui.requestRenderCalls, 0, "resetPaints did not zero the request counter");
	});

	test("both paint entry points are own properties of the returned object", () => {
		const tui = makeTui(makeTerminal());
		assert.equal(Object.hasOwn(tui, "doRender"), true, "doRender is not an own property");
		assert.equal(
			Object.hasOwn(tui, "requestRender"),
			true,
			"requestRender is not an own property",
		);
	});
});
