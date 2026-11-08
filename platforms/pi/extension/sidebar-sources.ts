/**
 * Sidebar disk readers — impure.
 *
 * Reads `mcp.json`, one study `status.md`, and one study's brief folder for the
 * collector in `sidebar-data.ts`. This module holds no state and no timers. A
 * missing file, a missing folder, or a throwing read gives a defined default,
 * never an error.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	parseStatusFile,
	pickActiveStudy,
	sortBriefNames,
	type StudyEntry,
	type StudyFields,
} from "./study-status.ts";

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

/** One study folder's brief names, sorted. A missing folder gives `[]`. */
function readBriefNames(briefsDir: string): string[] {
	try {
		const names = readdirSync(briefsDir).filter(
			(name) => isSafeName(name) && name.endsWith(".md"),
		);
		return sortBriefNames(names);
	} catch {
		/* a missing briefs folder is not an error */
		return [];
	}
}

/** One active study and its brief names, read from the notes tree. */
export interface ActiveStudyRead {
	study: StudyEntry | null;
	briefs: string[];
}

/**
 * Read the studies tree under `studiesRoot`. `isSafeName` keeps every joined
 * name inside the tree; a symbolic link inside the tree is still followed. A
 * missing tree, a missing `status.md`, or a throwing read gives an empty read.
 */
export function readActiveStudy(studiesRoot: string): ActiveStudyRead {
	const entries: StudyEntry[] = [];
	try {
		const names = readdirSync(studiesRoot, { withFileTypes: true })
			.filter((dirent) => dirent.isDirectory() && isSafeName(dirent.name))
			.map((dirent) => dirent.name)
			.sort();
		for (const name of names) {
			entries.push({
				folder: name,
				fields: readStatusFields(join(studiesRoot, name, "status.md")),
			});
		}
	} catch {
		return { study: null, briefs: [] };
	}
	const study = pickActiveStudy(entries);
	if (!study) return { study: null, briefs: [] };
	return { study, briefs: readBriefNames(join(studiesRoot, study.folder, "briefs")) };
}
