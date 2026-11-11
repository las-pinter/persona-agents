/**
 * One column line, fitted to the width — pure.
 *
 * A renderer clips a line to the width and never pads it. The compositor pads
 * the clipped line to the column width. Both rules live here, so the clip and
 * the wide-char guard have one owner, and the compositor never imports a
 * renderer.
 *
 * `sidebar-line.test.ts` runs under plain Node (type stripping).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Clip one line to `width`, no pad. Never returns a line wider than `width`. */
export function clipLine(line: string, width: number): string {
	const w = Math.max(0, Math.floor(width));
	if (w <= 0) return "";
	const clipped = truncateToWidth(line, w, "…", false);
	// A wide char at the boundary can still overflow. Drop it if so.
	return visibleWidth(clipped) > w ? truncateToWidth(clipped, w, "", false) : clipped;
}

/**
 * Fit one line to exactly `width` cells: clip a wider line, then pad the rest
 * with spaces. The clip above can return a narrow line when it drops a wide
 * char at the boundary, so the pad measures the result it gets.
 */
export function padLine(line: string, width: number): string {
	const w = Math.max(0, Math.floor(width));
	const safe = typeof line === "string" ? line : String(line ?? "");
	const clipped = clipLine(safe, w);
	const visible = visibleWidth(clipped);
	return visible < w ? clipped + " ".repeat(w - visible) : clipped;
}
