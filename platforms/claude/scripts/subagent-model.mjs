#!/usr/bin/env node
// subagent-model — Claude Code PreToolUse hook (matcher ^(Agent|Task)$) for persona-agents.
//
// Sets the model of a persona-agents subagent (subagent_type
// `persona-agents:<profession>`, except the orchestrator) from the
// subagent_model option. The option is read live at each run (see
// plugin-options.mjs), so a change in /config applies to the next subagent.
//
//   sonnet, opus, haiku   a call with no model gets updatedInput = the original
//                         tool_input with model set to the value
//   a call with a model   no output: the caller wins. Auto mode reviews the call
//                         before this hook and refuses a call whose input the
//                         hook changed, so a changed input costs a retry. The
//                         session start text tells the orchestrator the model.
//   inherit               no output; the default applies
//   any other value       the default, sonnet
//
// The hook gives no permission decision. Any other call, and any error, gets
// no output and exit 0: this hook must never block an Agent call.

import { readFileSync } from "node:fs";
import { selectedSubagentModel } from "./plugin-options.mjs";

const PREFIX = "persona-agents:";
const SKIPPED = new Set(["persona-agents:orchestrator"]);

try {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const toolInput = input?.tool_input;
	const type = toolInput?.subagent_type;
	if (typeof type === "string" && type.startsWith(PREFIX) && !SKIPPED.has(type)) {
		const callerModel = toolInput.model;
		const callerHasModel = callerModel != null && callerModel !== "";
		const model = callerHasModel ? "inherit" : selectedSubagentModel();
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
