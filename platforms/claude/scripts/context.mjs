#!/usr/bin/env node
// context — Claude Code SessionStart hook for the persona-agents companion.
//
// The companion agent (`persona-agents:companion`) has an empty body, so it
// keeps Claude Code's own system prompt. This hook supplies its instructions
// from content/ instead, as additional context:
//
//   context.mjs profession   content/professions/companion.md, verbatim
//   context.mjs persona      a short Claude Code note + the persona that
//                            content/agents.json picks for the selected theme
//   context.mjs session      the session id, so the companion can name its
//                            session in the task notes file
//
// SessionStart fires on startup, resume, clear, and compact, so every part
// comes back after a compaction. The parts run as separate hooks because
// Claude Code caps each hook string at 10,000 characters;
// tests/claude-plugin.test.ts keeps every part under it. Any other agent, or
// a session without one, gets no output.
//
// Set PERSONA_AGENTS_DEBUG=1 to append each hook input to
// $CLAUDE_PLUGIN_DATA/hook-input.log. plugin-options.mjs reads the theme option
// live from the settings files at each run.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_FREE_RULE } from "../../shared/context/context.ts";
import { pluginOption } from "./plugin-options.mjs";

const AGENT_TYPE = "persona-agents:companion";
const PROFESSION = "companion";
const DEFAULT_THEME = "goblin";

const part = process.argv[2];
const root = process.env.CLAUDE_PLUGIN_ROOT;
const input = JSON.parse(readFileSync(0, "utf8"));

if (process.env.PERSONA_AGENTS_DEBUG && process.env.CLAUDE_PLUGIN_DATA) {
	mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
	appendFileSync(join(process.env.CLAUDE_PLUGIN_DATA, "hook-input.log"), `${JSON.stringify(input)}\n`);
}

if (!root || input.agent_type !== AGENT_TYPE) process.exit(0);
const content = join(root, "content");

/** The profession rules, verbatim. */
function professionContext() {
	return readFileSync(join(content, "professions", `${PROFESSION}.md`), "utf8").trim();
}

/** Claude Code mechanics the companion needs with or without a persona. */
const PLATFORM_LINES = [
	"- Load a skill by name with the Skill tool: the skill `<name>` is `persona-agents:<name>`.",
	"- The review skill starts the reviewer as a background subagent, and only its result wakes you. Stall guard: in the same turn, start `sleep 1200` as a background shell command (it may ask once). If that timer finishes before the review result, load `TaskStop` with ToolSearch, stop the reviewer with it, and report the review as incomplete. If the result arrives first, stop the timer.",
];

/** The Claude Code note plus the theme's persona; a missing mapping still carries the persona-free rule. */
function personaContext() {
	const theme = pluginOption("theme") || DEFAULT_THEME;
	const registry = JSON.parse(readFileSync(join(content, "agents.json"), "utf8"));
	const entry = registry[theme]?.[PROFESSION];
	if (!entry) {
		// A missing mapping must not block the session: warn the owner, and still
		// carry the persona-free rule, which travels with the persona.
		process.stderr.write(`persona-agents: no ${theme} persona for the ${PROFESSION}; running without one\n`);
		return [`# Running in Claude Code (no persona)`, "", PERSONA_FREE_RULE, "", ...PLATFORM_LINES].join("\n");
	}
	const persona = readFileSync(join(content, "personas", theme, entry.personaFile), "utf8").trim();
	const lines = [
		`# Running in Claude Code (persona theme: ${theme})`,
		"",
		`You are the persona-agents companion. Speak as the persona below in chat: use its name, voice, and quirks, also when you introduce yourself. Your profession rules arrive as a separate block and take precedence over the persona on what you do. ${PERSONA_FREE_RULE}`,
		"",
		...PLATFORM_LINES,
	];
	return `${lines.join("\n")}\n\n${persona}`;
}

/** The session id, or null when the hook input holds none. */
function sessionContext(input) {
	const id = typeof input.session_id === "string" ? input.session_id : "";
	return id ? `Session id: ${id}` : null;
}

const text =
	part === "profession" ? professionContext() : part === "persona" ? personaContext() : part === "session" ? sessionContext(input) : null;
if (!text) process.exit(0);

process.stdout.write(
	JSON.stringify({
		hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text },
	}),
);
