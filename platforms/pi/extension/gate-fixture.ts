/**
 * Shared fixture for the gate tests: the repository root, one root session, the
 * child sessions, a fake root prompt, and the contexts the gate reads.
 *
 * The live global overlay is replaced by an isolated empty file, so a rule on
 * this machine cannot add a verdict to a case.
 *
 * No pi runtime import: a test supplies the fake context.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RunRegistry, newRunRecord } from "./run-registry.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// An isolated empty overlay, so the live global file cannot add a verdict.
const isolatedGlobalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-fixture-")), "permissions.json");
fs.writeFileSync(isolatedGlobalFile, JSON.stringify({ deny: [], ask: [] }));
process.env.PI_PERMISSIONS_FILE = isolatedGlobalFile;

export const ROOT = "root-session";
export const CHILD_A = "child-a";
/** A child record that declares depth 0, so only the walk shows it is a child. */
export const CHILD_D0 = "child-d0";
/** A child record whose parent id no record holds. */
export const CHILD_E = "child-e";
/** The parent id `CHILD_E` names, which the registry never holds. */
export const MISSING_PARENT = "gone-parent";
/** The three choices every prompt shows, in order. Owned by the prompt model. */
export { PROMPT_OPTION_LABELS } from "./permission-prompt.ts";

export type ToolCallContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	sessionManager: { getSessionId(): string };
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
};

/** Records every root prompt and answers from one list, one answer per call. */
export class RootPrompter {
	readonly titles: string[] = [];
	readonly options: string[][] = [];
	answers: Array<string | undefined> = [];
	/** Prompt calls made on a child context. A child must never be asked. */
	childUiCalls = 0;
	private next = 0;

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.titles.push(title);
		this.options.push(options);
		await new Promise<void>((resolve) => setTimeout(resolve, 4));
		const answer = this.answers[Math.min(this.next, this.answers.length - 1)];
		this.next += 1;
		return answer;
	}
}

/** One root record and the child records, so a walk can place each one. */
export function registryOf(): RunRegistry {
	const registry = new RunRegistry();
	const rows: Array<[string, string, number, string | null]> = [
		[ROOT, "orchestrator", 0, null],
		[CHILD_A, "implementer", 1, ROOT],
		// Its role matches the root, so only the session id separates the grants.
		[CHILD_D0, "orchestrator", 0, ROOT],
		[CHILD_E, "implementer", 1, MISSING_PARENT],
	];
	for (const [sessionId, role, depth, parentSessionId] of rows) {
		registry.register(
			newRunRecord({
				sessionId,
				role,
				class: depth === 0 ? "orchestrator" : "worker",
				source: "package",
				skills: [],
				alwaysLoad: [],
				depth,
				parentSessionId,
				sessionFile: null,
				startedAt: 0,
			}),
		);
	}
	return registry;
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
