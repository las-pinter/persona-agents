/**
 * Turn cap for one child run.
 *
 * The count is `RunRecord.turns` and `usage.turns`, both moved once per
 * assistant message end. This module owns only the decisions: the accepted
 * range, the one steer, the grace window, the single abort, and the caller text.
 * It keeps no state and imports no runtime, so a test needs no session.
 */

/** The turn cap for one child run when the call names none. */
export const DEFAULT_MAX_TURNS = 40;
/** The lowest accepted turn cap. */
export const MIN_MAX_TURNS = 1;
/** The highest accepted turn cap. */
export const MAX_MAX_TURNS = 400;
/** The turns a steered child gets to wrap up before the abort. */
export const TURN_GRACE = 5;
/** The one steer message a capped child receives. */
export const TURN_CAP_STEER = "Turn cap reached. Stop new work and write your final summary now.";

/** A resolved cap, or the refusal text for a value outside the range. */
export type MaxTurnsCheck = { ok: true; maxTurns: number } | { ok: false; error: string };

/** The refusal for a value outside the accepted range. It names the range. */
function maxTurnsRefusal(value: number): string {
	return `maxTurns must be a whole number from ${MIN_MAX_TURNS} to ${MAX_MAX_TURNS}; got ${value}.`;
}

/** Resolve the cap of one call. Absent means the default; out of range refuses. */
export function resolveMaxTurns(value: number | undefined): MaxTurnsCheck {
	if (value === undefined) return { ok: true, maxTurns: DEFAULT_MAX_TURNS };
	if (!Number.isInteger(value) || value < MIN_MAX_TURNS || value > MAX_MAX_TURNS) {
		return { ok: false, error: maxTurnsRefusal(value) };
	}
	return { ok: true, maxTurns: value };
}

/** What one assistant turn asks the runner to do. */
export type TurnCapAction = "none" | "steer" | "abort";

/**
 * Decide the action for one assistant turn.
 *
 * The steer fires on the cap turn. The grace window is the next `TURN_GRACE`
 * turns. The turn after the window aborts. The caller sends the steer once, so
 * a repeated `steer` here never happens.
 */
export function turnCapAction(turns: number, maxTurns: number, steered: boolean): TurnCapAction {
	if (turns < maxTurns) return "none";
	if (!steered) return "steer";
	return turns > maxTurns + TURN_GRACE ? "abort" : "none";
}

/** The caller-facing line for a capped run, with the real numbers in place. */
export function cappedTurnText(turns: number | undefined, maxTurns: number | undefined): string {
	const grace = `${TURN_GRACE} grace) - partial output follows`;
	// A capped source with no usage carries no honest count, so the line names none.
	if (turns === undefined) return `capped (${grace}`;
	const count = maxTurns === undefined ? `turns ${turns} (capped` : `turns ${turns}/${maxTurns} (capped`;
	return `${count}, ${grace}`;
}
