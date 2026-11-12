/**
 * The pi session id of one context.
 *
 * Every caller reads the id here, so the gate and the ask record cannot
 * disagree. A manager that throws, or a context with none, gives null: a lost
 * id must never block a tool call.
 */

/** What the reader needs from a context: an optional manager with an optional read. */
export interface SessionIdContext {
	sessionManager?: { getSessionId?: () => string } | undefined;
}

/** The session id, or null when the context cannot supply one. */
export function sessionIdOf(ctx: SessionIdContext | undefined | null): string | null {
	try {
		return ctx?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

/** The parent session id. An alias, so the spawn site reads as the value it passes. */
export function parentSessionIdOf(ctx: SessionIdContext | undefined | null): string | null {
	return sessionIdOf(ctx);
}
