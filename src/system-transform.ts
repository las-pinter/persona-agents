import { parseAgentFromStubComment, loadSinglePrompt } from './agent-registry.js';

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
 */
export function createSystemTransformHandler(configRoot: string) {
  // Track which agent markers have been injected per session
  // sessionID → Set<marker_string>
  const injected = new Map<string, Set<string>>();

  return async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] }
  ): Promise<void> => {
    const sessionKey = input.sessionID ?? '__nosession__';

    // Get or create the set of already-injected markers for this session
    let sessionInjected = injected.get(sessionKey);
    if (!sessionInjected) {
      sessionInjected = new Set<string>();
      injected.set(sessionKey, sessionInjected);
    }

    // Scan each entry in output.system for stub markers
    for (let i = 0; i < output.system.length; i++) {
      const entry = output.system[i];
      const identity = parseAgentFromStubComment(entry);

      if (!identity) continue; // Not a stub marker, skip

      const marker = `<!-- persona-agents:${identity.theme}-${identity.profession}:${identity.personaFile} -->`;

      // Check dedup: skip if already injected for this session+agent
      if (sessionInjected.has(marker)) continue;

      // Load the prompt ON DEMAND from disk
      const content = loadSinglePrompt(configRoot, identity);
      if (!content) {
        // Files not found — leave the stub visible as a misconfiguration signal
        continue;
      }

      // Replace the stub marker with the real prompt content
      // Keep the marker at the start for dedup visibility on subsequent hook calls
      output.system[i] = marker + '\n' + content;

      // Mark as injected for this session
      sessionInjected.add(marker);
    }

    // Limit memory: clean up old sessions if tracking too many
    // (keep max 100 sessions tracked)
    if (injected.size > 100) {
      const oldestKey = injected.keys().next().value;
      if (oldestKey !== undefined) {
        injected.delete(oldestKey);
      }
    }
  };
}
