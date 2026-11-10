/**
 * Study status parsing and the panel's study list — pure.
 *
 * Reads the `status.md` stage and updated fields and picks the studies the
 * STUDY STATUS panel shows. No fs and no pi import, so a test drives the
 * helpers alone.
 *
 * A missing file and a malformed field both fall back to `null`, never an error.
 */

/** One `status.md` field set. A field that is absent or empty is `null`. */
export interface StudyFields {
	stage: string | null;
	updated: string | null;
}

/** One study row the panel can show. */
export interface StudyRow {
	/** Folder name, with its `YYYY-MM-DD-` prefix. */
	folder: string;
	/** Folder name with the date prefix dropped. */
	name: string;
	stage: string | null;
	/** Number of brief files under the study's `briefs/` folder. */
	briefs: number;
	/** The `Updated` field, or `null` when it is absent. */
	updated: string | null;
}

/** The bold field lines the `status.md` format defines. */
const FIELD_RE = /^\s*-\s*\*\*(Stage|Updated):\*\*\s*(.*)$/i;

/** Stages that stop a study from showing on the panel. */
const CLOSED_STAGES = new Set(["done", "abandoned"]);

/** Trim one field value; an empty value is absent. */
function valueOrNull(raw: string): string | null {
	const value = raw.trim();
	return value.length > 0 ? value : null;
}

/**
 * Parse the bold `Stage` and `Updated` lines from a `status.md`. Return `null`
 * when both are absent, which marks a text that does not carry the status shape.
 */
export function parseStatusFile(raw: string): StudyFields | null {
	const fields: StudyFields = { stage: null, updated: null };
	for (const line of raw.split("\n")) {
		const match = FIELD_RE.exec(line);
		if (!match) continue;
		const value = valueOrNull(match[2] ?? "");
		if (match[1]?.toLowerCase() === "stage") fields.stage = value;
		else fields.updated = value;
	}
	return fields.stage === null && fields.updated === null ? null : fields;
}

/** True for a stage the panel keeps off the list: `done` or `abandoned`. */
export function isClosedStage(stage: string | null): boolean {
	// An absent or unknown stage counts as open, so a half-written study shows.
	return stage !== null && CLOSED_STAGES.has(stage.toLowerCase());
}

/** Newest `Updated` first; a missing date sorts last. */
function newestFirst(left: StudyRow, right: StudyRow): number {
	const a = left.updated ?? "";
	const b = right.updated ?? "";
	if (a !== b) return a < b ? 1 : -1;
	if (left.folder === right.folder) return 0;
	return left.folder < right.folder ? 1 : -1;
}

/**
 * Keep the studies the panel paints: every open study, and a closed study that
 * was open earlier in this process. `seen` carries the open names across polls,
 * so a fresh set after a restart drops every closed study. Newest first.
 */
export function visibleStudies(rows: StudyRow[], seen: Set<string>): StudyRow[] {
	const kept: StudyRow[] = [];
	for (const row of rows) {
		if (isClosedStage(row.stage)) {
			if (!seen.has(row.name)) continue;
		} else {
			seen.add(row.name);
		}
		kept.push(row);
	}
	return kept.sort(newestFirst);
}

/** Drop a leading `YYYY-MM-DD-` segment from a study folder name. */
export function studySlug(folder: string): string {
	return folder.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}
