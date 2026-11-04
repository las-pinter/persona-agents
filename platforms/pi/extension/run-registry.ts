/**
 * In-memory run registry: one record per session, keyed by the pi session id.
 *
 * A tool call payload carries no identity. The gate reads its own session id
 * and asks this map for the role and the permission class. The map is module
 * state, so it dies with the process and never reads a file.
 *
 * A record is written before the session is built. A resumed round registers
 * the same id again. An id the map never saw resolves as unknown, so the gate
 * denies it. A silent fall-back would grant a broader class than the one the
 * agent earned.
 *
 * Timestamps are epoch milliseconds. The retention sweep compares them with a
 * clock, and arithmetic on a number needs no parse.
 *
 * No pi import: this module is pure state, so its test needs no runtime.
 */

import { canSpawn } from "./depth.ts";
import type { AgentSource, PermissionClass } from "./resolver.ts";

/** Retention window for a finished run: 14 days in milliseconds. */
export const RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Records one walk may visit. It sits far above the depth cap, so a legal chain
 * ends before it. A corrupt chain fails instead of spinning.
 */
export const MAX_WALK_STEPS = 64;

/** The block reason the gate reports when no record answers for a session id. */
export const UNKNOWN_RUN_REASON = "Blocked: no permission record for this session";

/** The role the gate reports for a session id that has no record. */
export const UNKNOWN_RUN_ROLE = "unknown";

/** Lifecycle state of one run. A run is `running` until its exit path marks it. */
export type RunStatus = "running" | "done" | "failed";

/** The two exit states. Only the runner writes one, after `dispose()`. */
export type RunExit = "done" | "failed";

/** One run. The key is the pi session id. */
export interface RunRecord {
	/** The pi session id from `ctx.sessionManager.getSessionId()`. Identity and key. */
	sessionId: string;
	/** The agent the run serves, for example `implementer`. */
	role: string;
	/** The class the role belongs to. The gate maps one class to one rule set. */
	class: PermissionClass;
	/** The agent file source. Only a package file binds the role's notes zone. */
	source: AgentSource;
	/** The skills the agent may load. The gate derives script dirs from this list. */
	skills: string[];
	/** The always-load patterns. The gate derives script dirs from this list too. */
	alwaysLoad: string[];
	/** Hops from the root session. The parent walk recomputes it; this is a copy. */
	depth: number;
	/** The session that spawned this run, or null for a root. */
	parentSessionId: string | null;
	/** The transcript file of the run, when the run persists one. */
	sessionFile: string | null;
	status: RunStatus;
	/** Assistant turns in this round. A resumed round restarts it at 0. */
	turns: number;
	/** Tool calls this run started. */
	toolCount: number;
	/** Epoch milliseconds at registration, which is the build of the run. */
	startedAt: number;
	/** Epoch milliseconds at the exit mark, or null while the run is open. */
	endedAt: number | null;
}

/** The fields a caller supplies. The counters and the status start fresh. */
export interface RunStart {
	sessionId: string;
	role: string;
	class: PermissionClass;
	source: AgentSource;
	skills: string[];
	alwaysLoad: string[];
	depth: number;
	parentSessionId: string | null;
	sessionFile: string | null;
	startedAt: number;
}

/**
 * What the gate needs from one lookup: a role and a class, never a throw.
 *
 * The unknown branch carries no class. A lookup that found no record cannot
 * hand back a class that a reader takes for an earned one.
 */
export type RunResolution =
	| { known: true; role: string; class: PermissionClass }
	| { known: false };

/** Why a parent walk stopped short of a root. */
export type WalkFailure = "unknown-session" | "missing-parent" | "loop" | "unbounded";

/** The result of walking `parentSessionId` from one record up to its root. */
export type RootWalk = RootWalkSuccess | RootWalkFailure;

/** A walk that reached a record with no parent. */
export interface RootWalkSuccess {
	ok: true;
	/** The root session id. */
	rootSessionId: string;
	/** Hops from the record to the root. */
	depth: number;
	/** True when this record sits at or above the depth cap. */
	atCap: boolean;
	failure: null;
	failureId: null;
}

/**
 * A walk that stopped short of a root.
 *
 * It carries no root id, depth, or cap flag. A reader that skips the `ok`
 * check cannot read a dead walk as a spawnable one. The fields are absent
 * from this branch.
 */
export interface RootWalkFailure {
	ok: false;
	/** The kind of failure. */
	failure: WalkFailure;
	/** The id that broke the walk: the missing parent, the repeat, the start, or the step bound. */
	failureId: string;
}

/** Build a record with open counters. The caller supplies identity and clock. */
export function newRunRecord(start: RunStart): RunRecord {
	return {
		sessionId: start.sessionId,
		role: start.role,
		class: start.class,
		source: start.source,
		skills: [...start.skills],
		alwaysLoad: [...start.alwaysLoad],
		depth: start.depth,
		parentSessionId: start.parentSessionId,
		sessionFile: start.sessionFile,
		status: "running",
		turns: 0,
		toolCount: 0,
		startedAt: start.startedAt,
		endedAt: null,
	};
}

