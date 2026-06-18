import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentIdentity, Logger } from './types.js';
import { silentLogger } from './types.js';

/**
 * Assemble the system prompt for a single agent by reading
 * its profession.md and persona.md files from the config root.
 *
 * @param configRoot - The OpenCode config root (e.g. ~/.config/opencode/)
 * @param identity - The agent identity (theme, profession, personaFile from stub)
 * @param log - Optional logger (defaults to silentLogger)
 * @returns The concatenated prompt string, or null if files are missing
 */
export function loadSinglePrompt(
  configRoot: string,
  identity: AgentIdentity,
  log: Logger = silentLogger
): string | null {
  const { theme, profession, personaFile } = identity;

  // Read profession.md
  const professionPath = join(configRoot, 'professions', `${profession}.md`);
  log.debug('loadSinglePrompt: professionPath=' + professionPath + ' exists=' + existsSync(professionPath));
  if (!existsSync(professionPath)) {
    log.warn('loadSinglePrompt: profession file MISSING, returning null', { professionPath });
    return null;
  }
  const professionContent = readFileSync(professionPath, 'utf-8');
  log.debug('loadSinglePrompt: professionContent length=' + professionContent.length);

  // Read persona.md
  const personaPath = join(configRoot, 'personas', theme, personaFile);
  log.debug('loadSinglePrompt: personaPath=' + personaPath + ' exists=' + existsSync(personaPath));
  if (!existsSync(personaPath)) {
    log.warn('loadSinglePrompt: persona file MISSING, returning null', { personaPath });
    return null;
  }
  const personaContent = readFileSync(personaPath, 'utf-8');
  log.debug('loadSinglePrompt: personaContent length=' + personaContent.length);

  const combined = professionContent.trim() + '\n\n' + personaContent.trim();
  log.debug('loadSinglePrompt: combined length=' + combined.length);
  return combined;
}

/**
 * Parse an agent identity from a stub comment marker.
 *
 * Format: <!-- persona-agents:{theme}-{profession}:{personaFile} -->
 * Example: <!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->
 * Example: <!-- persona-agents:wh40kOrk-planner:sparkgutz-bigmek.md -->
 *
 * Parsing strategy:
 * 1. Extract content between <!-- and -->
 * 2. Strip "persona-agents:" prefix
 * 3. Split on LAST ":" — right side is personaFile, left side is agent name
 * 4. Split agent name on LAST "-" — right side is profession, left side is theme
 *
 * @param text - The system message text to scan for a stub marker
 * @param log - Optional logger (defaults to silentLogger)
 * @returns The parsed AgentIdentity, or null if no valid marker is found
 */
export function parseAgentFromStubComment(
  text: string,
  log: Logger = silentLogger
): AgentIdentity | null {
  // Match the full marker: <!-- persona-agents:... -->
  const outerMatch = text.match(/<!--\s*persona-agents:\s*(.+?)\s*-->/);
  if (!outerMatch) return null;

  const inner = outerMatch[1].trim();
  log.debug('parseAgentFromStubComment: matched inner=[' + inner + ']');

  // Split on LAST colon to separate agentName from personaFile
  const lastColon = inner.lastIndexOf(':');
  if (lastColon === -1) {
    log.warn('parseAgentFromStubComment: no colon found in inner');
    return null;
  }

  const agentName = inner.substring(0, lastColon).trim();
  const personaFile = inner.substring(lastColon + 1).trim();

  if (!agentName || !personaFile) {
    log.warn('parseAgentFromStubComment: agentName or personaFile empty',
      { agentName, personaFile });
    return null;
  }

  // Split agent name on LAST hyphen to separate theme from profession
  const lastHyphen = agentName.lastIndexOf('-');
  if (lastHyphen === -1) {
    log.warn('parseAgentFromStubComment: no hyphen in agentName', { agentName });
    return null;
  }

  const theme = agentName.substring(0, lastHyphen);
  const profession = agentName.substring(lastHyphen + 1);

  if (!theme || !profession) {
    log.warn('parseAgentFromStubComment: theme or profession empty after split',
      { theme, profession });
    return null;
  }

  log.debug('parseAgentFromStubComment: parsed -> theme=[' + theme + '] profession=[' + profession + '] personaFile=[' + personaFile + ']');
  return { theme, profession, personaFile };
}
