/**
 * Wiring harness for the sidebar glue in `tree-ui.ts`.
 *
 * Runs under plain Node (type stripping) and imports the REAL `tree-ui.ts`.
 * This proves the module loads in strip-only mode and that the `/sidebar width`
 * handler wires the pure planner to the config write, the compositor reinstall,
 * and the render request. `sidebar.test.ts` covers the pure planner alone.
 * The same file also covers the `/agents-tree` overlay runtime path: the mount
 * options, the marked row, the close keys, the selection move, and the widget
 * clear on dispose. The `/ask-log` path adds the page keys and the view cap.
 *
 * Fakes only: no real TTY, no real timers left running, and no write to the
 * real `~/.pi/agent/persona-agents-sidebar.json` (each test uses a temp path).
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/tree-ui.test.ts
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { SIDEBAR_DEFAULT_WIDTH, getSidebarCompositor } from "./sidebar.ts";
import { ASK_FRAME_ROWS, MAX_ASK_VIEW_ROWS, TreeOverlayComponent } from "./overlays.ts";
import { disposeTreeSidebar } from "./tree-ui.ts";
import { ENV_TREE_LOG } from "./depth.ts";
import { appendEvent } from "./tree-log.ts";
import { makeNode, makeSnapshot, theme as fixtureTheme } from "./sidebar-render-fixtures.ts";
import { paintCalls, resetPaints } from "./sidebar-terminal-fixtures.ts";
import {
	RAW_COLUMNS,
	cleanupHarness,
	setup,
	type Harness,
	type OverlayMount,
} from "./tree-ui-fixtures.ts";

/** Section-rule glyph the pure renderer repeats to the panel width. */
const SECTION_RULE_CHAR = "─";
/** Selection marker glyph the tree overlay puts on the selected row. */
const SELECTION_MARKER = "▶";

/** The zero-based row indexes that carry the tree selection marker. */
function markedRows(lines: string[]): number[] {
	return lines.flatMap((line, index) => (line.includes(SELECTION_MARKER) ? [index] : []));
}

/** The spinner icon on the marked tree row. */
function treeRowIcon(lines: string[]): string {
	const row = lines.find((line) => line.trimStart().startsWith(`${SELECTION_MARKER} `));
	assert.ok(row, "a marked row paints");
	const [mark, icon, agent] = row.trimStart().split(/\s+/);
	assert.equal(mark, SELECTION_MARKER, "the row carries the selection marker");
	assert.equal(agent, "implementer", "the marker sits on the seeded node row");
	assert.ok(icon !== undefined && icon.length > 0, `the row carries an icon: ${JSON.stringify(row)}`);
	return icon;
}

afterEach(() => {
	disposeTreeSidebar();
	cleanupHarness();
});

// --- /sidebar width wiring ---------------------------------------------------
test("a valid /sidebar width persists, reinstalls the compositor, and renders", async () => {
	const harness = setup({ enabled: true });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH);
	resetPaints(harness.tui);

	await harness.handler("width 80", harness.ctx);

	const after = getSidebarCompositor();
	assert.ok(after, "a compositor should still be installed");
	assert.notEqual(after, before, "the compositor was not reinstalled");
	assert.equal(after.width, 80, "the reinstalled compositor did not use the new width");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 80 - 1,
		"the terminal was not narrowed to the new width",
	);
	assert.equal(harness.tui.requestRenderCalls, 1, "the handler did not request a render");
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 80,
	});
	assert.ok(
		harness.notifications.some(
			(note) => note.level === "info" && /Sidebar width 80/.test(note.message),
		),
		"the handler did not report the new width",
	);
});

