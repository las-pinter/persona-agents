import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentIdentity } from './types.js';

/**
 * Assemble the system prompt for a single agent by reading
 * its profession.md and persona.md files from the config root.
 *
 * @param configRoot - The OpenCode config root (e.g. ~/.config/opencode/)
 * @param identity - The agent identity (theme, profession, personaFile from stub)
 * @returns The concatenated prompt string, or null if files are missing
 */
export function loadSinglePrompt(
  configRoot: string,
  identity: AgentIdentity
): string | null {
  const { theme, profession, personaFile } = identity;

  // Read profession.md
  const professionPath = join(configRoot, 'professions', `${profession}.md`);
  if (!existsSync(professionPath)) {
    return null;
  }
  const professionContent = readFileSync(professionPath, 'utf-8');

  // Read persona.md
  const personaPath = join(configRoot, 'personas', theme, personaFile);
  if (!existsSync(personaPath)) {
    return null;
  }
  const personaContent = readFileSync(personaPath, 'utf-8');

  return professionContent.trim() + '\n\n' + personaContent.trim();
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
 */
export function parseAgentFromStubComment(text: string): AgentIdentity | null {
  // Match the full marker: <!-- persona-agents:... -->
  const outerMatch = text.match(/<!--\s*persona-agents:\s*(.+?)\s*-->/);
  if (!outerMatch) return null;

  const inner = outerMatch[1].trim();

  // Split on LAST colon to separate agentName from personaFile
  // e.g., "goblin-orchestrator:bossnik-chief.md" → "goblin-orchestrator" + "bossnik-chief.md"
  const lastColon = inner.lastIndexOf(':');
  if (lastColon === -1) return null;

  const agentName = inner.substring(0, lastColon).trim();
  const personaFile = inner.substring(lastColon + 1).trim();

  if (!agentName || !personaFile) return null;

  // Split agent name on LAST hyphen to separate theme from profession
  // e.g., "goblin-orchestrator" → "goblin" + "orchestrator"
  // e.g., "wh40kOrk-planner" → "wh40kOrk" + "planner"
  const lastHyphen = agentName.lastIndexOf('-');
  if (lastHyphen === -1) return null;

  const theme = agentName.substring(0, lastHyphen);
  const profession = agentName.substring(lastHyphen + 1);

  if (!theme || !profession) return null;

  return { theme, profession, personaFile };
}