/** One failure shape, so no caller reads a half-filled walk result. */
function walkFailed(failure: WalkFailure, failureId: string): RootWalkFailure {
	return { ok: false, failure, failureId };
}

/** Live records, keyed by session id. One instance per process. */
export class RunRegistry {
	private readonly records = new Map<string, RunRecord>();

	/**
	 * Store a record, replacing any record on the same id. A resumed round calls
	 * this again. The registry keeps its own copy, so change counters through
	 * this class. The view it returns is read-only and dies on a re-register.
	 */
	register(record: RunRecord): Readonly<RunRecord> {
		if (!record.sessionId) {
			throw new Error("run-registry: a record needs a session id");
		}
		const stored: RunRecord = { ...record };
		this.records.set(stored.sessionId, stored);
		return stored;
	}

	/**
	 * The live record for one id as a read-only view, or undefined. The view is
	 * not a copy, so its counters move when this class counts on the same id.
	 */
	get(sessionId: string): Readonly<RunRecord> | undefined {
		return this.records.get(sessionId);
	}

	/** Role and class for a gated call. An unknown id returns known false, no throw. */
	resolve(sessionId: string): RunResolution {
		const record = this.records.get(sessionId);
		if (!record) return { known: false };
		return { known: true, role: record.role, class: record.class };
	}

	/**
	 * Walk `parentSessionId` up to the root and report the hop count.
	 *
	 * The walk counts hops, so a record cannot under-report its own depth. A
	 * visited set ends a loop, and a missing link names the id it wanted. The step
	 * bound ends a corrupt chain that the visited set cannot catch.
	 */
	walk(sessionId: string): RootWalk {
		const first = this.records.get(sessionId);
		if (!first) return walkFailed("unknown-session", sessionId);

		const visited = new Set<string>();
		let current = first;
		let depth = 0;
		let steps = 0;
		for (;;) {
			if (steps >= MAX_WALK_STEPS) return walkFailed("unbounded", current.sessionId);
			if (visited.has(current.sessionId)) {
				return walkFailed("loop", current.sessionId);
			}
			visited.add(current.sessionId);
			steps += 1;
			const parentId = current.parentSessionId;
			if (parentId === null) {
				return {
					ok: true,
					rootSessionId: current.sessionId,
					depth,
					atCap: !canSpawn(depth),
					failure: null,
					failureId: null,
				};
			}
			const parent = this.records.get(parentId);
			if (!parent) return walkFailed("missing-parent", parentId);
			current = parent;
			depth += 1;
		}
	}

	/** Count one assistant turn. Returns false when no record holds the id. */
	addTurn(sessionId: string): boolean {
		const record = this.records.get(sessionId);
		if (!record) return false;
		record.turns += 1;
		return true;
	}

	/** Count one tool call. Returns false when no record holds the id. */
	addToolCall(sessionId: string): boolean {
		const record = this.records.get(sessionId);
		if (!record) return false;
		record.toolCount += 1;
		return true;
	}

	/** Mark the exit of one run. Returns false when no record holds the id. */
	finish(sessionId: string, status: RunExit, endedAt: number): boolean {
		const record = this.records.get(sessionId);
		if (!record) return false;
		record.status = status;
		record.endedAt = endedAt;
		return true;
	}

	/**
	 * The records a retention sweep may delete at `now`.
	 *
	 * Age counts from the last write of the run, so a fresh record survives. A
	 * running record never qualifies, because its file is still in use. A root
	 * record closes at session shutdown, so it becomes eligible too.
	 */
	sweepable(now: number): Readonly<RunRecord>[] {
		const eligible: Readonly<RunRecord>[] = [];
		for (const record of this.records.values()) {
			if (record.status === "running") continue;
			const lastWrite = record.endedAt ?? record.startedAt;
			if (now - lastWrite > RUN_RETENTION_MS) eligible.push(record);
		}
		return eligible;
	}

	/** Drop one record, after its files are gone. False when the id was absent. */
	delete(sessionId: string): boolean {
		return this.records.delete(sessionId);
	}

	/** The number of live records. */
	get size(): number {
		return this.records.size;
	}
}

/** The registry the installed gate bound, or null before an install. */
let boundRegistry: RunRegistry | null = null;

/** Bind the registry the gate installed over, so a reader without the gate sees it. */
export function bindRunRegistry(registry: RunRegistry | null): void {
	boundRegistry = registry;
}

/** Reads what `bindRunRegistry` set. */
export function boundRunRegistry(): RunRegistry | null {
	return boundRegistry;
}

/**
 * The walked depth of one session from the bound registry, or null when no
 * registry is bound or the walk stops short. A caller uses it to tell a child
 * session from the root without holding the registry itself.
 */
export function sessionDepthOf(sessionId: string): number | null {
	const walk = boundRunRegistry()?.walk(sessionId);
	return walk !== undefined && walk.ok ? walk.depth : null;
}