test("a bad /sidebar width notifies and leaves the width and compositor unchanged", async () => {
	const harness = setup({ enabled: true });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	const columnsBefore = harness.terminal.columns;
	resetPaints(harness.tui);

	await harness.handler("width abc", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a bad value");
	assert.equal(before.width, SIDEBAR_DEFAULT_WIDTH, "the width changed on a bad value");
	assert.equal(
		harness.terminal.columns,
		columnsBefore,
		"the terminal was renarrowed on a bad value",
	);
	assert.equal(paintCalls(harness.tui), 0, "a render was requested on a bad value");
	assert.deepEqual(
		JSON.parse(readFileSync(harness.configPath, "utf8")),
		{ enabled: true },
		"the width was persisted on a bad value",
	);
	assert.ok(
		harness.notifications.some(
			(note) => note.level === "warning" && /Invalid width/.test(note.message),
		),
		"the handler did not warn about the bad value",
	);
});

test("a no-op /sidebar width does not reinstall or render", async () => {
	const harness = setup({ enabled: true, width: 80 });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, 80);
	resetPaints(harness.tui);

	await harness.handler("width 80", harness.ctx);

	assert.equal(getSidebarCompositor(), before, "the compositor was reinstalled on a no-op");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 80 - 1,
		"the terminal width changed on a no-op",
	);
	assert.equal(paintCalls(harness.tui), 0, "a render was requested on a no-op");
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 80,
	});
});

test("buildLines and installCompositor use the resolved width, not the default", () => {
	const harness = setup({ enabled: true, width: 80 });
	const compositor = getSidebarCompositor();
	assert.ok(compositor, "a compositor should be installed in TUI mode");
	assert.equal(compositor.width, 80, "installCompositor did not use the resolved width");
	assert.equal(harness.terminal.columns, RAW_COLUMNS - 80 - 1);

	harness.terminal.writes.length = 0;
	compositor.paint();
	const output = harness.terminal.writes.join("");
	assert.ok(
		output.includes(SECTION_RULE_CHAR.repeat(80)),
		"buildLines did not render the panel at the resolved width",
	);
});

test("a toggle adopts a width changed on disk so the live compositor matches disk", async () => {
	const harness = setup({ enabled: true, width: 80 });
	const before = getSidebarCompositor();
	assert.ok(before, "a compositor should be installed in TUI mode");
	assert.equal(before.width, 80);
	assert.equal(harness.terminal.columns, RAW_COLUMNS - 80 - 1);

	// Another window edits the config on disk while this session runs.
	writeFileSync(harness.configPath, JSON.stringify({ enabled: true, width: 30 }));

	// The toggle branch must read the fresh on-disk width, not the bind-time cache.
	await harness.handler("off", harness.ctx);
	await harness.handler("on", harness.ctx);

	const after = getSidebarCompositor();
	assert.ok(after, "a compositor should be installed again after /sidebar on");
	assert.equal(after.width, 30, "the live compositor kept the bind-time cached width");
	assert.equal(
		harness.terminal.columns,
		RAW_COLUMNS - 30 - 1,
		"the terminal was not narrowed to the on-disk width",
	);
	// Disk truth and live truth must agree.
	assert.deepEqual(JSON.parse(readFileSync(harness.configPath, "utf8")), {
		enabled: true,
		width: 30,
	});
});

// --- /agent-inspect overlay contract ----------------------------------------

test("the agent detail overlay carries invalidate and re-renders after it", async () => {
	const harness = setup({ enabled: true, log: true });
	await harness.inspect("last", harness.ctx);

	const mounted = harness.overlay.component;
	assert.ok(mounted, "the /agent-inspect command mounts a component");
	mounted.invalidate();
	const lines = mounted.render(80);
	assert.match(lines[0], /AGENT implementer/, lines[0]);
});

// --- /agents-tree overlay runtime path --------------------------------------

