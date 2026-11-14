/**
 * Sidebar data guards — pure.
 *
 * Every callback and timer body in the sidebar data modules runs through one of
 * these two guards, so a bad API call never crashes the TUI.
 */

/** Run a callback and swallow every error. */
export function guard(fn: () => void): void {
	try {
		fn();
	} catch {
		/* a panel must never crash pi */
	}
}

/** Run an async callback and swallow every error. */
export function guardAsync(fn: () => Promise<void>): void {
	void (async () => {
		try {
			await fn();
		} catch {
			/* a panel must never crash pi */
		}
	})();
}
