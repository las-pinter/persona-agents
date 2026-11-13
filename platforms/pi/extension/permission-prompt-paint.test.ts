/**
 * Tests for the paint that `renderPermissionPrompt` runs after the TUI overlay
 * mounts.
 *
 * Cohesion: one subject, the mount paint. The host renders the mount with its
 * cached frame, so the panel is not drawn until a render runs. These tests
 * prove the paint happens once, is never forced, only runs after the factory
 * returns, never runs after the prompt settles, and that a failed paint cannot
 * fail the ask. A forced paint clears the screen and the scrollback, so the
 * sidebar row cache strands; these tests fence that flag. The model and render
 * behaviour live in `permission-prompt.test.ts`.
 *
 * Runs under plain Node (type stripping):
 *   npm test
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildPromptModel, renderPermissionPrompt } from "./permission-prompt.ts";
import { readAllEvents } from "./tree-log.ts";
import { ENV_TREE_LOG } from "./depth.ts";

/** A theme that keeps the text plain. These tests never render a frame. */
const stubTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
} as unknown as Theme;

/** One recorded paint. `force` keeps the raw argument the paint passed. */
interface Paint {
	force: boolean | undefined;
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
			paints.push({ force, afterFactory: factoryReturned });
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

/** A log path no other case reads, so one case never sees another's lines. */
let caseCounter = 0;
function caseLogPath(): string {
	caseCounter += 1;
	return path.join(tmpdir(), `paint-log-${process.pid}-${caseCounter}-${Date.now()}.ndjson`);
}

/** Collect the log lines a run writes, then return them. */
async function collectWarnings<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
	const previous = process.env[ENV_TREE_LOG];
	const logPath = caseLogPath();
	process.env[ENV_TREE_LOG] = logPath;
	try {
		const result = await run();
		const lines = readAllEvents(logPath)
			.filter((event) => event.type === "log" && typeof event.text === "string")
			.map((event) => event.text ?? "");
		return { result, lines };
	} finally {
		if (previous === undefined) delete process.env[ENV_TREE_LOG];
		else process.env[ENV_TREE_LOG] = previous;
		fs.rmSync(logPath, { force: true });
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
		source: "global",
		isSpanning: false,
	});
}

test("the TUI prompt paints once, with no force argument, after the factory returns", { timeout: 4000 }, async () => {
	const host = fakePromptCtx();
	const answered = renderPermissionPrompt(host.ctx, shellModel());
	await host.mounted;
	assert.equal(host.paints.length, 1, "the mount fires the paint once");
	assert.equal(host.paints[0].force, undefined, "the paint passes no force argument");
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
