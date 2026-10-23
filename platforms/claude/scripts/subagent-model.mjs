#!/usr/bin/env node
// subagent-model — Claude Code PreToolUse hook (matcher ^(Agent|Task)$) for persona-agents.
//
// Sets the model of a persona-agents subagent (subagent_type
// `persona-agents:<profession>`, except the orchestrator) from the
// subagent_model option. The option is read live at each run (see
// plugin-options.mjs), so a change in /config applies to the next subagent.
//
//   sonnet, opus, haiku   updatedInput = the original tool_input with model set
//                         to the value; a model the caller passed is replaced
//   inherit               no output; the caller's model or the default applies
//   any other value       the default, sonnet
//
// The hook gives no permission decision. Any other call, and any error, gets
// no output and exit 0: this hook must never block an Agent call.

import { readFileSync } from "node:fs";
import { pluginOption } from "./plugin-options.mjs";

const PREFIX = "persona-agents:";
const SKIPPED = new Set(["persona-agents:orchestrator"]);
const MODELS = new Set(["sonnet", "opus", "haiku"]);
const DEFAULT_MODEL = "sonnet";

/**
 * The selected model, or "inherit"; a value outside the options gives the default.
 * CLAUDE_PLUGIN_OPTION_SUBAGENT_MODEL is not read. A probe (Claude Code 2.1.309)
 * showed that a project .claude/settings.json env block sets it for the hook, so
 * a repo could pick the subagent model. Only the settings files apply. A plugin
 * installed from another marketplace name gets a different pluginConfigs key,
 * so it always gets the default.
 */
function selectedModel() {
	const value = pluginOption("subagent_model", { envFallback: false });
	return MODELS.has(value) || value === "inherit" ? value : DEFAULT_MODEL;
}

try {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const toolInput = input?.tool_input;
	const type = toolInput?.subagent_type;
	if (typeof type === "string" && type.startsWith(PREFIX) && !SKIPPED.has(type)) {
		const model = selectedModel();
		if (model !== "inherit") {
			process.stdout.write(
				JSON.stringify({
					hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, model } },
				}),
			);
		}
	}
} catch {
	// Never block the Agent call.
}
// No process.exit: a forced exit can cut a large stdout write to a pipe.
process.exitCode = 0;
