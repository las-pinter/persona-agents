/**
 * Subagent session store: the sidecar, the saved session file, and the resume plan.
 *
 * One session id covers one brief. The store keeps the session files under
 * `<agentDir>/sessions-subagents/` and one `<id>.json` sidecar per id. A sidecar
 * holds the eight fields a later round needs, so a reopen never guesses the
 * agent, the class, the round, or the parent.
 *
 * This module owns every resume decision: the round cap, the foreign-agent
 * refusal, the id-prefix and id-grammar refusals, the two cold fallbacks, and
 * the retention age. The runner switches on the returned plan and does not
 * re-decide a rule. It also builds the session manager one plan names and
 * writes the round sidecar.
 *
 * A sidecar read never throws. A missing, unreadable, corrupt, or partial file
 * reads as absent, because a broken sidecar must not block a cold run. The
 * clock and the agent directory come from the caller, so the plan is testable
 * without a live pi process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RUN_RETENTION_MS } from "./run-registry.ts";
import { PERMISSION_CLASSES } from "./resolver.ts";
import type { PermissionClass } from "./resolver.ts";

/** The store folder under the agent directory. One source for the name. */
export const SESSIONS_SUBDIR = "sessions-subagents";

/** Rounds one id may run: round 1 and round 2 resume, round 3 refuses. */
export const SESSION_ROUND_CAP = 2;

/** The exact refusal text for a third round on one id. */
export const ROUND_CAP_REASON = `round cap reached (${SESSION_ROUND_CAP}): start a new id for a new brief`;

/** Milliseconds in one day, for the whole-day age in the stale reason. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The permission classes a sidecar may name, taken from the resolver list. */
const PERMISSION_CLASS_NAMES: ReadonlySet<string> = new Set<string>(PERMISSION_CLASSES);

/**
 * The id grammar after the agent prefix: lower-case letters, digits, and hyphens.
 *
 * The dot is outside the grammar, so a `..` segment can never collapse the
 * sidecar path out of the store.
 */
const ID_TAIL_PATTERN = /^[a-z0-9-]+$/;

/** The eight fields a sidecar holds, in the order it writes them. */
export interface SidecarRecord {
	/** The agent the id belongs to. A differing agent refuses the round. */
	agent: string;
	/** The permission class the agent earned. */
	class: PermissionClass;
	/** Rounds already begun on this id. */
	rounds: number;
	/** Assistant turns in the saved round. */
	turns: number;
	/** Epoch milliseconds at the first write. */
	createdAt: number;
	/** Epoch milliseconds at the last write. */
	updatedAt: number;
	/** The parent session id, or null for a direct call. */
	parentSession: string | null;
	/** The working directory recorded for the saved round. */
	cwd: string;
}

/** A saved session file, its age source, and the header cwd. */
export interface SessionFileHit {
	/** The absolute path of the `.jsonl` file. */
	path: string;
	/** The file mtime in epoch milliseconds, the age source. */
	mtimeMs: number;
	/** The `cwd` from the session header. */
	headerCwd: string;
}

/** What the plan entry point needs from the caller. */
export interface PlanSessionInput {
	/** The agent directory that holds the store. */
	agentDir: string;
	/** The caller-named session id, prefixed with the agent name. */
	id: string;
	/** The resolved agent for this call. */
	agent: string;
	/** The permission class, used for a fresh sidecar. */
	class: PermissionClass;
	/** The current working directory, compared with the session header. */
	cwd: string;
	/** Epoch milliseconds, the age clock. */
	now: number;
}

/** A round that resumes the saved session. */
export interface ResumePlan {
	kind: "resume";
	id: string;
	agent: string;
	class: PermissionClass;
	/** The round this call runs: 1 or 2. */
	round: number;
	sidecar: SidecarRecord;
	sidecarPath: string;
	storeDir: string;
	/** The saved session file to reopen. */
	sessionFile: string;
	cwd: string;
}

/** A round that starts cold because nothing usable is saved. */
export interface ColdPlan {
	kind: "cold";
	/** `missing` for no usable sidecar or file, `stale` for age or cwd. */
	reason: "missing" | "stale";
	/** The reason text the result carries. */
	message: string;
	/** Whole days of age for a stale plan, else null. */
	ageDays: number | null;
	id: string;
	agent: string;
	class: PermissionClass;
	/** The round this call runs. */
	round: number;
	/** The saved sidecar when one exists, else null. */
	sidecar: SidecarRecord | null;
	sidecarPath: string;
	storeDir: string;
	cwd: string;
}

