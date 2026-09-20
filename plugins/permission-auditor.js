// permission-auditor — read-only OpenCode v2 plugin: logs every permission
// evaluation, ask prompt, and user reply to a JSONL file for template tuning.
// Installed via auto-discovery (~/.config/opencode/plugins/), no build step.
import { Plugin } from '@opencode/plugin';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = join(process.env.HOME || '.', '.local', 'share', 'opencode');
const LOG_FILE = join(LOG_DIR, 'permission-audit.jsonl');

// Never throw: the auditor is invisible — logging must not break sessions.
// JSON.stringify omits undefined fields, keeping lines minimal.
function log(record) {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    // Grows unbounded (no rotation — out of scope).
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  } catch {
    // Swallow silently — audit logging is best-effort.
  }
}

export default Plugin.define({
  id: 'permission-auditor',

  async setup(ctx) {
    // Fires before permission evaluations. READ-ONLY: never mutate effect.
    await ctx.permission.hook('evaluate', (e) => {
      log({ kind: 'evaluate', sessionID: e.sessionID, agent: e.agent, action: e.action, resources: e.resources, effect: e.effect, message: e.message });
    });

    // Event stream: record each ask prompt and the user's reply to it.
    // Best-effort: if the host tears the stream down (RPC failure, connection
    // loss), swallow the error and stop listening rather than rejecting
    // setup() — the evaluate hook keeps working, but a half-dead auditor
    // should stay quiet and alive.
    try {
      for await (const event of ctx.event.subscribe()) {
        try {
          const d = event.data;
          if (event.type === 'permission.asked') {
            log({ kind: 'asked', id: d.id, sessionID: d.sessionID, action: d.action, resources: d.resources, save: d.save });
          } else if (event.type === 'permission.replied') {
            log({ kind: 'replied', requestID: d.requestID, sessionID: d.sessionID, reply: d.reply });
          }
        } catch {
          // Malformed event — skip it, keep listening for valid ones.
        }
      }
    } catch {
      // Best-effort stream ended.
    }
  },
});