import type { SessionContext } from '@opencode/plugin/promise/session';
import { parseAgentFromStubComment, loadSinglePrompt } from './agent-registry.js';
import type { Logger } from './types.js';
import { silentLogger } from './types.js';

/**
 * Create a handler for the V2 `ctx.session.hook("context", ...)` hook.
 *
 * The handler scans event.system for stub markers like
 * "<!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->"
 * and replaces them with the actual assembled prompt content
 * (profession.md + persona.md).
 *
 * Prompts are loaded ON DEMAND — only when a marker is encountered.
 * The configRoot tells the handler where to find the resource files.
 *
 * V2 hook shape vs V1 (experimental.chat.system.transform):
 * - V1 passed (input, output) with output.system: string[]
 * - V2 passes a single mutable event whose system: Array<SystemPart>, so the
 *   marker lives in part.text and we swap in a fresh text part at the same
 *   position. (SystemPart fields are readonly; stub parts carry no useful
 *   cache/metadata so replacing them wholesale is safe.)
 *
 * No dedup is needed because the marker is fully replaced on first match —
 * if the system prompt is reconstructed fresh each call, the replacement
 * happens again harmlessly. If it persists, the marker simply isn't there
 * to match.
 *
 * @param configRoot - The OpenCode config root directory
 * @param log - Optional logger (defaults to silentLogger)
 * @returns A synchronous handler for the V2 "context" hook
 */
export function createSystemTransformHandler(
  configRoot: string,
  log: Logger = silentLogger,
): (event: SessionContext) => void {
  return (event: SessionContext): void => {
    log.debug('context hook: systemCount=' + event.system.length);

    // Scan each system part for stub markers
    for (let i = 0; i < event.system.length; i++) {
      const part = event.system[i];
      const identity = parseAgentFromStubComment(part.text, log);

      if (!identity) {
        continue;
      }

      log.info('context hook: found identity, theme=' + identity.theme +
        ' profession=' + identity.profession + ' personaFile=' + identity.personaFile);

      // Load the prompt ON DEMAND from disk
      const content = loadSinglePrompt(configRoot, identity, log);
      if (!content) {
        log.warn('context hook: loadSinglePrompt returned null — leaving stub visible as misconfiguration signal');
        continue;
      }

      // Fully replace the stub marker with the assembled prompt content.
      // SystemPart fields are readonly, so we swap in a fresh text part at
      // the same position. No marker is kept — if the system prompt is
      // reconstructed fresh on the next LLM call, the replacement runs
      // again harmlessly.
      event.system[i] = { type: 'text', text: content };
      log.info('context hook: REPLACED part[' + i + '] with content (length=' + content.length + ')');
    }

    log.debug('context hook: done');
  };
}
