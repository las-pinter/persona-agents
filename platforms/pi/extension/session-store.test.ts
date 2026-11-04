/**
 * Offline harness for the subagent session store.
 *
 * Runs under plain Node (type stripping) with no live pi process:
 *   node --experimental-strip-types --test platforms/pi/extension/session-store.test.ts
 *
 * Every case uses a temp agent directory, never the real agent folder. The
 * clock is a fixed constant, and a file mtime sets the age, so no case flakes.
 */

import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_RETENTION_MS } from "./run-registry.ts";
import { PERMISSION_CLASSES } from "./resolver.ts";
import {
	ROUND_CAP_REASON,
	SESSIONS_SUBDIR,
	SESSION_ROUND_CAP,
	agentPrefix,
	decidePlan,
	findSessionFile,
	isSafeSidecarId,
	isValidSessionId,
	missingSessionReason,
	openPlannedSession,
	planSession,
	readSidecar,
	sessionStoreDir,
	sidecarPath,
	staleSessionReason,
	writeRoundSidecar,
	writeSidecar,
} from "./session-store.ts";
import type { SidecarRecord, SessionFacts } from "./session-store.ts";

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const CWD = "/repo/persona-agents";
const AGENT = "implementer";
const ID = "implementer-auth-fix";

const roots: string[] = [];

/** A throw-away agent directory. Removed after the file finishes. */
function tempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-"));
	roots.push(dir);
	return dir;
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** A valid sidecar. A case overrides what it tests. */
function sidecar(extra: Partial<SidecarRecord> = {}): SidecarRecord {
	return {
		agent: AGENT,
		class: "worker",
		rounds: 1,
		turns: 4,
		createdAt: NOW - 2 * DAY,
		updatedAt: NOW - DAY,
		parentSession: "root-session",
		cwd: CWD,
		...extra,
	};
}

