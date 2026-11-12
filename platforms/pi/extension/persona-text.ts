/**
 * Persona identity text: the one place a persona is named and announced.
 *
 * The root prompt and the child prompt carry the same block. One builder keeps
 * the two copies from drifting, because a child runs with no extension and
 * cannot use the root's own text.
 *
 * The label form has one builder too, so the status line, the notices, and the
 * records all show the same id.
 *
 * No pi runtime import and no resolver import: only the fields are read.
 */

/** The heading that opens the persona block. */
export const PERSONA_HEADING = "## PERSONA (MANDATORY VOICE)";

/**
 * The two rule lines under the heading: the persona wins over earlier plain
 * voice, and it holds until the persona changes.
 */
const PERSONA_RULES = [
	"Ignore any earlier plain-voice context. From now on you ARE the persona below.",
	"Adopt its speech patterns and role in every reply, until the persona changes.",
].join("\n");

/** The identity fields of a persona: what a label reads. */
export interface PersonaIdentity {
	readonly name: string;
	readonly theme?: string;
}

/** The identity fields plus the body: what a block reads. */
export interface PersonaText extends PersonaIdentity {
	readonly body: string;
}

/** The `theme/name` id, or the bare name when the persona names no theme. */
export function formatPersonaId(persona: PersonaIdentity): string {
	return persona.theme ? `${persona.theme}/${persona.name}` : persona.name;
}

/**
 * The label the status line, the notices, and the debug log show.
 *
 * A run record and the discovery map key call `formatPersonaId` instead: that
 * id is stored data, not screen text. Both entries stay, so a call site can
 * pass loose fields or a whole persona.
 */
export function personaLabel(theme: string | undefined, name: string): string {
	return formatPersonaId({ theme, name });
}

/**
 * The persona block: the heading, the two rules, and the persona body. Both the
 * root prompt and the child prompt append this as one unit.
 */
export function personaBlock(persona: PersonaText): string {
	return `\n\n${PERSONA_HEADING}\n${PERSONA_RULES}\n\n${persona.body}`;
}
