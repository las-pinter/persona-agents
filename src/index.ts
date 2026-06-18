import { type Plugin } from '@opencode-ai/plugin';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSystemTransformHandler } from './system-transform.js';
import type { Logger } from './types.js';

/**
 * Create a structured logger backed by the OpenCode client.app.log() API.
 *
 * All calls are fire-and-forget (errors caught silently) so that logging
 * never blocks the plugin hooks.
 */
function createLogger(client: { app: { log: (opts: {
  body: {
    service: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    extra?: Record<string, unknown>;
  };
}) => Promise<unknown> } }): Logger {
  const log = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, extra?: Record<string, unknown>) => {
      client.app.log({
        body: {
          service: 'persona-agents',
          level,
          message,
          extra,
        },
      }).catch(() => {
        // Swallow — logging must never crash the plugin
      });
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
 * The plugin is installed at {configRoot}/plugins/persona-agents.mjs.
 * By resolving from the plugin's own location, we find the config root
 * which has all the installed resources:
 *   - professions/ (profession markdown files)
 *   - personas/    (persona markdown files)
 *
 * This makes the plugin fully self-contained — no dependency on the
 * original repository location after installation, and no need for
 * an external mapping file like agents.json.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_ROOT = resolve(__dirname, '..');

/**
 * persona-agents OpenCode Plugin.
 *
 * No pre-loading at startup — prompts are loaded ON DEMAND when
 * the system.transform hook encounters a stub comment marker that
 * contains the theme, profession, and persona filename directly.
 *
 * Accepts the standard PluginInput from OpenCode which provides:
 * - client: The OpenCode SDK client (used for structured logging)
 * - project, directory, etc.
 */
const personaAgentsPlugin: Plugin = async (input) => {
  const log = createLogger(input.client);

  log.info('Plugin initializing', { configRoot: CONFIG_ROOT });

  return {
    'experimental.chat.system.transform': createSystemTransformHandler(CONFIG_ROOT, log),
  };
};

/**
 * Named 'server' export — required by OpenCode's PluginModule type.
 *
 * OpenCode uses dynamic import() and looks for a named export called 'server'.
 * Default exports are NOT supported for plugin loading.
 */
export const server = personaAgentsPlugin;
