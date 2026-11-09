/**
 * Tree selection — pure.
 *
 * Moves the keyboard selection along the node id list the tree overlay paints.
 * No fs, no timer, no pi runtime import.
 */

/** Move the selection down one id and wrap. An unknown current selects the first. */
export function selectNext(ids: string[], current: string | null): string | null {
	if (ids.length === 0) return current;
	const index = current === null ? -1 : ids.indexOf(current);
	if (index < 0) return ids[0];
	return ids[(index + 1) % ids.length];
}

/** Move the selection up one id and wrap. An unknown current selects the last. */
export function selectPrev(ids: string[], current: string | null): string | null {
	if (ids.length === 0) return current;
	const index = current === null ? -1 : ids.indexOf(current);
	if (index < 0) return ids[ids.length - 1];
	return ids[(index - 1 + ids.length) % ids.length];
}
