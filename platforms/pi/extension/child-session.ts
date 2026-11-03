/**
 * In-process child session builder.
 *
 * A child loads no extension, so it builds no gate of its own. Each child tool
 * is wrapped to ask the parent gate, and one run registry serves both sessions.
 * The child loader carries no extension set. The build runs under a guard that
 * stops a reloaded extension factory from applying defaults into module state.
 *
 * The builder writes the run record before the build. It records the id as a
 * child id, so the extension factory skips the defaults on the child start. It
 * drops that id and disposes the session when the caller exits. A later parent
 * abort only aborts the child, and the builder forwards the signal.
 *
 * The builder reads the caller depth from the record walk. A caller at the cap
 * gets a refusal, so the build creates no session and no record.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type ResourceLoader,
	type SessionManager,
	type SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type RunExit,
	type RunRecord,
	type RunRegistry,
	type RunStart,
	newRunRecord,
} from "./run-registry.ts";
import { wildcardChildTools, wildcardLoadoutReason } from "./child-tools.ts";
import { DEBUG_AGENT_STACK_PATH } from "./state.ts";
import { DEPTH_CAP_REASON, MAX_AGENT_DEPTH, canSpawn, stripSpawnTool } from "./depth.ts";

/** The reason a build raises when the parent aborted before the child ran. */
export const CHILD_ABORTED_REASON = "Child session aborted: the parent signal fired before the run started";

/** The error name on an abort, so a caller tells an abort from a failed build. */
export const CHILD_ABORTED_ERROR_NAME = "ChildSessionAborted";

/** Build the abort error. The name carries the kind, the message carries the reason. */
export function childAbortedError(): Error {
	const error = new Error(CHILD_ABORTED_REASON);
	error.name = CHILD_ABORTED_ERROR_NAME;
	return error;
}

/** The reason a build raises when the caller sits at the spawn cap. */
export const CHILD_DEPTH_CAP_ERROR_NAME = "ChildSessionDepthCap";

/** Build the cap refusal. The name tells a refusal from a failed build. */
export function childDepthCapError(): Error {
	const error = new Error(DEPTH_CAP_REASON);
	error.name = CHILD_DEPTH_CAP_ERROR_NAME;
	return error;
}

/** The reason a build raises when the loadout names a wildcard. */
export const CHILD_WILDCARD_ERROR_NAME = "ChildSessionWildcardLoadout";

/** Build the wildcard refusal. The name tells a refusal from a failed build. */
export function childWildcardLoadoutError(entries: readonly string[]): Error {
	const error = new Error(wildcardLoadoutReason(entries));
	error.name = CHILD_WILDCARD_ERROR_NAME;
	return error;
}

/** Off unless PI_AGENT_STACK_DEBUG is set. A debug line must never break a build. */
function debugLog(...parts: unknown[]): void {
	if (!process.env["PI_AGENT_STACK_DEBUG"]) return;
	try {
		fs.appendFileSync(DEBUG_AGENT_STACK_PATH, `${new Date().toISOString()} ${parts.join(" ")}\n`);
	} catch {
		// A debug line must never break a build.
	}
}

/**
 * Marks the async branch that builds a child session. A reloaded extension
 * factory reads it and returns, so it cannot re-apply defaults.
 */
const childBuild = new AsyncLocalStorage<boolean>();

/** True inside the build of a child session. */
export function inChildBuild(): boolean {
	return childBuild.getStore() === true;
}

/** Run `build` inside the child guard. The store is bound to that async branch. */
export function withChildBuild<T>(build: () => Promise<T>): Promise<T> {
	// The log names the early return, so a child set with no second gate is visible.
	debugLog("child build: if the factory runs here, it returns early, so this child set builds no gate");
	return childBuild.run(true, build);
}

/**
 * Child session ids born in this process. The extension factory holds no
 * registry handle, so this set is its membership test at `session_start`.
 * A dispose drops the id, so a reused id takes the defaults again.
 */
const childSessionIds = new Set<string>();

/**
 * True when a start must skip the defaults. A known child id is one case. The
 * other is no readable id, because a missing id is not trusted as the root
 * start. A child reads its role from its record, so it must not apply the root
 * defaults.
 */
export function skipsDefaults(sessionId: string | null): boolean {
	return sessionId === null || childSessionIds.has(sessionId);
}

type SessionOptions = CreateAgentSessionOptions;

/** The resolved model object. The build field takes an object, not an id. */
export type ChildModel = NonNullable<SessionOptions["model"]>;
/** One in-process tool the child loadout names. */
export type ChildTool = NonNullable<SessionOptions["customTools"]>[number];
/** The thinking level the caller resolved. pi clamps it to the model. */
export type ChildThinking = SessionOptions["thinkingLevel"];