/** A round that refuses before a session is built. */
export interface RefusalPlan {
	kind: "refuse";
	reason: "round-cap" | "foreign-agent" | "prefix" | "bad-id";
	message: string;
	id: string;
	agent: string;
	/** The next round the cap refused, else null. */
	round: number | null;
	/** The agent a foreign sidecar names, else null. */
	sidecarAgent: string | null;
	/** The accepted id prefix for a prefix or bad-id refusal, else null. */
	acceptedPrefix: string | null;
	/** The sidecar path, or null when the id guard refused before a path was built. */
	sidecarPath: string | null;
}

/** The one discriminated plan. The runner switches on `kind`. */
export type SessionPlan = ResumePlan | ColdPlan | RefusalPlan;

/** The store folder for one agent directory. */
export function sessionStoreDir(agentDir: string): string {
	return path.join(agentDir, SESSIONS_SUBDIR);
}

/** True for an id that is safe as one file name inside the store. */
export function isSafeSidecarId(id: string): boolean {
	return ID_TAIL_PATTERN.test(id);
}

/**
 * The sidecar path for one session id.
 *
 * A bad id throws here, so no caller can build a path out of the store. The
 * read wrapper catches it, so a bad id reads as absent.
 */
export function sidecarPath(agentDir: string, id: string): string {
	if (!isSafeSidecarId(id)) {
		throw new Error(`session-store: session id "${id}" is not a safe file name`);
	}
	return path.join(sessionStoreDir(agentDir), `${id}.json`);
}

/** The accepted id prefix: the agent name and a hyphen. */
export function agentPrefix(agent: string): string {
	return `${agent}-`;
}

/**
 * True when the id passes the store grammar: the agent prefix, then a tail of
 * lower-case letters, digits, and hyphens.
 *
 * A caller-supplied id is not trusted. The guard runs before a path is built.
 */
export function isValidSessionId(agent: string, id: string): boolean {
	const prefix = agentPrefix(agent);
	if (!id.startsWith(prefix)) return false;
	return ID_TAIL_PATTERN.test(id.slice(prefix.length));
}

/** The cold reason for no usable saved session. */
export function missingSessionReason(id: string): string {
	return `no saved session for ${id}`;
}

/** The cold reason for a saved session past its retention or in another cwd. */
export function staleSessionReason(ageDays: number): string {
	return `stale session (age ${ageDays} d)`;
}

/** True for a non-negative integer. */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True for a finite epoch-millisecond value. */
function isStamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Parse one sidecar value. Any missing or invalid field means absent. */
function parseSidecar(value: unknown): SidecarRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const agent = raw["agent"];
	const permissionClass = raw["class"];
	const rounds = raw["rounds"];
	const turns = raw["turns"];
	const createdAt = raw["createdAt"];
	const updatedAt = raw["updatedAt"];
	const parentSession = raw["parentSession"];
	const cwd = raw["cwd"];

	if (typeof agent !== "string" || agent.length === 0) return null;
	if (typeof permissionClass !== "string" || !PERMISSION_CLASS_NAMES.has(permissionClass)) return null;
	if (!isCount(rounds) || !isCount(turns)) return null;
	// A round above the cap is corrupt, not capped: the file reads as absent.
	if (rounds > SESSION_ROUND_CAP) return null;
	if (!isStamp(createdAt) || !isStamp(updatedAt)) return null;
	if (parentSession !== null && typeof parentSession !== "string") return null;
	if (typeof cwd !== "string" || cwd.length === 0) return null;

	return {
		agent,
		class: permissionClass as PermissionClass,
		rounds,
		turns,
		createdAt,
		updatedAt,
		parentSession,
		cwd,
	};
}

