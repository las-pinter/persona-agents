/**
 * Column viewport window — pure.
 *
 * The sidebar column is as tall as its content, and the terminal shows one
 * window of it. One scroll offset selects that window. A line hidden above or
 * below the window is counted in a dim mark, so a line never leaves the column
 * without a mark.
 *
 * `sidebar-window.test.ts` runs under plain Node (type stripping).
 */

/**
 * The lead of every viewport mark. The words after the count belong to the
 * viewport, so a mark here never reads the same as a panel overflow mark.
 */
const MARK_PREFIX = "… +";

/**
 * The fewest rows a marked window needs. Mid-window, two rows carry the top
 * mark and the bottom mark and no body row. At either end one body row shows
 * between the single mark and the edge. A one-row window paints one mark and
 * no body, so it is below the floor and `windowLines` paints nothing there.
 */
export const MIN_WINDOW_ROWS = 2;

/** The mark for the lines hidden above the window. */
export function aboveMark(count: number): string {
	return `${MARK_PREFIX}${Math.max(0, Math.floor(count))} above`;
}

/** The mark for the lines hidden below the window. */
export function belowMark(count: number): string {
	return `${MARK_PREFIX}${Math.max(0, Math.floor(count))} below`;
}

/**
 * The largest offset that still paints the last line. A column that fits the
 * window has no scroll range: a press must not hide a line to show a mark.
 * A taller column keeps the mark row, so the body is one row shorter than the
 * window.
 */
export function scrollLimit(total: number, visible: number): number {
	const rows = Math.max(1, Math.floor(visible));
	const lines = Math.max(0, Math.floor(total));
	if (lines <= rows) return 0;
	return Math.max(0, lines - (rows - 1));
}

/** Clamp one offset to the window range: zero at the top, the last line at the end. */
export function clampScrollOffset(offset: number, total: number, visible: number): number {
	const value = Number.isFinite(offset) ? Math.floor(offset) : 0;
	return Math.min(Math.max(0, value), scrollLimit(total, visible));
}

/**
 * One window of `lines`, `visible` rows tall, top mark first and bottom mark
 * last. A window that holds every line returns the lines with no mark. A mark
 * line takes the place of a body row, so the body shrinks by one per mark. A
 * window below the row floor paints nothing, so no line leaves without a mark.
 */
export function windowLines(
	lines: string[],
	offset: number,
	visible: number,
	dim: (text: string) => string = (text) => text,
): string[] {
	const rows = Math.max(0, Math.floor(visible));
	if (rows < MIN_WINDOW_ROWS) return [];
	const total = lines.length;
	const start = clampScrollOffset(offset, total, rows);
	const above = start > 0 ? 1 : 0;
	let body = rows - above;
	let end = Math.min(start + body, total);
	const below = end < total && body >= 1 ? 1 : 0;
	body -= below;
	end = start + body;

	const out: string[] = [];
	if (above > 0) out.push(dim(aboveMark(start)));
	out.push(...lines.slice(start, end));
	if (below > 0) out.push(dim(belowMark(total - end)));
	return out;
}
