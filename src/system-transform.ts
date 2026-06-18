import { parseAgentFromStubComment, loadSinglePrompt } from './agent-registry.js';
import type { Logger } from './types.js';
import { silentLogger } from './types.js';

/**
 * Create a handler for the experimental.chat.system.transform hook.
 *
 * The handler scans output.system for stub markers like
 * "<!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->"
 * and replaces them with the actual assembled prompt content
 * (profession.md + persona.md).
 *
 * Prompts are loaded ON DEMAND — only when a marker is encountered.
 * The configRoot tells the handler where to find the resource files.
 *
 * No dedup is needed because the marker is fully replaced on first
 * match — if the system prompt is reconstructed fresh each call,
 * the replacement happens again harmlessly. If it persists, the
 * marker simply isn't there to match.
 *
 * @param configRoot - The OpenCode config root directory
 * @param log - Optional logger (defaults to silentLogger)
 */
export function createSystemTransformHandler(
  configRoot: string,
  log: Logger = silentLogger
) {
  return async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] }
  ): Promise<void> => {
    log.debug('transform called: systemCount=' + output.system.length);

    // Scan each entry in output.system for stub markers
    for (let i = 0; i < output.system.length; i++) {
      const entry = output.system[i];
      const identity = parseAgentFromStubComment(entry, log);

      if (!identity) {
        continue;
      }

      log.info('transform: found identity, theme=' + identity.theme +
        ' profession=' + identity.profession + ' personaFile=' + identity.personaFile);

      // Load the prompt ON DEMAND from disk
      const content = loadSinglePrompt(configRoot, identity, log);
      if (!content) {
        log.warn('transform: loadSinglePrompt returned null — leaving stub visible as misconfiguration signal');
        continue;
      }

      // Fully replace the stub marker with the assembled prompt content.
      // No marker is kept — if the system prompt is reconstructed fresh
      // on the next LLM call, the replacement runs again harmlessly.
      output.system[i] = content;
      log.info('transform: REPLACED entry[' + i + '] with content (length=' + content.length + ')');
    }

    log.debug('transform: done');
  };
}
