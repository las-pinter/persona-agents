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
 * Dedup is tracked per session to prevent re-injection on repeated
 * hook calls (each LLM call triggers this hook).
 *
 * @param configRoot - The OpenCode config root directory
 * @param log - Optional logger (defaults to silentLogger)
 */
export function createSystemTransformHandler(
  configRoot: string,
  log: Logger = silentLogger
) {
  // Track which agent markers have been injected per session
  // sessionID → Set<marker_string>
  const injected = new Map<string, Set<string>>();

  return async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] }
  ): Promise<void> => {
    const sessionKey = input.sessionID ?? '__nosession__';
    log.debug('transform called: sessionKey=' + sessionKey + ' systemCount=' + output.system.length);

    // Get or create the set of already-injected markers for this session
    let sessionInjected = injected.get(sessionKey);
    if (!sessionInjected) {
      sessionInjected = new Set<string>();
      injected.set(sessionKey, sessionInjected);
      log.debug('transform: new session, injected set created');
    } else {
      log.debug('transform: existing session, injected.size=' + sessionInjected.size);
    }

    // Scan each entry in output.system for stub markers
    for (let i = 0; i < output.system.length; i++) {
      const entry = output.system[i];
      log.debug('transform: entry[' + i + '] type=' + typeof entry + ' length=' + (entry ? entry.length : 0));
      const identity = parseAgentFromStubComment(entry, log);

      if (!identity) {
        log.debug('transform: entry[' + i + '] no identity parsed, skipping');
        continue;
      }

      const marker = `<!-- persona-agents:${identity.theme}-${identity.profession}:${identity.personaFile} -->`;
      log.info('transform: found identity, marker=' + marker);

      // Check dedup: skip if already injected for this session+agent
      if (sessionInjected.has(marker)) {
        log.debug('transform: marker already injected this session, skipping');
        continue;
      }

      // Load the prompt ON DEMAND from disk
      const content = loadSinglePrompt(configRoot, identity, log);
      if (!content) {
        log.warn('transform: loadSinglePrompt returned null for identity, skipping');
        // Files not found — leave the stub visible as a misconfiguration signal
        continue;
      }

      // Replace the stub marker with the real prompt content
      // Keep the marker at the start for dedup visibility on subsequent hook calls
      output.system[i] = marker + '\n' + content;
      log.info('transform: REPLACED entry[' + i + '] with marker + content (total length=' + (marker.length + 1 + content.length) + ')');

      // Mark as injected for this session
      sessionInjected.add(marker);
      log.debug('transform: added marker to sessionInjected, now size=' + sessionInjected.size);
    }

    // Limit memory: clean up old sessions if tracking too many
    // (keep max 100 sessions tracked)
    if (injected.size > 100) {
      const oldestKey = injected.keys().next().value;
      if (oldestKey !== undefined) {
        injected.delete(oldestKey);
        log.info('transform: evicted oldest session key');
      }
    }

    log.debug('transform: done');
  };
}
