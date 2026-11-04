/**
 * Tests for the forced paint that `renderPermissionPrompt` runs after the TUI
 * overlay mounts.
 *
 * Cohesion: one subject, the forced paint. The host renders the mount with its
 * cached frame, so the panel is not drawn until a forced render resets that
 * frame. These tests prove the paint happens once, only after the factory
 * returns, never after the prompt settles, and that a failed paint cannot fail
 * the ask. The model and render behaviour live in `permission-prompt.test.ts`.
 *
 * Runs under plain Node (type stripping):
 *   npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildPromptModel, renderPermissionPrompt } from "./permission-prompt.ts";

/** A theme that keeps the text plain. These tests never render a frame. */
const stubTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
} as unknown as Theme;

/** One recorded paint. `afterFactory` proves the factory was never the painter. */
interface Paint {
	force: boolean;
	afterFactory: boolean;
}

interface FakePanel {
	render(width: number): string[];
	handleInput(data: string): void;
}

/** A fake host, its recorded paints, and the mounted panel. */
interface FakeHost {
	ctx: Parameters<typeof renderPermissionPrompt>[0];
	/** Resolves after the host pushes the overlay and fires `onHandle`. */
	mounted: Promise<void>;
	paints: Paint[];
	panel(): FakePanel | undefined;
}

/** Wait a real window, so a late paint would have time to fire. */
function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a ctx that mounts the real panel on a fake TUI. The fake host mirrors
 * the real one: the factory runs, then the overlay is pushed on a microtask,
 * then `onHandle` fires. A closed prompt skips the push and `onHandle` both.
 */
function fakePromptCtx(renderNow?: (force?: boolean) => void): FakeHost {
	const paints: Paint[] = [];
	let factoryReturned = false;
	let panel: FakePanel | undefined;
	let ready: () => void = () => {};
	const mounted = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const host = {
		renderNow(force?: boolean): void {
			if (renderNow) renderNow(force);
			paints.push({ force: force === true, afterFactory: factoryReturned });
		},
		requestRender(): void {},
	};
	const ctx = {
		mode: "tui",
		ui: {
			custom<T>(
				factory: (
					tui: unknown,
					theme: Theme,
					keybindings: unknown,
					done: (choice: T) => void,
				) => unknown,
				options?: { onHandle?: (handle: unknown) => void },
			): Promise<T> {
				return new Promise<T>((resolve) => {
					let closed = false;
					const close = (choice: T): void => {
						if (closed) return;
						closed = true;
						resolve(choice);
					};
					Promise.resolve(factory(host, stubTheme, {}, close)).then((component) => {
						factoryReturned = true;
						if (closed) {
							ready();
							return;
						}
						panel = component as FakePanel;
						options?.onHandle?.(undefined);
						ready();
					});
				});
			},
		},
	} as unknown as Parameters<typeof renderPermissionPrompt>[0];
	return { ctx, mounted, paints, panel: () => panel };
}

/** Collect the `console.warn` lines a run logs, then restore the console. */
async function collectWarnings<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		lines.push(args.map(String).join(" "));
	};
	try {
		const result = await run();
		return { result, lines };
	} finally {
		console.warn = original;
	}
}

/** One shell model: a commit segment inside a command. */
function shellModel() {
	const probe = 'git status && git commit -m "fix"';
	const segment = 'git commit -m "fix"';
	return buildPromptModel({
		toolName: "bash",
		probe,
		segment,
		segmentStart: probe.indexOf(segment),
		reason: "commit requires approval",
		isSpanning: false,
	});
}

test("the TUI prompt forces one paint, and only after the factory returns", { timeout: 4000 }, async () => {
	const host = fakePromptCtx();
	const answered = renderPermissionPrompt(host.ctx, shellModel());
	await host.mounted;
	assert.equal(host.paints.length, 1, "the mount fires the paint once");
	assert.equal(host.paints[0].force, true, "the paint is a forced paint");
	assert.equal(host.paints[0].afterFactory, true, "the paint runs outside the factory");

	// A later window proves the paint is not repeated on a second tick.
	await wait(50);
	assert.equal(host.paints.length, 1, "the paint runs once only");

	const panel = host.panel();
	assert.ok(panel, "the TUI prompt must build the panel component");
	panel.handleInput("\r"); // Enter selects Allow once
	assert.equal(await answered, "allow-once");
});

test("a failed paint warns once and cannot fail the ask", { timeout: 4000 }, async () => {
	let attempts = 0;
	const { lines } = await collectWarnings(async () => {
		const host = fakePromptCtx(() => {
			attempts += 1;
			throw new Error("the host refused the paint");
		});
		const answered = renderPermissionPrompt(host.ctx, shellModel());
		await host.mounted;
		const panel = host.panel();
		assert.ok(panel, "the TUI prompt must build the panel component");
		panel.handleInput("\r");
		assert.equal(await answered, "allow-once", "a paint error must not escape the ask");
		return host;
	});
	assert.equal(attempts, 1, "the failing paint ran once");
	assert.equal(lines.length, 1, "a failed paint logs one warning line");
	assert.match(lines[0], /^agent-stack: forced paint failed: the host refused the paint$/);
});

test("a prompt that settles without a paint never paints afterwards", { timeout: 4000 }, async () => {
	// An abort before the mount closes the panel, so the host never fires the hook.
	const abortedHost = fakePromptCtx();
	const preAborted = new AbortController();
	preAborted.abort();
	assert.equal(
		await renderPermissionPrompt(abortedHost.ctx, shellModel(), preAborted.signal),
		"deny",
		"an aborted ask denies",
	);
	await abortedHost.mounted;
	await wait(50);
	assert.equal(abortedHost.paints.length, 0, "an aborted ask paints nothing");

	// An abort after the mount ends the ask; no later paint may follow.
	const lateHost = fakePromptCtx();
	const late = new AbortController();
	const lateAnswer = renderPermissionPrompt(lateHost.ctx, shellModel(), late.signal);
	await lateHost.mounted;
	assert.equal(lateHost.paints.length, 1, "the mounted prompt painted once");
	late.abort();
	assert.equal(await lateAnswer, "deny", "an abort after the mount denies");
	await wait(50);
	assert.equal(lateHost.paints.length, 1, "nothing paints after the abort");
});
