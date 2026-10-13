/**
 * Shared display formatting for durations and token counts.
 *
 * Values up to 999 ms print as whole milliseconds. Larger values keep the
 * existing pi-core second/minute/hour form.
 */

/** Format a duration: whole ms under 1 s, else one decimal second up to a minute. */
export function formatDuration(durationMs: number): string {
	if (durationMs <= 999) return `${Math.round(durationMs)}ms`;

	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Compact token count: 999, 1.5k, 12k, 1.0M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) {
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		const thousands = Math.round(count / 1000);
		// A value that would round to 1000k must roll up to M.
		if (thousands < 1000) return `${thousands}k`;
	}
	return `${(count / 1000000).toFixed(1)}M`;
}