describe("tree overlay runtime path", () => {
	test("a /agents-tree run mounts one full-screen centered overlay", async () => {
		const harness = setup({ enabled: true, log: true });

		await harness.tree("", harness.ctx);

		assert.equal(harness.overlay.calls.length, 1, "the command mounts exactly one overlay");
		const call = harness.overlay.calls[0];
		assert.equal(call.options?.overlay, true, "the tree panel mounts as an overlay");
		const options = call.options?.overlayOptions;
		assert.ok(options, "the overlay carries overlayOptions");
		assert.equal(options.width, "100%", "the overlay width is 100 percent");
		assert.equal(options.maxHeight, "100%", "the overlay maxHeight is 100 percent");
		assert.equal(options.anchor, "center", "the overlay anchors at the center");
		assert.equal(options.margin?.top, 0, "the overlay margin top is 0");
		assert.ok(call.component, "the factory returns a component");
	});

	test("the mounted component renders a selected row at width 80 and width 40", async () => {
		const harness = setup({ enabled: true, log: true });
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		assert.ok(component, "the overlay mounted a component");

		for (const width of [80, 40]) {
			const lines = component.render(width);
			assert.ok(lines.length > 0, `the overlay rendered no lines at width ${width}`);
			const marked = markedRows(lines);
			assert.equal(marked.length, 1, `one row carries the marker at width ${width}`);
			assert.match(lines[marked[0]], /implementer/, "the marker sits on the seeded node row");
		}
	});

	test("the running-node icon follows the frame getter, not a frame captured at construction", () => {
		const harness = setup({ enabled: true });
		const snapshot = makeSnapshot({
			tree: [makeNode({ runId: "run-test-1", agent: "implementer", status: "running", task: "build it" })],
		});
		// A mutable counter stands in for the spinner frame; a captured value cannot move.
		let frames = 0;
		const component = new TreeOverlayComponent(
			harness.tui as unknown as TUI,
			fixtureTheme,
			() => snapshot,
			() => {},
			() => frames,
		);

		const first = treeRowIcon(component.render(80));
		frames = 1;
		const second = treeRowIcon(component.render(80));

		assert.notEqual(
			second,
			first,
			"the second render kept the first icon, so the frame was captured at construction",
		);
	});

	test("Esc, q, and Q each close the overlay once", async () => {
		const harness = setup({ enabled: true, log: true });
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		const mount = harness.overlay.calls[0];
		assert.ok(component && mount, "the overlay mounted");
		const handleInput = component.handleInput?.bind(component);
		assert.ok(handleInput, "the mounted component accepts input");

		for (const key of ["\x1b", "q", "Q"]) {
			const before = mount.doneValues.length;
			handleInput(key);
			assert.equal(
				mount.doneValues.length,
				before + 1,
				`key ${JSON.stringify(key)} closed the overlay exactly once`,
			);
		}
		assert.deepEqual(
			mount.doneValues,
			[undefined, undefined, undefined],
			"each close passes no value",
		);
	});

	test("Down then Up moves the selection and each call re-renders", async () => {
		const harness = setup({ enabled: true, log: true });
		const logPath = process.env[ENV_TREE_LOG];
		assert.ok(logPath, "the harness set a tree log");
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: "run-test-2",
			parentRunId: null,
			depth: 0,
			agent: "reviewer",
			persona: null,
			status: "running",
			at: new Date().toISOString(),
			task: "check it",
		});
		appendEvent(logPath, {
			v: 1,
			type: "start",
			runId: "run-test-3",
			parentRunId: null,
			depth: 0,
			agent: "tester",
			persona: null,
			status: "running",
			at: new Date().toISOString(),
			task: "test it",
		});
		// Re-bind so the snapshot reads all three nodes before the overlay mounts.
		disposeTreeSidebar();
		await harness.tree("", harness.ctx);
		const component = harness.overlay.component;
		assert.ok(component, "the overlay mounted a component");
		const handleInput = component.handleInput?.bind(component);
		assert.ok(handleInput, "the mounted component accepts input");

		const initialLines = component.render(80);
		const before = markedRows(initialLines);
		assert.equal(before.length, 1, "one row carries the marker before a key");
		assert.match(initialLines[before[0]], /implementer/, "the first node is marked before a key");
		resetPaints(harness.tui);

		handleInput("\x1b[B");
		const downLines = component.render(80);
		const afterDown = markedRows(downLines);
		assert.equal(harness.tui.requestRenderCalls, 1, "Down requested one render");
		assert.equal(afterDown.length, 1, "one row carries the marker after Down");
		assert.equal(afterDown[0], before[0] + 1, "Down moved the marker exactly one row down");
		assert.match(downLines[afterDown[0]], /reviewer/, "the second node is marked after Down");

		handleInput("\x1b[A");
		const upLines = component.render(80);
		const afterUp = markedRows(upLines);
		assert.equal(harness.tui.requestRenderCalls, 2, "Up requested one render");
		assert.deepEqual(afterUp, before, "Up moved the marker back to the first row");
		assert.match(upLines[afterUp[0]], /implementer/, "the first node is marked after Up");
	});

	test("disposeTreeSidebar clears the tree widget with an undefined value", () => {
		const harness = setup({ enabled: true, log: true });
		const key = "persona-agents-tree";
		const bound = harness.widgets.filter((call) => call.key === key);
		assert.ok(bound.length > 0, "binding sets the tree widget");
		assert.notEqual(bound.at(-1)?.content, undefined, "binding sets a live widget first");

		disposeTreeSidebar();

		const last = harness.widgets.at(-1);
		assert.ok(last, "dispose writes a widget call");
		assert.equal(last.key, key, "dispose writes the tree widget key");
		assert.equal(last.content, undefined, "dispose clears the widget with an undefined value");
	});
});

