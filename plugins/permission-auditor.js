// permission-auditor — read-only OpenCode v2 plugin: logs every permission
// evaluation, ask prompt, and user reply to a JSONL file for template tuning.
// Self-contained (only Node built-ins), so it loads from auto-discovery
// (~/.config/opencode/plugins/) with no node_modules, package.json, or build step.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = join(process.env.HOME || '.', '.local', 'share', 'opencode');
const LOG_FILE = join(LOG_DIR, 'permission-audit.jsonl');

// The host emits duplicate asked/replied pairs for one request id (observed in
// the sandbox): each kind arrives more than once. asked and replied share the
// same id space but are INDEPENDENT events we want BOTH of — the asked line
// records the prompt we showed, the replied line records the user's answer
// (once/always/reject), which is the key finetuning signal. Dedupe each kind
// with its OWN bounded Set so host duplicate pairs collapse (one asked + one
// replied per unique request id) without the two kinds cross-cancelling: a
// shared set would let asked claim the id first and drop every replied event.
// When a set overflows the cap, reset it wholesale: dedupe is best-effort,
// no LRU.
const SEEN_IDS_CAP = 1000;
const askedIds = new Set();
const repliedIds = new Set();

// Warn at most once — a host without evaluate logging would otherwise spam stderr.
let warnedEvaluateHook = false;

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

// Plugin.define(...) is a pure identity helper (returns its argument) for type
// checking only — the v2 runtime just needs a default-export object with id/setup.
export default {
  id: 'permission-auditor',

  async setup(ctx) {
    // Fires before permission evaluations. READ-ONLY: never mutate effect.
    // Best-effort: opencode 2.0.11 changed permission.hook to an Effect-based
    // API, so awaiting a promise-style registration rejects (host contract
    // mismatch) and the supervisor aborts the whole plugin batch on one
    // setup() failure. Swallow the error and keep the auditor silent rather
    // than taking persona-agents down with us.
    try {
      await ctx.permission.hook('evaluate', (e) => {
        try {
          log({ kind: 'evaluate', sessionID: e.sessionID, agent: e.agent, action: e.action, resources: e.resources, effect: e.effect, message: e.message });
        } catch {
          // Swallow silently — a null/undefined event or a throwing field
          // access must never propagate into the host's evaluation pipeline.
        }
      });
    } catch {
      // evaluate logging unavailable on this host — stay alive, log nothing.
      if (!warnedEvaluateHook) {
        warnedEvaluateHook = true;
        console.warn('permission-auditor: evaluate logging unavailable on this host');
      }
    }

    // Event stream: record each ask prompt and the user's reply to it.
    // DETACHED, not awaited — opencode 2.0.11's plugin activation latch
    // (plugins.awaitActivation) only opens once EVERY plugin setup() settles,
    // so a live for-await subscription kept inside setup() would pin the
    // latch closed and hang sessions (only 7/0 agents load). Firing the loop
    // as a fire-and-forget background task lets setup() resolve immediately
    // while the auditor keeps listening for permission events.
    const loop = (async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          try {
            const d = event.data;
            if (event.type === 'permission.asked') {
              if (!askedIds.has(d.id)) {
                askedIds.add(d.id);
                log({ kind: 'asked', id: d.id, sessionID: d.sessionID, action: d.action, resources: d.resources, save: d.save });
              }
            } else if (event.type === 'permission.replied') {
              if (!repliedIds.has(d.requestID)) {
                repliedIds.add(d.requestID);
                log({ kind: 'replied', requestID: d.requestID, sessionID: d.sessionID, reply: d.reply });
              }
            }
            if (askedIds.size > SEEN_IDS_CAP) {
              askedIds.clear();
            }
            if (repliedIds.size > SEEN_IDS_CAP) {
              repliedIds.clear();
            }
          } catch {
            // Malformed event — skip it, keep listening for valid ones.
          }
        }
      } catch {
        // Best-effort: host tore the stream down — the evaluate hook stays alive.
      }
    })();
  },
};