/**
 * The resolved child loadout. The caller owns resolution; the builder owns the
 * depth strip. The caller checks the tool names; the builder checks the depth
 * and the wildcard.
 */
export interface ChildLoadout {
	/** The frontmatter tool allowlist. The builder removes the spawn tool at the cap. */
	tools: string[];
	/** In-process tools the loadout names, for example `todo`. */
	customTools: ChildTool[];
	/** The resolved model object. */
	model: ChildModel;
	/** The resolved thinking level, when the caller set one. */
	thinkingLevel?: ChildThinking;
}

/** What the child build reads from the parent session. */
export interface ChildParent {
	/** The directory the child runs in. Project discovery and the gate both use it. */
	cwd: string;
	/** The loader the child builds against. It carries no extension set. */
	loader: ResourceLoader;
	/** The parent's settings manager, so both sessions read one settings source. */
	settingsManager: SettingsManager;
	/** The parent abort signal. The builder forwards it to the child. */
	signal?: AbortSignal;
}

/** Everything one build needs. The caller creates or opens the session manager. */
export interface BuildChildInput {
	loadout: ChildLoadout;
	parent: ChildParent;
	/** The record fields. The caller fills the id from the new session manager. */
	start: RunStart;
	sessionManager: SessionManager;
	registry: RunRegistry;
	/** Test seam. Production calls `createAgentSession`. */
	createSession?: typeof createAgentSession;
	/** Defaults to `getAgentDir()`. */
	agentDir?: string;
}

/** The single exit path. A second call does nothing. */
export type ChildDispose = (exit: RunExit) => void;

/** A built child: the live session, its record view, and its exit path. */
export interface BuiltChild {
	session: AgentSession;
	record: Readonly<RunRecord>;
	dispose: ChildDispose;
}

/**
 * Build one child session and register its record.
 *
 * A build that throws leaves no session, so it disposes nothing and marks the
 * record failed. A parent signal that already fired aborts, disposes once, and
 * raises a named abort error, so a dead child never runs and a caller tells an
 * abort from a failed build.
 */
export async function buildChildSession(input: BuildChildInput): Promise<BuiltChild> {
	const { loadout, parent, start, sessionManager, registry } = input;
	const createSession = input.createSession ?? createAgentSession;

	// The caller depth comes from the record walk; the start depth is only a copy.
	const parentId = start.parentSessionId;
	const callerWalk = parentId === null ? null : registry.walk(parentId);
	if (callerWalk?.ok && !canSpawn(callerWalk.depth)) {
		throw childDepthCapError();
	}
	// This falls back to the cap, not the process depth, so a broken chain still strips.
	const callerDepth = callerWalk?.ok ? callerWalk.depth : MAX_AGENT_DEPTH;

	// A direct caller exists, so the wildcard fence sits here too.
	const wildcards = wildcardChildTools(loadout.tools);
	if (wildcards.length > 0) {
		throw childWildcardLoadoutError(wildcards);
	}

	// The nine build fields. The five absent fields stay absent on purpose.
	const options: SessionOptions = {
		cwd: parent.cwd,
		agentDir: input.agentDir ?? getAgentDir(),
		model: loadout.model,
		thinkingLevel: loadout.thinkingLevel,
		tools: stripSpawnTool(loadout.tools, callerDepth),
		customTools: loadout.customTools,
		resourceLoader: parent.loader,
		sessionManager,
		settingsManager: parent.settingsManager,
	};

	// The record must exist before the build, or the gate denies the first call.
	const record = registry.register(newRunRecord(start));
	// The id is a child id until dispose, so the factory skips the defaults on its start.
	childSessionIds.add(start.sessionId);

	let session: AgentSession;
	try {
		const built: CreateAgentSessionResult = await withChildBuild(() => createSession(options));
		session = built.session;
	} catch (error) {
		// A failed build leaves no session, so its id must not stay a child id.
		childSessionIds.delete(start.sessionId);
		registry.finish(start.sessionId, "failed", Date.now());
		throw error;
	}

	let disposed = false;
	let aborted = false;

	const abortChild = (): void => {
		if (disposed || aborted) return;
		aborted = true;
		// Abort is async; a rejection here must not escape the signal listener.
		session.abort().catch(() => {});
	};

	const dispose: ChildDispose = (exit) => {
		if (disposed) return;
		disposed = true;
		parent.signal?.removeEventListener("abort", abortChild);
		try {
			session.dispose();
		} finally {
			// Both marks must land even when the dispose of the child throws.
			childSessionIds.delete(start.sessionId);
			registry.finish(start.sessionId, exit, Date.now());
		}
	};

	const signal = parent.signal;
	if (signal) {
		if (signal.aborted) {
			abortChild();
			dispose("failed");
			throw childAbortedError();
		}
		signal.addEventListener("abort", abortChild, { once: true });
	}

	return { session, record, dispose };
}
