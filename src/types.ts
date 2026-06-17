/**
 * Parsed agent identity extracted from a stub comment marker.
 *
 * The stub format is:
 *   <!-- persona-agents:{theme}-{profession}:{personaFile} -->
 *
 * Example:
 *   <!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->
 */
export interface AgentIdentity {
  /** Agent theme, e.g. "goblin", "wh40k", "wh40kOrk" */
  theme: string;
  /** Agent profession, e.g. "orchestrator", "implementer" */
  profession: string;
  /** Persona filename, e.g. "bossnik-chief.md" (relative to personas/{theme}/) */
  personaFile: string;
}
