// persona-agents — OpenCode v2 plugin: swaps stub markers
// (<!-- persona-agents:{theme}-{profession}:{personaFile} -->) in generated
// agent files for the real profession.md + persona.md content, loaded ON DEMAND
// from the OpenCode config root. Self-contained (only Node built-ins), so it
// loads from auto-discovery (~/.config/opencode/plugins/) with no node_modules,
// package.json, or build step.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The OpenCode config root directory.
//
// The plugin is installed at {configRoot}/plugins/persona-agents.js and is
// auto-discovered from that directory by OpenCode. Resolving from the plugin's
// own location finds the config root, which holds all the installed resources:
//   - professions/ (profession markdown files)
//   - personas/    (persona markdown files)
//
// This keeps the plugin fully self-contained — no dependency on the original
// repository location after installation, and no external mapping file.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_ROOT = resolve(__dirname, '..');

// Create a structured logger.
//
// The V2 plugin context no longer exposes the V1 `client.app.log()` API, so
// persona-agents logs through the console sinks, which OpenCode captures in
// its server log. The calls are synchronous and side-effect-only — logging
// can never block a hook, matching the fire-and-forget V1 behaviour.
function createLogger() {
  const log = (level) => (message, extra) => {
    const suffix =
      extra && Object.keys(extra).length > 0 ? ' ' + JSON.stringify(extra) : '';
    const line = `[persona-agents] ${level.toUpperCase()} ${message}${suffix}`;

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

// No-op logger that silences all output. Used as the default when no logger
// is passed in, so parsing/loading helpers never crash on a missing logger.
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// Assemble the system prompt for a single agent by reading its profession.md
// and persona.md files from the config root.
//
// Returns the concatenated prompt string, or null if either file is missing.
function loadSinglePrompt(configRoot, identity, log = silentLogger) {
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

// Parse an agent identity from a stub comment marker.
//
// Format: <!-- persona-agents:{theme}-{profession}:{personaFile} -->
// Example: <!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->
// Example: <!-- persona-agents:wh40kOrk-planner:sparkgutz-bigmek.md -->
//
// Parsing strategy:
// 1. Extract content between <!-- and -->
// 2. Strip "persona-agents:" prefix
// 3. Split on the LAST ":" — right side is personaFile, left side is agent name
// 4. Split agent name on the FIRST "-" — right side is profession, left is theme
//
// Returns the parsed identity (theme, profession, personaFile), or null if no
// valid marker is found.
function parseAgentFromStubComment(text, log = silentLogger) {
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

  // Split agent name on FIRST hyphen to separate theme from profession.
  // Using first hyphen rather than last supports multi-word profession names
  // (e.g. "implementer-python", "implementer-react") while remaining backward
  // compatible since no existing theme contains a hyphen.
  const firstHyphen = agentName.indexOf('-');
  if (firstHyphen === -1) {
    log.warn('parseAgentFromStubComment: no hyphen in agentName', { agentName });
    return null;
  }

  const theme = agentName.substring(0, firstHyphen);
  const profession = agentName.substring(firstHyphen + 1);

  if (!theme || !profession) {
    log.warn('parseAgentFromStubComment: theme or profession empty after split',
      { theme, profession });
    return null;
  }

  log.debug('parseAgentFromStubComment: parsed -> theme=[' + theme + '] profession=[' + profession + '] personaFile=[' + personaFile + ']');
  return { theme, profession, personaFile };
}

// Create a handler for the V2 `ctx.session.hook("context", ...)` hook.
//
// The handler scans event.system for stub markers like
// "<!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->" and replaces
// them with the actual assembled prompt content (profession.md + persona.md).
//
// Prompts are loaded ON DEMAND — only when a marker is encountered. The
// configRoot tells the handler where to find the resource files.
//
// V2 hook shape vs V1 (experimental.chat.system.transform):
// - V1 passed (input, output) with output.system: string[]
// - V2 passes a single mutable event whose system: Array<SystemPart>, so the
//   marker lives in part.text and we swap in a fresh text part at the same
//   position. (SystemPart fields are readonly; stub parts carry no useful
//   cache/metadata so replacing them wholesale is safe.)
//
// No dedup is needed because the marker is fully replaced on first match —
// if the system prompt is reconstructed fresh each call, the replacement
// happens again harmlessly. If it persists, the marker simply isn't there
// to match.
function createSystemTransformHandler(configRoot, log = silentLogger) {
  return (event) => {
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

// persona-agents OpenCode v2 plugin.
//
// Prompts are loaded ON DEMAND when the session "context" hook — the V2
// successor of `experimental.chat.system.transform` — encounters a stub
// comment marker containing the theme, profession, and persona filename
// directly.
//
// Unlike V1, the V2 hook receives one mutable event whose `system` field is
// an array of SystemPart objects ({ type: "text", text }) instead of plain
// strings; the stub marker lives in the `text` of a part.
//
// Plugin.define(...) is a pure identity helper (returns its argument) for type
// checking only — the v2 runtime just needs a default-export object with id/setup.
export default {
  id: 'persona-agents',

  async setup(ctx) {
    const log = createLogger();
    log.info('Plugin initializing', { configRoot: CONFIG_ROOT });

    const transform = createSystemTransformHandler(CONFIG_ROOT, log);

    // Runs immediately before every agent-loop model dispatch, mirroring the
    // V1 system.transform hook. The registration lives for the plugin's
    // lifetime and is disposed automatically when the plugin unloads.
    await ctx.session.hook('context', (event) => {
      transform(event);
    });
  },
};