/**
 * Sidebar disk readers — impure.
 *
 * Reads `mcp.json` and the study folders for the collector in
 * `sidebar-data.ts`. This module holds no state and no timers. A missing file,
 * a missing folder, or a throwing read gives a defined default, never an error.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseStatusFile, studySlug, type StudyFields, type StudyRow } from "./study-status.ts";

/** The study folder that holds archived studies. The panel never lists it. */
const ARCHIVED_STUDIES = "legacy_studies";

/** The agent directory's `mcp.json`, guarded against a missing helper. */
export function resolveMcpJsonPath(): string {
	try {
		return join(getAgentDir(), "mcp.json");
	} catch {
		return join(homedir(), ".pi", "agent", "mcp.json");
	}
}

/** Server names from `mcp.json`. A missing or bad file gives `[]`. */
export function readMcpJsonServers(filePath: string): string[] {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return [];
		const servers = (parsed as { mcpServers?: unknown }).mcpServers;
		if (typeof servers !== "object" || servers === null) return [];
		return Object.keys(servers as Record<string, unknown>);
	} catch {
		/* missing or malformed mcp.json is not an error */
		return [];
	}
}

/** A name that cannot escape its parent folder: no separator and no dot word. */
export function isSafeName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

/** Read and parse one `status.md`. A missing or malformed file gives `null`. */
function readStatusFields(filePath: string): StudyFields | null {
	try {
		return parseStatusFile(readFileSync(filePath, "utf8"));
	} catch {
		/* a missing status.md is not an error */
		return null;
	}
}

/** Count the brief files under `briefsDir`. A missing folder gives 0. */
function countBriefs(briefsDir: string): number {
	try {
		return readdirSync(briefsDir).filter(
			(name) => isSafeName(name) && name.endsWith(".md"),
		).length;
	} catch {
		/* a missing briefs folder is not an error */
		return 0;
	}
}

/**
 * Read every study folder under `studiesRoot`. The archived folder is skipped.
 * A folder with no `status.md` is not a study. `isSafeName` keeps every joined
 * name inside the tree. A missing tree or a throwing read gives `[]`.
 */
export function readStudies(studiesRoot: string): StudyRow[] {
	const rows: StudyRow[] = [];
	try {
		const names = readdirSync(studiesRoot, { withFileTypes: true })
			.filter(
				(dirent) =>
					dirent.isDirectory() &&
					isSafeName(dirent.name) &&
					dirent.name !== ARCHIVED_STUDIES,
			)
			.map((dirent) => dirent.name)
			.sort();
		for (const folder of names) {
			const fields = readStatusFields(join(studiesRoot, folder, "status.md"));
			if (!fields) continue;
			rows.push({
				folder,
				name: studySlug(folder),
				stage: fields.stage,
				briefs: countBriefs(join(studiesRoot, folder, "briefs")),
				updated: fields.updated,
			});
		}
	} catch {
		return [];
	}
	return rows;
}