/** Read one sidecar. A missing, unreadable, corrupt, or partial file is absent. */
export function readSidecar(agentDir: string, id: string): SidecarRecord | null {
	try {
		const text = fs.readFileSync(sidecarPath(agentDir, id), "utf8");
		return parseSidecar(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Write one sidecar file and return its path. The caller supplies a safe path. */
function writeSidecarFile(file: string, record: SidecarRecord): string {
	const stored: SidecarRecord = {
		agent: record.agent,
		class: record.class,
		rounds: record.rounds,
		turns: record.turns,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		parentSession: record.parentSession,
		cwd: record.cwd,
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(stored)}\n`, "utf8");
	return file;
}

/** Write one sidecar and return its path. The eight fields are written in order. */
export function writeSidecar(agentDir: string, id: string, record: SidecarRecord): string {
	return writeSidecarFile(sidecarPath(agentDir, id), record);
}

/** Read the session header `cwd` from the first line. Null when unreadable. */
function readHeaderCwd(file: string): string | null {
	let fd: number | null = null;
	try {
		fd = fs.openSync(file, "r");
		// The header line is short; a 64 KiB window keeps a huge transcript out of memory.
		const buffer = Buffer.alloc(64 * 1024);
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytes === 0) return null;
		const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0] ?? "";
		const parsed: unknown = JSON.parse(firstLine);
		if (typeof parsed !== "object" || parsed === null) return null;
		const header = parsed as Record<string, unknown>;
		if (header["type"] !== "session") return null;
		const cwd = header["cwd"];
		return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// A close failure must not change the header result.
			}
		}
	}
}

/**
 * Find the session file for one id.
 *
 * The file name is `<stamp>_<id>.jsonl`, so the id alone does not name it. A
 * match is a stem that equals the id or ends with `_<id>`. The newest readable
 * match wins; on an equal mtime the first name in sorted order wins. A file
 * with no readable session header is skipped.
 */
export function findSessionFile(agentDir: string, id: string): SessionFileHit | null {
	const storeDir = sessionStoreDir(agentDir);
	let names: string[];
	try {
		names = fs.readdirSync(storeDir).sort();
	} catch {
		return null;
	}

	let best: SessionFileHit | null = null;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const stem = name.slice(0, -".jsonl".length);
		if (stem !== id && !stem.endsWith(`_${id}`)) continue;
		const file = path.join(storeDir, name);
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile()) continue;
			const headerCwd = readHeaderCwd(file);
			if (headerCwd === null) continue;
			if (best === null || stat.mtimeMs > best.mtimeMs) {
				best = { path: file, mtimeMs: stat.mtimeMs, headerCwd };
			}
		} catch {
			// An unreadable file is not a saved session.
		}
	}
	return best;
}

/** The facts the decision reads. The entry point gathers them from disk. */
export interface SessionFacts {
	sidecar: SidecarRecord | null;
	session: SessionFileHit | null;
}

/** The cold plan for a missing saved session. */
function coldMissing(input: PlanSessionInput, sidecar: SidecarRecord | null, round: number): ColdPlan {
	return {
		kind: "cold",
		reason: "missing",
		message: missingSessionReason(input.id),
		ageDays: null,
		id: input.id,
		agent: input.agent,
		class: sidecar?.class ?? input.class,
		round,
		sidecar,
		sidecarPath: sidecarPath(input.agentDir, input.id),
		storeDir: sessionStoreDir(input.agentDir),
		cwd: input.cwd,
	};
}

/** The cold plan for a saved session past retention or in another cwd. */
function coldStale(
	input: PlanSessionInput,
	sidecar: SidecarRecord,
	round: number,
	ageDays: number,
): ColdPlan {
	return {
		kind: "cold",
		reason: "stale",
		message: staleSessionReason(ageDays),
		ageDays,
		id: input.id,
		agent: input.agent,
		class: sidecar.class,
		round,
		sidecar,
		sidecarPath: sidecarPath(input.agentDir, input.id),
		storeDir: sessionStoreDir(input.agentDir),
		cwd: input.cwd,
	};
}

/**
 * The id refusal for a missing prefix or a bad grammar, else null.
 *
 * The guard builds no path: a refused id must not reach the disk.
 */
function idRefusal(input: PlanSessionInput): RefusalPlan | null {
	const prefix = agentPrefix(input.agent);
	const base = {
		kind: "refuse" as const,
		id: input.id,
		agent: input.agent,
		sidecarPath: null,
		round: null,
		sidecarAgent: null,
		acceptedPrefix: prefix,
	};

	if (!input.id.startsWith(prefix)) {
		return { ...base, reason: "prefix", message: `session id "${input.id}" must start with "${prefix}"` };
	}
	if (!isValidSessionId(input.agent, input.id)) {
		return {
			...base,
			reason: "bad-id",
			message: `session id "${input.id}" fails the bad-id rule: only lower-case letters, digits, and hyphens may follow "${prefix}"`,
		};
	}
	return null;
}

/**
 * Decide one plan from the sidecar and session facts. This function reads no
 * disk, so the rule order is one readable sequence.
 *
 * Order: id prefix, id grammar, sidecar presence, foreign agent, round cap,
 * session file presence, retention age, header cwd. A refusal comes before a
 * cold fallback, and a cap refusal closes the id even when the session file is
 * gone.
 */
export function decidePlan(input: PlanSessionInput, facts: SessionFacts): SessionPlan {
	const refused = idRefusal(input);
	if (refused !== null) return refused;

	const prefix = agentPrefix(input.agent);
	const refusalBase = { kind: "refuse" as const, id: input.id, agent: input.agent, sidecarPath: sidecarPath(input.agentDir, input.id) };

	const { sidecar, session } = facts;
	if (sidecar === null) return coldMissing(input, null, 1);

	if (sidecar.agent !== input.agent) {
		return {
			...refusalBase,
			reason: "foreign-agent",
			message: `session id "${input.id}" belongs to agent "${sidecar.agent}", not "${input.agent}"`,
			round: null,
			sidecarAgent: sidecar.agent,
			acceptedPrefix: prefix,
		};
	}

	const round = sidecar.rounds + 1;
	if (round > SESSION_ROUND_CAP) {
		return {
			...refusalBase,
			reason: "round-cap",
			message: ROUND_CAP_REASON,
			round,
			sidecarAgent: null,
			acceptedPrefix: prefix,
		};
	}

	if (session === null) return coldMissing(input, sidecar, round);

	const ageMs = input.now - session.mtimeMs;
	// Whole days rounded up, so a stale file never names the window day count.
	const ageDays = Math.max(0, Math.ceil(ageMs / DAY_MS));
	// Exactly the window is still fresh; only a greater age is stale.
	if (ageMs > RUN_RETENTION_MS) return coldStale(input, sidecar, round, ageDays);
	if (session.headerCwd !== input.cwd) return coldStale(input, sidecar, round, ageDays);

	return {
		kind: "resume",
		id: input.id,
		agent: input.agent,
		class: sidecar.class,
		round,
		sidecar,
		sidecarPath: sidecarPath(input.agentDir, input.id),
		storeDir: sessionStoreDir(input.agentDir),
		sessionFile: session.path,
		cwd: input.cwd,
	};
}

/** Gather the saved facts and return the one plan. A read never throws. */
export function planSession(input: PlanSessionInput): SessionPlan {
	// The id rules run first, so a refused id never touches the disk.
	const refused = idRefusal(input);
	if (refused !== null) return refused;

	const sidecar = readSidecar(input.agentDir, input.id);
	const session = sidecar === null ? null : findSessionFile(input.agentDir, input.id);
	return decidePlan(input, { sidecar, session });
}

/** One session manager built from a plan, with the facts a result carries. */
export interface PlannedSession {
	/** A new persisted file for a cold run, or the saved file reopened. */
	sessionManager: SessionManager;
	/** The plan this manager came from, kept so the round can write its sidecar. */
	plan: ResumePlan | ColdPlan;
	/** The caller-named store id. */
	id: string;
	/** True when the manager reopened a saved file. */
	resumed: boolean;
	/** The round this call runs. */
	round: number;
	/** The store reason a cold round carries, or the empty string on a resume. */
	note: string;
}

/**
 * Build the session manager one plan names.
 *
 * A cold plan gets a manager that persists under the store directory and keeps
 * the store id. The library writes the file at the first user or assistant
 * message; a setup entry alone leaves no file. The file name ends with the
 * store id, so a later round finds it. A resume opens the saved file and keeps
 * its id. The parent link goes into the header only, on a cold round.
 */
export function openPlannedSession(
	plan: ResumePlan | ColdPlan,
	parentSession: string | null,
): PlannedSession {
	if (plan.kind === "resume") {
		return {
			sessionManager: SessionManager.open(plan.sessionFile, plan.storeDir, plan.cwd),
			plan,
			id: plan.id,
			resumed: true,
			round: plan.round,
			note: "",
		};
	}
	const sessionManager = SessionManager.create(plan.cwd, plan.storeDir, {
		id: plan.id,
		parentSession: parentSession ?? undefined,
	});
	return {
		sessionManager,
		plan,
		id: plan.id,
		resumed: false,
		round: plan.round,
		note: plan.message,
	};
}

/**
 * Write the sidecar after one round: the round count, this round's turns, and
 * the write time. The five identity fields (agent, class, createdAt,
 * parentSession, cwd) keep their first written value. The three counters are
 * written every round, and the round cap depends on `rounds` growing, so
 * `rounds` cannot be frozen. A saved `null` parent stays `null`.
 */
export function writeRoundSidecar(
	plan: ResumePlan | ColdPlan,
	turns: number,
	parentSession: string | null,
	now: number,
): string {
	const first = plan.sidecar;
	return writeSidecarFile(plan.sidecarPath, {
		agent: plan.agent,
		class: plan.class,
		rounds: plan.round,
		turns,
		createdAt: first?.createdAt ?? now,
		updatedAt: now,
		parentSession: first ? first.parentSession : parentSession,
		cwd: first?.cwd ?? plan.cwd,
	});
}
