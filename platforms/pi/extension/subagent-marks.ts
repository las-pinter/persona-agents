/**
 * The round mark and the resume glyph, shared by the card and the tree line.
 *
 * One rule keeps the two marks apart on both surfaces.
 */

/** The two fields a mark source carries. Both are optional on the tree node. */
export interface MarkSource {
	round?: number;
	resumed?: boolean;
}

/**
 * The mark text: the round first, then the resume glyph.
 *
 * A round mark leads with one space. A resume mark with no round takes a space
 * of its own, so the glyph never touches the text before it.
 */
export function roundMark(source: MarkSource): string {
	const roundText = typeof source.round === "number" ? ` r${source.round}` : "";
	const resumeText = source.resumed === true ? `${roundText ? "" : " "}↺` : "";
	return `${roundText}${resumeText}`;
}