/** Write one `.jsonl` session file with a header and set its mtime. */
function writeSession(
	agentDir: string,
	id: string,
	options: { cwd?: string; mtimeMs?: number; stamp?: string } = {},
): string {
	const storeDir = sessionStoreDir(agentDir);
	fs.mkdirSync(storeDir, { recursive: true });
	const stamp = options.stamp ?? "2026-01-01T00-00-00-000Z";
	const file = path.join(storeDir, `${stamp}_${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date(options.mtimeMs ?? NOW).toISOString(),
		cwd: options.cwd ?? CWD,
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
	const mtime = new Date(options.mtimeMs ?? NOW);
	fs.utimesSync(file, mtime, mtime);
	return file;
}

/** Write one raw sidecar JSON value, bypassing the typed writer. */
function writeRawSidecar(agentDir: string, id: string, raw: unknown): void {
	fs.mkdirSync(sessionStoreDir(agentDir), { recursive: true });
	fs.writeFileSync(sidecarPath(agentDir, id), `${JSON.stringify(raw)}\n`, "utf8");
}

/** Write one session file whose first line is not a session header. */
function writeBrokenSession(
	agentDir: string,
	id: string,
	options: { mtimeMs: number; stamp: string },
): string {
	const storeDir = sessionStoreDir(agentDir);
	fs.mkdirSync(storeDir, { recursive: true });
	const file = path.join(storeDir, `${options.stamp}_${id}.jsonl`);
	fs.writeFileSync(file, "not a session header\n", "utf8");
	const mtime = new Date(options.mtimeMs);
	fs.utimesSync(file, mtime, mtime);
	return file;
}

/** Plan one call with the common defaults. */
function plan(
	agentDir: string,
	overrides: Partial<Parameters<typeof planSession>[0]> = {},
): ReturnType<typeof planSession> {
	return planSession({
		agentDir,
		id: ID,
		agent: AGENT,
		class: "worker",
		cwd: CWD,
		now: NOW,
		...overrides,
	});
}

// --- store location -----------------------------------------------------------

test("the store sits under the agent directory with the one folder name", () => {
	const agentDir = path.join("/home", "goblin", ".pi", "agent");

	assert.equal(SESSIONS_SUBDIR, "sessions-subagents");
	assert.equal(sessionStoreDir(agentDir), path.join(agentDir, "sessions-subagents"));
	assert.equal(
		sidecarPath(agentDir, ID),
		path.join(agentDir, "sessions-subagents", `${ID}.json`),
	);
});

// --- sidecar roundtrip --------------------------------------------------------

test("all eight sidecar fields write and read back unchanged", () => {
	const agentDir = tempAgentDir();
	const record = sidecar();

	const file = writeSidecar(agentDir, ID, record);

	assert.equal(file, sidecarPath(agentDir, ID));
	assert.deepEqual(readSidecar(agentDir, ID), record);
});

test("the sidecar file holds exactly the eight fields", () => {
	const agentDir = tempAgentDir();
	writeSidecar(agentDir, ID, sidecar());

	const raw = JSON.parse(fs.readFileSync(sidecarPath(agentDir, ID), "utf8")) as Record<string, unknown>;

	assert.deepEqual(Object.keys(raw).sort(), [
		"agent",
		"class",
		"createdAt",
		"cwd",
		"parentSession",
		"rounds",
		"turns",
		"updatedAt",
	]);
});

test("a missing sidecar reads as absent without throwing", () => {
	const agentDir = tempAgentDir();

	assert.equal(readSidecar(agentDir, ID), null);
});

test("a corrupt sidecar reads as absent without throwing", () => {
	const agentDir = tempAgentDir();
	fs.mkdirSync(sessionStoreDir(agentDir), { recursive: true });
	fs.writeFileSync(sidecarPath(agentDir, ID), "{ not json", "utf8");

	assert.equal(readSidecar(agentDir, ID), null);
});

test("a partial sidecar reads as absent without throwing", () => {
	const agentDir = tempAgentDir();
	fs.mkdirSync(sessionStoreDir(agentDir), { recursive: true });
	fs.writeFileSync(sidecarPath(agentDir, ID), JSON.stringify({ agent: AGENT }), "utf8");

	assert.equal(readSidecar(agentDir, ID), null);
});

test("each sidecar field guard refuses its own bad value", () => {
	const bad: Array<{ name: string; raw: Record<string, unknown> }> = [
		{ name: "a string where a number belongs", raw: { ...sidecar(), turns: "4" } },
		{ name: "a negative round", raw: { ...sidecar(), rounds: -1 } },
		{ name: "a null agent", raw: { ...sidecar(), agent: null } },
		{ name: "an empty cwd", raw: { ...sidecar(), cwd: "" } },
		{ name: "an unknown class name", raw: { ...sidecar(), class: "admin" } },
		{ name: "a fractional turn count", raw: { ...sidecar(), turns: 1.5 } },
		{ name: "a string parent session", raw: { ...sidecar(), parentSession: 7 } },
	];

	for (const entry of bad) {
		const agentDir = tempAgentDir();
		writeRawSidecar(agentDir, ID, entry.raw);
		assert.equal(readSidecar(agentDir, ID), null, `${entry.name} must read as absent`);
	}
});

test("a sidecar with a missing field reads as absent", () => {
	const agentDir = tempAgentDir();
	const raw: Record<string, unknown> = { ...sidecar() };
	delete raw["turns"];
	writeRawSidecar(agentDir, ID, raw);

	assert.equal(readSidecar(agentDir, ID), null);
});

test("every resolver permission class is accepted by a sidecar", () => {
	for (const name of PERMISSION_CLASSES) {
		const agentDir = tempAgentDir();
		writeRawSidecar(agentDir, ID, { ...sidecar(), class: name });

		assert.equal(readSidecar(agentDir, ID)?.class, name);
	}
});

test("a round count above the cap reads as absent, not as a cap refusal", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);
	writeRawSidecar(agentDir, ID, { ...sidecar(), rounds: 999 });

	assert.equal(readSidecar(agentDir, ID), null);

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "missing");
	assert.equal(one.round, 1);
});

test("a round count exactly at the cap still reads", () => {
	const agentDir = tempAgentDir();
	writeRawSidecar(agentDir, ID, { ...sidecar(), rounds: SESSION_ROUND_CAP });

	assert.equal(readSidecar(agentDir, ID)?.rounds, SESSION_ROUND_CAP);
});

test("an unreadable sidecar path reads as absent without throwing", () => {
	const agentDir = tempAgentDir();
	fs.mkdirSync(sidecarPath(agentDir, ID), { recursive: true });

	assert.equal(readSidecar(agentDir, ID), null);
});

// --- session file lookup ------------------------------------------------------

test("a stamped session file is found by the id at the end of its name", () => {
	const agentDir = tempAgentDir();
	const file = writeSession(agentDir, ID);

	const hit = findSessionFile(agentDir, ID);

	assert.equal(hit?.path, file);
	assert.equal(hit?.headerCwd, CWD);
	assert.equal(hit?.mtimeMs, NOW);
});

test("a missing store holds no session file", () => {
	const agentDir = tempAgentDir();

	assert.equal(findSessionFile(agentDir, ID), null);
});

test("the newest readable match wins over an older match", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { stamp: "2026-01-01T00-00-00-000Z", mtimeMs: NOW - 2 * DAY });
	const newer = writeSession(agentDir, ID, { stamp: "2026-02-01T00-00-00-000Z", mtimeMs: NOW - DAY });

	const hit = findSessionFile(agentDir, ID);

	assert.equal(hit?.path, newer);
	assert.equal(hit?.mtimeMs, NOW - DAY);
});

test("an equal mtime keeps the first name in sorted order", () => {
	const agentDir = tempAgentDir();
	const first = writeSession(agentDir, ID, { stamp: "2026-01-01T00-00-00-000Z", mtimeMs: NOW });
	writeSession(agentDir, ID, { stamp: "2026-02-01T00-00-00-000Z", mtimeMs: NOW });

	const hit = findSessionFile(agentDir, ID);

	assert.equal(hit?.path, first);
});

test("a directory with a session file name is skipped", () => {
	const agentDir = tempAgentDir();
	const storeDir = sessionStoreDir(agentDir);
	fs.mkdirSync(path.join(storeDir, `2026-03-01T00-00-00-000Z_${ID}.jsonl`), { recursive: true });

	assert.equal(findSessionFile(agentDir, ID), null);
});

test("a directory beside a saved session file does not hide the file", () => {
	const agentDir = tempAgentDir();
	const file = writeSession(agentDir, ID, { stamp: "2026-01-01T00-00-00-000Z", mtimeMs: NOW - DAY });
	fs.mkdirSync(path.join(sessionStoreDir(agentDir), `2026-03-01T00-00-00-000Z_${ID}.jsonl`), { recursive: true });

	const hit = findSessionFile(agentDir, ID);

	assert.equal(hit?.path, file);
});

test("a file with no readable header is skipped", () => {
	const agentDir = tempAgentDir();
	writeBrokenSession(agentDir, ID, { stamp: "2026-01-01T00-00-00-000Z", mtimeMs: NOW });

	assert.equal(findSessionFile(agentDir, ID), null);
});

test("a newer file with no readable header loses to a readable older one", () => {
	const agentDir = tempAgentDir();
	const readable = writeSession(agentDir, ID, { stamp: "2026-01-01T00-00-00-000Z", mtimeMs: NOW - DAY });
	writeBrokenSession(agentDir, ID, { stamp: "2026-02-01T00-00-00-000Z", mtimeMs: NOW });

	const hit = findSessionFile(agentDir, ID);

	assert.equal(hit?.path, readable);
	assert.equal(hit?.mtimeMs, NOW - DAY);
});

// --- round cap ----------------------------------------------------------------

test("round 1 on a fresh sidecar plans a resume", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);
	writeSidecar(agentDir, ID, sidecar({ rounds: 0 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "resume");
	if (one.kind !== "resume") return;
	assert.equal(one.round, 1);
});

test("round 2 on a one-round sidecar plans a resume", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "resume");
	if (one.kind !== "resume") return;
	assert.equal(one.round, 2);
});

test("round 3 on a two-round sidecar refuses with the exact text", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);
	writeSidecar(agentDir, ID, sidecar({ rounds: SESSION_ROUND_CAP }));

	const one = plan(agentDir);

	assert.equal(SESSION_ROUND_CAP, 2);
	assert.equal(ROUND_CAP_REASON, "round cap reached (2): start a new id for a new brief");
	assert.equal(one.kind, "refuse");
	if (one.kind !== "refuse") return;
	assert.equal(one.reason, "round-cap");
	assert.equal(one.message, "round cap reached (2): start a new id for a new brief");
	assert.equal(one.round, 3);
});

test("the cap refuses even when the session file is gone", () => {
	const agentDir = tempAgentDir();
	writeSidecar(agentDir, ID, sidecar({ rounds: 2 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "refuse");
	if (one.kind !== "refuse") return;
	assert.equal(one.reason, "round-cap");
});

// --- cold fallbacks -----------------------------------------------------------

test("no sidecar plans a cold run with the missing reason", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "missing");
	assert.equal(one.message, "no saved session for implementer-auth-fix");
	assert.equal(one.round, 1);
	assert.equal(one.sidecar, null);
});

test("a sidecar with no session file plans a cold run with the missing reason", () => {
	const agentDir = tempAgentDir();
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "missing");
	assert.equal(one.message, missingSessionReason(ID));
	assert.equal(one.round, 2);
});

test("a file older than the window plans a cold run with the stale reason and whole days", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { mtimeMs: NOW - 20 * DAY });
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "stale");
	assert.equal(one.ageDays, 20);
	assert.equal(one.message, "stale session (age 20 d)");
	assert.equal(one.round, 2);
});

test("a differing header cwd plans a cold run with the stale reason and age", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { cwd: "/elsewhere", mtimeMs: NOW - 3 * DAY });
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "stale");
	assert.equal(one.ageDays, 3);
	assert.equal(one.message, staleSessionReason(3));
});

test("a file exactly at the window is fresh and resumes", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { mtimeMs: NOW - RUN_RETENTION_MS });
	writeSidecar(agentDir, ID, sidecar({ rounds: 0 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "resume");
	if (one.kind !== "resume") return;
	assert.equal(one.round, 1);
});

test("a file older than the window by one millisecond is stale", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { mtimeMs: NOW - RUN_RETENTION_MS - 1 });
	writeSidecar(agentDir, ID, sidecar({ rounds: 0 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "stale");
	assert.equal(one.ageDays, 15);
	assert.equal(one.message, "stale session (age 15 d)");
});

test("a partial day past retention rounds the age up", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID, { mtimeMs: NOW - RUN_RETENTION_MS - 6 * 60 * 60 * 1000 });
	writeSidecar(agentDir, ID, sidecar({ rounds: 0 }));

	const one = plan(agentDir);

	assert.equal(one.kind, "cold");
	if (one.kind !== "cold") return;
	assert.equal(one.reason, "stale");
	assert.equal(one.ageDays, 15);
	assert.equal(one.message, "stale session (age 15 d)");
});

// --- refusals -----------------------------------------------------------------

test("a foreign sidecar refuses and names both agents", () => {
	const agentDir = tempAgentDir();
	const foreignId = "reviewer-auth-fix";
	writeSession(agentDir, foreignId);
	writeSidecar(agentDir, foreignId, sidecar({ agent: "implementer", class: "worker" }));

	const one = plan(agentDir, { id: foreignId, agent: "reviewer", class: "reader" });

	assert.equal(one.kind, "refuse");
	if (one.kind !== "refuse") return;
	assert.equal(one.reason, "foreign-agent");
	assert.equal(one.sidecarAgent, "implementer");
	assert.match(one.message, /implementer/);
	assert.match(one.message, /reviewer/);
});

test("an id without the agent prefix refuses and names the prefix form", () => {
	const agentDir = tempAgentDir();

	const one = plan(agentDir, { id: "wrong-auth-fix", agent: "reviewer" });

	assert.equal(agentPrefix("reviewer"), "reviewer-");
	assert.equal(one.kind, "refuse");
	if (one.kind !== "refuse") return;
	assert.equal(one.reason, "prefix");
	assert.equal(one.acceptedPrefix, "reviewer-");
	assert.match(one.message, /reviewer-/);
});

test("the id grammar accepts lower-case letters, digits, and hyphens after the prefix", () => {
	assert.equal(isValidSessionId(AGENT, ID), true);
	assert.equal(isValidSessionId(AGENT, `${AGENT}-a1-b2`), true);
	assert.equal(isValidSessionId(AGENT, `${AGENT}-`), false);
});

test("a dot-dot id segment refuses with the bad-id reason and builds no path", () => {
	const badIds = [
		`${AGENT}-../outside`,
		`${AGENT}-a..b`,
		`${AGENT}-..`,
		`${AGENT}-Upper`,
		`${AGENT}-a/b`,
		`${AGENT}-a_b`,
	];

	for (const id of badIds) {
		const agentDir = tempAgentDir();

		assert.equal(isValidSessionId(AGENT, id), false, `${id} must fail the grammar`);

		const one = plan(agentDir, { id });

		assert.equal(one.kind, "refuse", `${id} must refuse`);
		if (one.kind !== "refuse") continue;
		assert.equal(one.reason, "bad-id");
		assert.equal(one.sidecarPath, null);
		assert.match(one.message, /bad-id/);
		assert.match(one.message, /implementer-/);
		assert.equal(fs.existsSync(sessionStoreDir(agentDir)), false, `${id} must not touch the disk`);
	}
});

test("a bad id refuses before a saved sidecar or session file is read", () => {
	const agentDir = tempAgentDir();
	writeSession(agentDir, ID);
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const one = plan(agentDir, { id: `${AGENT}-../${ID}` });

	assert.equal(one.kind, "refuse");
	if (one.kind !== "refuse") return;
	assert.equal(one.reason, "bad-id");
});

// --- pure decision seam -------------------------------------------------------

test("the pure decision needs no disk and reports a resume from supplied facts", () => {
	const agentDir = tempAgentDir();
	const facts: SessionFacts = {
		sidecar: sidecar({ rounds: 0 }),
		session: { path: "/tmp/saved.jsonl", mtimeMs: NOW, headerCwd: CWD },
	};

	const one = decidePlan(
		{ agentDir, id: ID, agent: AGENT, class: "worker", cwd: CWD, now: NOW },
		facts,
	);

	assert.equal(one.kind, "resume");
	if (one.kind !== "resume") return;
	assert.equal(one.sessionFile, "/tmp/saved.jsonl");
	assert.equal(one.round, 1);
});

// --- planned session and round write ------------------------------------------

test("a cold plan opens a manager that persists a store file the lookup later finds", () => {
	const agentDir = tempAgentDir();

	const cold = plan(agentDir);
	assert.equal(cold.kind, "cold");
	if (cold.kind !== "cold") return;

	const opened = openPlannedSession(cold, "root-session");

	assert.equal(opened.resumed, false);
	assert.equal(opened.id, ID);
	assert.equal(opened.round, 1);
	assert.equal(opened.note, cold.message);
	assert.equal(opened.plan, cold);

	const pending = opened.sessionManager.getSessionFile();
	assert.ok(pending !== undefined, "a cold round must know its store file");
	if (pending === undefined) return;
	assert.equal(path.dirname(pending), sessionStoreDir(agentDir));
	assert.match(path.basename(pending), /^\d{4}-\d{2}-\d{2}T[\d-]+Z_implementer-auth-fix\.jsonl$/);

	// The library writes the file at the first message, so a round drives it once.
	opened.sessionManager.appendMessage({ role: "user", content: "probe", timestamp: NOW });

	assert.equal(fs.existsSync(pending), true);
	assert.equal(opened.sessionManager.getHeader()?.parentSession, "root-session");

	const hit = findSessionFile(agentDir, ID);
	assert.equal(hit?.path, pending);
	assert.equal(hit?.headerCwd, CWD);
});

test("a resume plan reopens the saved file and reports the next round", () => {
	const agentDir = tempAgentDir();
	const saved = writeSession(agentDir, ID, { mtimeMs: NOW - DAY });
	writeSidecar(agentDir, ID, sidecar({ rounds: 1 }));

	const resume = plan(agentDir);
	assert.equal(resume.kind, "resume");
	if (resume.kind !== "resume") return;

	// The parent argument is cold-only, so a resume must ignore it.
	const opened = openPlannedSession(resume, "ignored-parent");

	assert.equal(opened.resumed, true);
	assert.equal(opened.id, ID);
	assert.equal(opened.round, 2);
	assert.equal(opened.note, "");
	assert.equal(opened.plan, resume);
	assert.equal(opened.sessionManager.getSessionFile(), saved);
	assert.equal(opened.sessionManager.getSessionId(), ID);
	assert.equal(opened.sessionManager.getHeader()?.cwd, CWD);
	assert.equal(opened.sessionManager.getHeader()?.parentSession, undefined);
});

test("a round sidecar write updates the counts and the next plan refuses at the cap", () => {
	const agentDir = tempAgentDir();

	const cold = plan(agentDir);
	assert.equal(cold.kind, "cold");
	if (cold.kind !== "cold") return;

	const opened = openPlannedSession(cold, null);
	opened.sessionManager.appendMessage({ role: "user", content: "probe", timestamp: NOW });
	const file = opened.sessionManager.getSessionFile();
	assert.ok(file !== undefined, "a cold round must persist a file before its sidecar write");
	if (file === undefined) return;
	const mtime = new Date(NOW);
	fs.utimesSync(file, mtime, mtime);

	const firstWrite = NOW + 60_000;
	assert.equal(writeRoundSidecar(cold, 5, "root-session", firstWrite), sidecarPath(agentDir, ID));

	const afterOne = readSidecar(agentDir, ID);
	assert.equal(afterOne?.agent, AGENT);
	assert.equal(afterOne?.class, "worker");
	assert.equal(afterOne?.rounds, 1);
	assert.equal(afterOne?.turns, 5);
	assert.equal(afterOne?.createdAt, firstWrite);
	assert.equal(afterOne?.updatedAt, firstWrite);
	assert.equal(afterOne?.parentSession, "root-session");
	assert.equal(afterOne?.cwd, CWD);

	const second = plan(agentDir, { now: firstWrite });
	assert.equal(second.kind, "resume");
	if (second.kind !== "resume") return;
	assert.equal(second.round, 2);

	const secondWrite = firstWrite + 60_000;
	writeRoundSidecar(second, 3, null, secondWrite);

	const afterTwo = readSidecar(agentDir, ID);
	assert.equal(afterTwo?.agent, AGENT);
	assert.equal(afterTwo?.class, "worker");
	assert.equal(afterTwo?.rounds, 2);
	assert.equal(afterTwo?.turns, 3);
	assert.equal(afterTwo?.createdAt, firstWrite);
	assert.equal(afterTwo?.updatedAt, secondWrite);
	assert.equal(afterTwo?.parentSession, "root-session");

	const third = plan(agentDir, { now: secondWrite });
	assert.equal(third.kind, "refuse");
	if (third.kind !== "refuse") return;
	assert.equal(third.reason, "round-cap");
	assert.equal(third.message, ROUND_CAP_REASON);
	assert.equal(third.round, 3);
});

test("a saved null parent stays null when a later round passes a real parent id", () => {
	const agentDir = tempAgentDir();

	const cold = plan(agentDir);
	assert.equal(cold.kind, "cold");
	if (cold.kind !== "cold") return;

	const opened = openPlannedSession(cold, null);
	opened.sessionManager.appendMessage({ role: "user", content: "probe", timestamp: NOW });
	const file = opened.sessionManager.getSessionFile();
	assert.ok(file !== undefined, "a cold round must persist a file before its sidecar write");
	if (file === undefined) return;
	const mtime = new Date(NOW);
	fs.utimesSync(file, mtime, mtime);

	const firstWrite = NOW + 60_000;
	writeRoundSidecar(cold, 4, null, firstWrite);
	assert.equal(readSidecar(agentDir, ID)?.parentSession, null, "the first write must save the null parent");

	const second = plan(agentDir, { now: firstWrite });
	assert.equal(second.kind, "resume");
	if (second.kind !== "resume") return;

	const secondWrite = firstWrite + 60_000;
	writeRoundSidecar(second, 2, "root-session", secondWrite);

	const afterTwo = readSidecar(agentDir, ID);
	assert.equal(afterTwo?.rounds, 2);
	assert.equal(afterTwo?.parentSession, null, "a later round must not fill in the saved null parent");
});

test("an escape id is refused before a path is built and writes nothing outside the store", () => {
	const parent = tempAgentDir();
	const agentDir = path.join(parent, "agent");
	const badIds = [
		`${AGENT}-../escape`,
		`${AGENT}-a/../../escape`,
		`${AGENT}-Escape`,
		`${AGENT}-a..b`,
	];

	for (const id of badIds) {
		assert.equal(isSafeSidecarId(id), false, `${id} must not be a safe file name`);
		assert.throws(() => sidecarPath(agentDir, id), `${id} must not build a sidecar path`);
		assert.equal(readSidecar(agentDir, id), null, `${id} must read as absent`);

		const one = plan(agentDir, { id });
		assert.equal(one.kind, "refuse", `${id} must refuse`);
		if (one.kind !== "refuse") continue;
		assert.equal(one.reason, "bad-id");
		assert.equal(one.sidecarPath, null);
	}

	assert.equal(fs.existsSync(agentDir), false, "a refused id must not create the agent folder");
	assert.deepEqual(fs.readdirSync(parent), [], "a refused id must write nothing beside the store");
});
