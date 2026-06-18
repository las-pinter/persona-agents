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

/**
 * Structured logger matching the OpenCode client.app.log() pattern.
 *
 * Fire-and-forget by default — logging never blocks the calling code.
 * All methods are void (not Promise) to keep hooks non-blocking.
 */
export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * No-op logger that silences all output.
 * Useful as default when no client logger is available.
 */
export const silentLogger: Logger = {
  debug() { /* noop */ },
  info() { /* noop */ },
  warn() { /* noop */ },
  error() { /* noop */ },
};
