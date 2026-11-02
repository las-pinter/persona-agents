/**
 * Shared fixture for the child ask tests: the real gate, a registry table, a
 * fake root prompt, and the root and child contexts.
 *
 * `CHILD_C` shares `CHILD_A`'s role, so a case can separate the session id
 * from the role. `CHILD_D` declares depth 0 while its parent link is real.
 * `CHILD_G` sits two hops down. `CHILD_E` names a parent that was never
 * registered, so its walk stops short.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindChildAskRegistry, type ChildAskDeps } from "./child-ask.ts";
import { installToolCallGate } from "./permissions.ts";
import type { AgentConfig, PermissionRule } from "./resolver.ts";
import { RunRegistry, newRunRecord } from "./run-registry.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// An isolated empty overlay, so the live global file cannot add a verdict.
const isolatedGlobalFile = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), "gate-child-ask-")),
	"permissions.json",
);
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

export const ROOT = "root-session";
export const CHILD_A = "child-a";
export const CHILD_B = "child-b";
export const CHILD_C = "child-c";
export const CHILD_D = "child-d";
export const CHILD_G = "grandchild";
export const CHILD_E = "child-e";
/** The parent id that no record holds. */
export const MISSING_PARENT = "gone-parent";
export const THREE_LABELS = ["Allow once", "Always allow this rule (session)", "Deny"];

export type ToolCallContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	sessionManager: { getSessionId(): string };
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
};
export type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: ToolCallContext,
) => Promise<unknown>;

/** Records every root prompt and answers from one list, one answer per call. */
export class RootPrompter {
	readonly titles: string[] = [];
	readonly options: string[][] = [];
	answers: Array<string | undefined> = [];
	maxActive = 0;
	childUiCalls = 0;
	never = false;
	private active = 0;
	private next = 0;

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.titles.push(title);
		this.options.push(options);
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		// A held prompt models an owner who never answers.
		if (this.never) return new Promise<string | undefined>(() => {});
		await new Promise<void>((resolve) => setTimeout(resolve, 4));
		this.active -= 1;
		const answer = this.answers[Math.min(this.next, this.answers.length - 1)];
		this.next += 1;
		return answer;
	}
}

/** A promise plus the one function that settles it. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** The ask result, or `"stalled"` when it does not settle in time. */
export async function settleOrStall<T>(promise: Promise<T>, ms: number): Promise<T | "stalled"> {
	const stall = new Promise<"stalled">((resolve) => {
		const timer = setTimeout(() => resolve("stalled"), ms);
		timer.unref();
	});
	return Promise.race([promise, stall]);
}

/** The fixture tree: one root, five children, and one grandchild. */
export function registryOf(): RunRegistry {
	const registry = new RunRegistry();
	const rows: Array<[string, string, number, string | null]> = [
		[ROOT, "orchestrator", 0, null],
		[CHILD_A, "implementer", 1, ROOT],
		[CHILD_B, "tester", 1, ROOT],
		[CHILD_C, "implementer", 1, ROOT],
		// A wrong declared depth: only the parent walk can place this record.
		[CHILD_D, "implementer", 0, ROOT],
		[CHILD_G, "reviewer", 2, CHILD_A],
		[CHILD_E, "implementer", 1, MISSING_PARENT],
	];
	for (const [sessionId, role, depth, parentSessionId] of rows) {
		registry.register(
			newRunRecord({
				sessionId,
				role,
				class: sessionId === ROOT ? "orchestrator" : "worker",
				depth,
				parentSessionId,
				sessionFile: null,
				startedAt: 0,
			}),
		);
	}
	return registry;
}

/** Install the real gate over one fixture table: push asks, status allows. */
export function installGate(): ToolCallHandler {
	let captured: ToolCallHandler | null = null;
	const pi = {
		on(name: string, handler: ToolCallHandler): void {
			if (name === "tool_call") captured = handler;
		},
	};
	const agent: AgentConfig = {
		name: "orchestrator",
		description: "child ask fixture",
		systemPrompt: "",
		source: "package",
		filePath: "",
	};
	const ask: PermissionRule[] = [{ tool: "bash", match: "^git\\s+push\\b", reason: "publishing" }];
	const allow: PermissionRule[] = [{ tool: "bash", match: "^git\\s+status\\b" }];
	// SAFETY: the gate reads only `on` from the pi object, and this fake has it.
	installToolCallGate(pi as unknown as ExtensionAPI, () => agent, () => ({
		ruleSets: { globalDeny: [], agentDeny: [], globalAsk: [], agentAsk: ask, agentAllow: allow },
		mode: "deny-by-default",
	}));
	assert.ok(captured, "the gate must register a tool_call handler");
	return captured;
}

/** The root context. `hasUI` false models a root with no prompt surface. */
export function rootContext(prompter: RootPrompter, hasUI = true): ToolCallContext {
	return {
		cwd: repoRoot,
		hasUI,
		mode: "rpc",
		sessionManager: { getSessionId: () => ROOT },
		ui: { select: (title, options) => prompter.select(title, options) },
	};
}

/** A child context reports no UI, as a real child does. */
export function childContext(sessionId: string, prompter: RootPrompter): ToolCallContext {
	return {
		cwd: repoRoot,
		hasUI: false,
		mode: "rpc",
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			async select(): Promise<string | undefined> {
				prompter.childUiCalls += 1;
				return undefined;
			},
		},
	};
}

export interface SetupOptions {
	answers?: Array<string | undefined>;
	never?: boolean;
	timeoutMs?: number;
	render?: ChildAskDeps["render"];
}
export interface Setup {
	handler: ToolCallHandler;
	prompter: RootPrompter;
	root: ToolCallContext;
	/** The same root surface, marked headless. */
	headless: ToolCallContext;
}

export function setup(options: SetupOptions = {}): Setup {
	const prompter = new RootPrompter();
	prompter.answers = options.answers ?? [];
	prompter.never = options.never ?? false;
	const timeout = options.timeoutMs;
	bindChildAskRegistry(registryOf(), {
		...(timeout === undefined ? {} : { timeoutMs: timeout }),
		...(options.render ? { render: options.render } : {}),
	});
	return {
		handler: installGate(),
		prompter,
		root: rootContext(prompter),
		headless: rootContext(prompter, false),
	};
}

/** One allowed root call, so the gate captures the root prompt surface. */
export async function captureRoot(s: Setup, ctx: ToolCallContext = s.root): Promise<void> {
	const result = await s.handler({ toolName: "bash", input: { command: "git status" } }, ctx);
	assert.equal(result, undefined, "the root setup call must run");
}

export function childAsk(s: Setup, sessionId: string): Promise<unknown> {
	const ctx = childContext(sessionId, s.prompter);
	return s.handler({ toolName: "bash", input: { command: "git push" } }, ctx);
}

export function rootAsk(s: Setup): Promise<unknown> {
	return s.handler({ toolName: "bash", input: { command: "git push" } }, s.root);
}