// --- /ask-log overlay runtime path ------------------------------------------

/** Mount `/ask-log` and hand back the component and its close values. */
async function mountAskLog(
	harness: Harness,
): Promise<{ component: Component; mount: OverlayMount; handleInput: (key: string) => void }> {
	await harness.askLog("", harness.ctx);
	const mount = harness.overlay.calls.at(-1);
	assert.ok(mount?.component, "the /ask-log command mounts a component");
	const handleInput = mount.component.handleInput?.bind(mount.component);
	assert.ok(handleInput, "the mounted component accepts input");
	return { component: mount.component, mount, handleInput };
}

/** The nav line of one frame, with the right padding trimmed. */
function askNav(lines: string[]): string {
	return (lines.at(-1) ?? "").trimEnd();
}

describe("ask log overlay runtime path", () => {
	test("a /ask-log run mounts one full-screen centered overlay", async () => {
		const harness = setup({ enabled: true, log: true, asks: 2 });

		await harness.askLog("", harness.ctx);

		assert.equal(harness.overlay.calls.length, 1, "the command mounts exactly one overlay");
		const call = harness.overlay.calls[0];
		assert.equal(call.options?.overlay, true, "the ask log mounts as an overlay");
		const options = call.options?.overlayOptions;
		assert.ok(options, "the overlay carries overlayOptions");
		assert.equal(options.width, "100%", "the overlay width is 100 percent");
		assert.equal(options.maxHeight, "100%", "the overlay maxHeight is 100 percent");
		assert.equal(options.anchor, "center", "the overlay anchors at the center");
		assert.equal(options.margin?.top, 0, "the overlay margin top is 0");
		assert.ok(call.component, "the factory returns a component");
	});

	test("the frame paints the ring newest first with a header and a nav line", async () => {
		const harness = setup({ enabled: true, log: true, asks: 2 });
		const { component } = await mountAskLog(harness);

		const lines = component.render(80);

		assert.equal(lines[0].trimEnd(), "  ASK LOG — 2 events · newest first", "the header carries the ring count on the row indent");
		assert.match(lines[2], /10:00:02 implementer\/bash/, "the newest row paints first");
		assert.match(lines[3], /10:00:01 implementer\/bash/, "the older row paints second");
		assert.match(askNav(lines), /^\(line 1\/2\) ·/, "the nav line starts at the first line");
	});

	test("Down moves one wrapped line, so a wrapped row takes two presses", async () => {
		const harness = setup({ enabled: true, log: true, asks: 5 });
		// Five view rows, so ten wrapped body lines leave room to scroll.
		harness.terminal.rows = 10;
		const { component, handleInput } = await mountAskLog(harness);
		const newest = wrapTextWithAnsi("10:00:05 implementer/bash waiting=0 shown=none place=slot", 38);
		const next = wrapTextWithAnsi("10:00:04 implementer/bash waiting=0 shown=none place=slot", 38);
		assert.equal(newest.length, 2, "the newest row wraps to two lines at width 40");
		assert.equal(next.length, 2, "the second row wraps to two lines at width 40");

		const first = component.render(40);
		assert.equal(first[2].trimEnd(), `  ${newest[0]}`, "the first body line starts the newest row");
		resetPaints(harness.tui);

		handleInput("\x1b[B");
		const second = component.render(40);
		assert.equal(harness.tui.requestRenderCalls, 1, "Down requested one render");
		assert.equal(
			second[2].trimEnd(),
			`  ${newest[1]}`,
			"the first press landed on the second wrapped line of the same row",
		);

		handleInput("\x1b[B");
		const third = component.render(40);
		assert.equal(harness.tui.requestRenderCalls, 2, "the second Down requested one render");
		assert.equal(
			third[2].trimEnd(),
			`  ${next[0]}`,
			"the second press reached the next row, so each press is one wrapped line",
		);
	});

	test("G paints the last wrapped line and g paints the first", async () => {
		const harness = setup({ enabled: true, log: true, asks: 8 });
		// Five view rows against eight body rows, so three rows of travel remain.
		harness.terminal.rows = 10;
		const { component, handleInput } = await mountAskLog(harness);

		const top = component.render(100);
		assert.match(askNav(top), /^\(line 1\/8\) ·/, "the frame opens on the first line");

		handleInput("G");
		const end = component.render(100);
		assert.match(askNav(end), /^\(line 4\/8\) ·/, "G stops at the last full page");
		assert.match(
			end.at(-3) ?? "",
			/10:00:01 implementer\/bash/,
			"the last wrapped line, the oldest row, is in view at G",
		);

		handleInput("g");
		const back = component.render(100);
		assert.match(askNav(back), /^\(line 1\/8\) ·/, "g returns to the first line");
		assert.match(back[2], /10:00:08 implementer\/bash/, "the newest row leads again at g");
	});

	test("PgDn twice stops at the last full page and PgUp at the top stays on line 1", async () => {
		const harness = setup({ enabled: true, log: true, asks: 8 });
		// Five view rows against eight body rows, so three rows of travel remain.
		harness.terminal.rows = 10;
		const { component, handleInput } = await mountAskLog(harness);

		const top = component.render(100);
		assert.match(askNav(top), /^\(line 1\/8\) ·/, "the frame opens on the first line");

		handleInput("\x1b[5~");
		const atTop = component.render(100);
		assert.match(askNav(atTop), /^\(line 1\/8\) ·/, "PgUp at the first page keeps line 1");
		assert.equal(atTop[2], top[2], "PgUp at the first page did not move the first body line");

		// The page step is fifteen, past the three rows of travel, so it clamps.
		handleInput("\x1b[6~");
		const once = component.render(100);
		assert.match(askNav(once), /^\(line 4\/8\) ·/, "one PgDn stops at the last full page");

		handleInput("\x1b[6~");
		const twice = component.render(100);
		assert.match(askNav(twice), /^\(line 4\/8\) ·/, "a second PgDn stays at the last full page");
		assert.deepEqual(twice, once, "a second PgDn did not scroll past the last page");
	});

	test("a terminal above the view cap still paints a frame of the cap height", async () => {
		const harness = setup({ enabled: true, log: true, asks: 50 });
		// Two hundred rows is twice the cap, so only the cap can bound the frame.
		harness.terminal.rows = 200;
		const { component } = await mountAskLog(harness);

		// A narrow width wraps each row, so the body is taller than the cap.
		const lines = component.render(20);
		const bodyRows = lines.length - 4;
		const nav = lines.at(-1) ?? "";
		const counter = /^\(line 1\/(\d+)\)/.exec(nav);
		assert.ok(counter, `the nav line leads with the page counter: ${JSON.stringify(nav)}`);
		assert.ok(Number(counter[1]) > MAX_ASK_VIEW_ROWS, "the wrapped body is taller than the view cap");
		assert.equal(bodyRows, MAX_ASK_VIEW_ROWS - ASK_FRAME_ROWS, "the view height stops at the cap minus the frame rows");
	});

	test("a 24-row terminal paints a 23-line frame from the fixed height budget", async () => {
		const harness = setup({ enabled: true, log: true, asks: 30 });
		// A fixed height of 24 rows leaves 24 - 5 = 19 rows for the body.
		harness.terminal.rows = 24;
		const { component } = await mountAskLog(harness);

		const lines = component.render(100);

		// 19 body rows plus 4 chrome lines (header, two rules, nav) is 23 lines.
		assert.equal(lines.length, 23, "a 24-row terminal paints 19 view rows and 4 chrome lines");
		assert.match(askNav(lines), /^\(line 1\/30\) ·/, "the ring is taller than the view, so the top page paints");
	});

	test("q, Q, and Esc each close the overlay once", async () => {
		const harness = setup({ enabled: true, log: true, asks: 1 });
		const { mount, handleInput } = await mountAskLog(harness);

		for (const key of ["\x1b", "q", "Q"]) {
			const before = mount.doneValues.length;
			handleInput(key);
			assert.equal(
				mount.doneValues.length,
				before + 1,
				`key ${JSON.stringify(key)} closed the overlay exactly once`,
			);
		}
		assert.deepEqual(mount.doneValues, [undefined, undefined, undefined], "each close passes no value");
	});

	test("a normal key while the overlay is open is ignored", async () => {
		const harness = setup({ enabled: true, log: true, asks: 3 });
		const { component, mount, handleInput } = await mountAskLog(harness);
		const before = component.render(80);
		resetPaints(harness.tui);

		for (const key of ["x", "j", "k", " ", "1", "/"]) handleInput(key);

		assert.equal(mount.doneValues.length, 0, "no ignored key closed the overlay");
		assert.equal(harness.tui.requestRenderCalls, 0, "an ignored key requested no render");
		assert.deepEqual(component.render(80), before, "the frame did not move");
	});

	test("an empty ring paints the placeholder, the nav line, and one rule on each side", async () => {
		const harness = setup({ enabled: true });
		const { component } = await mountAskLog(harness);

		const lines = component.render(100);

		assert.ok(
			lines.some((line) => line.trimEnd() === "  (no child asks)"),
			"the empty ring paints the placeholder on the row indent",
		);
		assert.match(askNav(lines), /^\(line 1\/1\) ·/, "the nav line still paints");
		assert.equal(
			lines.filter((line) => line.trimEnd() === "─".repeat(96)).length,
			2,
			"one rule sits on each side of the placeholder",
		);
	});

	test("at width 20 every line fits and each token stays whole", async () => {
		const harness = setup({ enabled: true, log: true, asks: 2 });
		const { component } = await mountAskLog(harness);

		const lines = component.render(20);

		assert.ok(lines.length > 0, "the overlay rendered lines at width 20");
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 20, `line exceeds 20 cells: ${JSON.stringify(line)}`);
		}
		const joined = lines.join("\n");
		for (const token of ["10:00:02", "implementer/bash", "waiting=0", "place=slot"]) {
			assert.ok(joined.includes(token), `the wrap split the token ${token}`);
		}
	});

	test("in RPC mode the command notifies and mounts nothing", async () => {
		const harness = setup({ enabled: true, log: true, asks: 1 });
		const mounts = harness.overlay.calls.length;
		const rpcCtx = { ...harness.ctx, mode: "rpc" } as unknown as ExtensionContext;

		await harness.askLog("", rpcCtx);

		assert.equal(harness.overlay.calls.length, mounts, "no overlay mounted in RPC mode");
		assert.ok(
			harness.notifications.some(
				(note) => note.level === "error" && /requires interactive mode/.test(note.message),
			),
			"the command notified that the overlay needs interactive mode",
		);
	});
});
