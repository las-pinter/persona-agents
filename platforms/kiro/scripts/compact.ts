/**
 * Kiro's compaction hooks: what must survive a summary.
 *
 *   compact.ts pre    PreCompact: read the session store, save a reload
 *                     manifest, and print guidance for Kiro's summarizer.
 *   compact.ts post   PostCompact: keep the summary, append a metrics line,
 *                     and print the reload list (Kiro adds it to the
 *                     conversation).
 *
 * The manifest is built from the V3 session store: the skills the session
 * loaded (`load_resource`), the task notes file it wrote last, and the
 * documents it read (the project rules and summary, the linked study, the
 * pinned paths). Working source files are not reloaded.
 *
 * State lives in `<payload>/state/compact/`:
 *   <session>.json           the reload manifest
 *   <session>.summaries.md   every compact summary of the session
 *   metrics.ndjson           one line per compaction, read by the retro
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildManifest,
	reloadContext,
	summaryInstructions,
	type Manifest,
} from "../../shared/compaction/manifest.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import { readSession } from "./session-store.ts";
import { kiroHome as resolveKiroHome, stateDir as stateDirOf } from "./paths.ts";
import { option } from "./argv.ts";
import { safeId } from "./paths.ts";

/** One saved compaction. */
export interface CompactionState {
	session: string;
	at: string;
	manifest: Manifest;
}

/** The compaction state folder. */
export const compactDir = (stateDir: string): string => join(stateDir, "compact");

/** The manifest file of a session. */
export const manifestFile = (stateDir: string, session: string): string => join(compactDir(stateDir), `${safeId(session)}.json`);

/** The summaries file of a session. */
export const summariesFile = (stateDir: string, session: string): string => join(compactDir(stateDir), `${safeId(session)}.summaries.md`);

/** The metrics file. */
export const metricsFile = (stateDir: string): string => join(compactDir(stateDir), "metrics.ndjson");

/** The manifest for a session, rebuilt from the store when no state exists. */
function manifestFor(kiroHome: string, sessionId: string, notesDir: string, stateDir: string): Manifest {
	const file = manifestFile(stateDir, sessionId);
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CompactionState>;
			if (parsed?.manifest && typeof parsed.manifest === "object") return parsed.manifest as Manifest;
		} catch {
			// A bad state file is not worth a failed compaction; rebuild it.
		}
	}
	const session = readSession(kiroHome, sessionId);
	return buildManifest(session?.entries ?? [], notesDir, sessionId);
}

/** Save the manifest and return the summarizer guidance. */
export function prepareCompaction(
	kiroHome: string,
	cwd: string,
	home: string,
	sessionId: string,
	now: Date = new Date(),
): { manifest: Manifest; instructions: string } {
	const notesDir = projectDir(cwd, home);
	const session = readSession(kiroHome, sessionId);
	const manifest = buildManifest(session?.entries ?? [], notesDir, sessionId);
	const stateDir = stateDirOf(kiroHome);
	mkdirSync(compactDir(stateDir), { recursive: true });
	const state: CompactionState = { session: sessionId, at: now.toISOString(), manifest };
	writeFileSync(manifestFile(stateDir, sessionId), `${JSON.stringify(state, null, 2)}\n`);
	return { manifest, instructions: summaryInstructions(manifest) };
}

/** The reload text for a manifest, with the Kiro skill-loading line. */
export function kiroReloadText(manifest: Manifest): string {
	return [
		reloadContext(manifest),
		"",
		"On Kiro, load a listed skill with the `load_resource` tool: `{\"id\": \"skill::<name>\"}`.",
	].join("\n");
}

/**
 * Keep the summary, write one metrics line, and return the reload list.
 *
 * `summary` and `summaryPath` come from the PostCompact event. A missing
 * summary is not an error: the manifest still names the files to reload.
 */
export function finishCompaction(
	kiroHome: string,
	cwd: string,
	home: string,
	sessionId: string,
	input: { summary?: string; summaryPath?: string; trigger?: string; contextUsage?: number | null },
	now: Date = new Date(),
): { reload: string } {
	const stateDir = stateDirOf(kiroHome);
	const notesDir = projectDir(cwd, home);
	const manifest = manifestFor(kiroHome, sessionId, notesDir, stateDir);
	mkdirSync(compactDir(stateDir), { recursive: true });
	if (input.summary && input.summary.trim() !== "") {
		appendFileSync(summariesFile(stateDir, sessionId), `\n## ${now.toISOString()} (${input.trigger ?? "compaction"})\n\n${input.summary.trim()}\n`);
	}
	appendFileSync(
		metricsFile(stateDir),
		`${JSON.stringify({
			at: now.toISOString(),
			session: sessionId,
			trigger: input.trigger ?? null,
			summaryPath: input.summaryPath ?? null,
			skills: manifest.skills.length,
			docs: manifest.docs.length,
			contextUsage: input.contextUsage ?? null,
		})}\n`,
	);
	return { reload: kiroReloadText(manifest) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const input = JSON.parse(readFileSync(0, "utf8")) as {
		session_id?: unknown;
		cwd?: unknown;
		summary?: unknown;
		summary_path?: unknown;
		trigger?: unknown;
	};
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	if (sessionId) {
		const home = option("home", process.argv) ?? homedir();
		const kiro = option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home);
		const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
		if (process.argv[2] === "pre") {
			const { instructions } = prepareCompaction(kiro, cwd, home, sessionId);
			process.stdout.write(`${instructions}\n`);
		} else if (process.argv[2] === "post") {
			const session = readSession(kiro, sessionId);
			const { reload } = finishCompaction(kiro, cwd, home, sessionId, {
				summary: typeof input.summary === "string" ? input.summary : undefined,
				summaryPath: typeof input.summary_path === "string" ? input.summary_path : undefined,
				trigger: typeof input.trigger === "string" ? input.trigger : undefined,
				contextUsage: session?.contextUsage ?? null,
			});
			process.stdout.write(`${reload}\n`);
		}
	}
}
