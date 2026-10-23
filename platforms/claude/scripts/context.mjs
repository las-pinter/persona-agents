#!/usr/bin/env node
// context — Claude Code SessionStart / SubagentStart hook for persona-agents.
//
// A persona-agents agent (agent type `persona-agents:<profession>`) has an
// empty body, so it keeps Claude Code's own system prompt. This hook supplies
// its instructions from content/ instead, as additional context:
//
//   context.mjs profession   content/professions/<profession>.md, verbatim
//   context.mjs persona      a short Claude Code note + the persona that
//                            content/agents.json picks for the selected theme
//
// The two parts run as two hooks because Claude Code caps each hook string at
// 10,000 characters; tests/claude-plugin.test.ts keeps every part under it.
// Any other agent, or a session without one, gets no output.
//
// Set PERSONA_AGENTS_DEBUG=1 to append each hook input to
// $CLAUDE_PLUGIN_DATA/hook-input.log. plugin-options.mjs reads the theme option
// live from the settings files at each run.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginOption } from "./plugin-options.mjs";

const PREFIX = "persona-agents:";
const DEFAULT_THEME = "goblin";

const part = process.argv[2];
const root = process.env.CLAUDE_PLUGIN_ROOT;
const input = JSON.parse(readFileSync(0, "utf8"));

if (process.env.PERSONA_AGENTS_DEBUG && process.env.CLAUDE_PLUGIN_DATA) {
	mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
	appendFileSync(join(process.env.CLAUDE_PLUGIN_DATA, "hook-input.log"), `${JSON.stringify(input)}\n`);
}

const agentType = typeof input.agent_type === "string" ? input.agent_type : "";
if (!root || !agentType.startsWith(PREFIX)) process.exit(0);
const profession = agentType.slice(PREFIX.length);
const content = join(root, "content");

/** The profession rules, verbatim. */
function professionContext() {
	return readFileSync(join(content, "professions", `${profession}.md`), "utf8").trim();
}

/** The selected theme: managed settings, then user settings, then the env var, then the default. */
function selectedTheme() {
	return pluginOption("theme") || DEFAULT_THEME;
}

/** The Claude Code note plus the theme's persona, or null when none is mapped. */
function personaContext() {
	const theme = selectedTheme();
	const registry = JSON.parse(readFileSync(join(content, "agents.json"), "utf8"));
	const entry = registry[theme]?.[profession];
	if (!entry) {
		// A missing mapping must not block the agent: warn the user and run plain.
		process.stderr.write(`persona-agents: no ${theme} persona for ${profession}; running without one\n`);
		return null;
	}
	const persona = readFileSync(join(content, "personas", theme, entry.personaFile), "utf8").trim();
	const note = [
		`# Running in Claude Code (persona theme: ${theme})`,
		"",
		`You are the persona-agents ${profession}. Speak as the persona below: use its name, voice, and quirks, also when you introduce yourself. Your profession rules arrive as a separate block and take precedence over the persona on what you do. In Claude Code:`,
		`- Your crew are the \`${PREFIX}<profession>\` agents. Delegate to them with the Agent tool. Read a \`subagent\` tool, or a \`${theme}-<profession>\` agent name, as that.`,
		`- Load a skill by name with the Skill tool: a path such as \`skills/<group>/<name>/\` is the skill \`${PREFIX}<name>\`.`,
		"- Read a `todo` tool as Claude Code's task list, and an `ask_user_question` tool as AskUserQuestion.",
	].join("\n");
	return `${note}\n\n${persona}`;
}

const text = part === "profession" ? professionContext() : part === "persona" ? personaContext() : null;
if (!text) process.exit(0);

process.stdout.write(
	JSON.stringify({
		hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text },
	}),
);
