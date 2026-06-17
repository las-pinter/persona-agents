import { type Plugin } from '@opencode-ai/plugin';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSystemTransformHandler } from './system-transform.js';

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
 */
const personaAgentsPlugin: Plugin = async () => {
  return {
    'experimental.chat.system.transform': createSystemTransformHandler(CONFIG_ROOT),
  };
};

/**
 * Named 'server' export — required by OpenCode's PluginModule type.
 *
 * OpenCode uses dynamic import() and looks for a named export called 'server'.
 * Default exports are NOT supported for plugin loading.
 */
export const server = personaAgentsPlugin;
