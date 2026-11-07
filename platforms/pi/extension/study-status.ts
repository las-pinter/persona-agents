/**
 * Study status parsing — pure.
 *
 * Reads the `status.md` fields and picks the study the STATUS panel shows. No
 * fs and no pi import, so a test drives the helpers alone. It reads three
 * fields only: `Stage`, `Updated`, and `Next action`; the other status lines
 * are ignored.
 *
 * A missing file and a malformed field both fall back to `null`, never an error.
 */

/** One `status.md` field set. A field that is absent or empty is `null`. */
export interface StudyFields {
	stage: string | null;
	updated: string | null;
	nextAction: string | null;
}

/** One study folder and its parsed fields. A missing `status.md` has `null`. */
export interface StudyEntry {
	folder: string;
	fields: StudyFields | null;
}

/** The bold field lines the `status.md` format defines. */
const FIELD_RE = /^\s*-\s*\*\*(Stage|Updated|Next action):\*\*\s*(.*)$/i;

/** Stages that stop a study from being the active one. */
const CLOSED_STAGES = new Set(["done", "abandoned"]);

/** Trim one field value; an empty value is absent. */
function valueOrNull(raw: string): string | null {
	const value = raw.trim();
	return value.length > 0 ? value : null;
}

/**
 * Parse the bold `Stage`, `Updated`, and `Next action` lines from a
 * `status.md`. Return `null` when both `Stage` and `Updated` are absent, which
 * marks a text that does not carry the status shape.
 */
export function parseStatusFile(raw: string): StudyFields | null {
	const fields: StudyFields = { stage: null, updated: null, nextAction: null };
	for (const line of raw.split("\n")) {
		const match = FIELD_RE.exec(line);
		if (!match) continue;
		const value = valueOrNull(match[2] ?? "");
		switch (match[1]?.toLowerCase()) {
			case "stage":
				fields.stage = value;
				break;
			case "updated":
				fields.updated = value;
				break;
			default:
				fields.nextAction = value;
		}
	}
	return fields.stage === null && fields.updated === null ? null : fields;
}

/** The `Updated` value, or an empty string when the field is absent. */
function updatedKey(entry: StudyEntry): string {
	return entry.fields?.updated ?? "";
}

/**
 * Pick the active study: the newest `Updated` whose stage is open. When no
 * study is open, return the newest by `Updated`. A folder with no status file
 * is not a candidate. An empty list gives `null`.
 */
export function pickActiveStudy(entries: StudyEntry[]): StudyEntry | null {
	const known = entries.filter((entry) => entry.fields !== null);
	if (known.length === 0) return null;
	const open = known.filter((entry) => {
		const stage = entry.fields?.stage?.toLowerCase();
		return !stage || !CLOSED_STAGES.has(stage);
	});
	const pool = open.length > 0 ? open : known;
	let best = pool[0] ?? null;
	for (const entry of pool) {
		if (best === null || updatedKey(entry) > updatedKey(best)) best = entry;
	}
	return best;
}

/** Drop a leading `YYYY-MM-DD-` segment from a study folder name. */
export function studySlug(folder: string): string {
	return folder.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

/** Return the brief names in one stable order, so the list does not move. */
export function sortBriefNames(names: string[]): string[] {
	return names.slice().sort();
}
