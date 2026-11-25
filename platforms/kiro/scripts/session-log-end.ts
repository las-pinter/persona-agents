/**
 * The session-log safety net for a Kiro companion session that ends without a
 * wrap-up.
 *
 *   session-log-end.ts hook             SessionEnd: when this session has no entry
 *                                   and has material, save a payload and start
 *                                   the writer as a detached process. Returns
 *                                   at once; the SessionEnd budget is short.
 *   session-log-end.ts write <payload>  The detached writer: build the prompt, run
 *                                   a small headless model through the
 *                                   `ca-writer` agent, and write the entry if it
 *                                   is still missing.
 *
 * The source text is the task notes the session wrote, the compaction
 * summaries compact.ts kept, and the conversation after the last compaction.
 * The writer agent has no tools; it only writes one markdown entry.
 *
 * SessionEnd fires on interactive runtime teardown. It does not fire in a
 * `--no-interactive` run, so scripted sessions get no automatic entry; wrap-up
 * remains the good path.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dayOf, entryPath, findEntry } from "../../shared/notes/session-log.ts";
import { hasMaterial, sources, writerPrompt } from "../../shared/notes/session-log-net.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import { kiroHome as resolveKiroHome, stateDir as stateDirOf } from "./paths.ts";
import { readSession } from "./session-store.ts";
import { option } from "../../shared/argv.ts";
import { safeId } from "./paths.ts";

/** The headless model the writer uses. */
export const WRITER_MODEL = process.env.COMPANION_AGENTS_WRITER_MODEL || "claude-haiku-4.5";
/** The tool-less agent the writer runs as. */
export const WRITER_AGENT = "ca-writer";
/** The writer's deadline. */
export const WRITER_TIMEOUT_MS = 180_000;

/** One saved writer job. */
export interface SessionLogPayload {
	session: string;
	notesDir: string;
	/** ISO time the session ended. */
	at: string;
	/** The Kiro home the adapter's state belongs to. */
	kiroHome: string;
	/** The Kiro executable the writer starts. */
	kiroCli: string;
	/** The entry file the writer targets. */
	entry: string;
	/** The prompt the writer model gets. */
	prompt: string;
}

/** The writer payload folder. */
export const sessionLogStateDir = (stateDir: string): string => join(stateDir, "session-log");

/** The payload file of a session. */
export const payloadFile = (stateDir: string, session: string): string => join(sessionLogStateDir(stateDir), `${safeId(session)}.json`);

/** The compaction summaries compact.ts kept, or "". */
function summariesText(stateDir: string, session: string): string {
	const file = join(stateDir, "compact", `${safeId(session)}.summaries.md`);
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * The writer payload for one session, or null when there is nothing to write
 * from or the session already has an entry.
 */
export function buildPayload(
	entries: Parameters<typeof sources>[0],
	notesDir: string,
	session: string,
	at: Date,
	kiroHome: string,
	kiroCli: string,
	summaries = "",
): SessionLogPayload | null {
	const yesterday = new Date(at);
	yesterday.setDate(at.getDate() - 1);
	if (findEntry(notesDir, session, [dayOf(at), dayOf(yesterday)])) return null;
	const material = sources(
		[...entries, ...(summaries.trim() === "" ? [] : [{ type: "compaction", summary: summaries }])],
		notesDir,
	);
	if (!hasMaterial(material)) return null;
	return {
		session,
		notesDir,
		at: at.toISOString(),
		kiroHome,
		kiroCli,
		entry: entryPath(notesDir, session, at),
		prompt: writerPrompt({ session, at: at.toISOString() }, material),
	};
}

/** Start the detached writer; the test injects a recorder instead. */
export type SpawnWriter = (command: string, args: string[]) => void;

/** The default spawn: detached, no stdio, and not waited on. */
export const detachedSpawn: SpawnWriter = (command, args) => {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
};

/** What a hook run did, for the tests and the debug log. */
export interface HookRun {
	payload: SessionLogPayload | null;
	spawned: boolean;
}

/** The SessionEnd hook body. */
export function runHook(
	input: { session_id?: unknown; cwd?: unknown; reason?: unknown },
	options: {
		home: string;
		kiroHome: string;
		kiroCli: string;
		now?: Date;
		spawn?: SpawnWriter;
		script?: string;
	},
): HookRun {
	const session = typeof input.session_id === "string" ? input.session_id : "";
	if (!session) return { payload: null, spawned: false };
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const at = options.now ?? new Date();
	const notesDir = projectDir(cwd, options.home);
	const stateDir = stateDirOf(options.kiroHome);
	const sessionFacts = readSession(options.kiroHome, session);
	const payload = buildPayload(
		sessionFacts?.entries ?? [],
		notesDir,
		session,
		at,
		options.kiroHome,
		options.kiroCli,
		summariesText(stateDir, session),
	);
	if (!payload) return { payload: null, spawned: false };
	mkdirSync(sessionLogStateDir(stateDir), { recursive: true });
	const file = payloadFile(stateDir, session);
	writeFileSync(file, `${JSON.stringify(payload)}\n`);
	const script = options.script ?? fileURLToPath(import.meta.url);
	const args = ["--experimental-strip-types", "--no-warnings", script, "write", file, `--kiro-cli=${options.kiroCli}`];
	(options.spawn ?? detachedSpawn)(process.execPath, args);
	return { payload, spawned: true };
}

/**
 * The detached writer: run the writer model and save its entry if the session
 * still has none. A failure is silent; an entry is a convenience.
 */
export function writeEntry(file: string, options: { kiroCli?: string } = {}): boolean {
	let payload: SessionLogPayload;
	try {
		payload = JSON.parse(readFileSync(file, "utf8")) as SessionLogPayload;
	} catch {
		return false;
	}
	try {
		if (existsSync(payload.entry)) return false;
		const run = spawnSync(payload.kiroCli || options.kiroCli || "kiro-cli", ["chat", "--agent", WRITER_AGENT, "--no-interactive", "--model", WRITER_MODEL, payload.prompt], {
			encoding: "utf8",
			timeout: WRITER_TIMEOUT_MS,
		});
		const entry = (run.stdout ?? "").trim();
		if (run.status !== 0 || !entry.startsWith("#")) return false;
		mkdirSync(dirname(payload.entry), { recursive: true });
		if (!existsSync(payload.entry)) writeFileSync(payload.entry, `${entry}\n`);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(file, { force: true });
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const mode = process.argv[2];
	if (mode === "hook") {
		const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: unknown; cwd?: unknown; reason?: unknown };
		const home = option("home", process.argv) ?? homedir();
		runHook(input, {
			home,
			kiroHome: option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home),
			kiroCli: option("kiro-cli", process.argv) ?? "kiro-cli",
		});
	} else if (mode === "write" && process.argv[3]) {
		writeEntry(process.argv[3], { kiroCli: option("kiro-cli", process.argv) });
	}
}
