import { Plugin } from '@opencode/plugin';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSystemTransformHandler } from './system-transform.js';
import type { Logger } from './types.js';

/**
 * Create a structured logger.
 *
 * The V2 plugin context no longer exposes the V1 `client.app.log()` API, so
 * persona-agents logs through the console sinks, which OpenCode captures in
 * its server log. The calls are synchronous and side-effect-only — logging
 * can never block a hook, matching the fire-and-forget V1 behaviour.
 */
function createLogger(): Logger {
  const log =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, extra?: Record<string, unknown>) => {
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

/**
 * The OpenCode config root directory.
 *
 * The plugin is installed at {configRoot}/plugins/persona-agents.js and is
 * auto-discovered from that directory by both OpenCode v1 and v2. Resolving
 * from the plugin's own location finds the config root, which holds all the
 * installed resources:
 *   - professions/ (profession markdown files)
 *   - personas/    (persona markdown files)
 *
 * This keeps the plugin fully self-contained — no dependency on the original
 * repository location after installation, and no external mapping file.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_ROOT = resolve(__dirname, '..');

/**
 * persona-agents OpenCode v2 plugin.
 *
 * Prompts are loaded ON DEMAND when the session "context" hook — the V2
 * successor of `experimental.chat.system.transform` — encounters a stub
 * comment marker containing the theme, profession, and persona filename
 * directly.
 *
 * Unlike V1, the V2 hook receives one mutable event whose `system` field is
 * an array of SystemPart objects ({ type: "text", text }) instead of plain
 * strings; the stub marker lives in the `text` of a part.
 */
export default Plugin.define({
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
});
