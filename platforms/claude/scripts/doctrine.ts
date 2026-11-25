#!/usr/bin/env node
// doctrine — Claude Code PreToolUse hook (Bash) for companion-agents.
//
// The settings snippet (platforms/claude/settings/recommended.json) holds the
// base permission rules. This hook adds what settings rules cannot express,
// for the companion-agents agents (agent type `companion-agents:<name>`):
//
//   any local git command that is not a read and not a push
//                     companion: allow when every other part is inert (a `cd`
//                     into the session directory or an additional one, a
//                     read-only git command, a project formatter, a pipe
//                     filter, a quoted heredoc that feeds `git commit -F -`);
//                     every other agent: deny
//   git push, a gh pr / release / run write, any git global option outside
//   GIT_PLAIN_OPTIONS / GIT_PATH_OPTIONS (-c, --config-env, --exec-path,
//   --attr-source, ...), git pull --upload-pack, a `::` transport URL, a merge
//   strategy (-s, --strategy), a git verb that runs another program, writes
//   config, or reaches a remote, and any wrapped or runtime-shaped command
//                     companion: ask; every other agent: deny
//   a write: a file-changing command (cp, mv, rm, tee, sed -i, ...), a git
//   verb outside the read list, a gh command that is not a read, or an
//   output redirect to a file
//                     companion: no decision; every other agent: deny
//
// The reviewer is read-only: it has no Edit or Write tool (its agent file),
// and this hook denies it every shell write it can see.
//
// Allow is given only when every segment of the command is git work or an
// inert part. A command that mixes an allowed segment with an ungated one
// (`git add . && rm -rf x`) gets no decision, so Claude Code's own flow runs.
// A wrapped form (env/sudo/xargs/eval prefixes, `bash -c`, a subshell, a
// `$(...)` or backtick substitution, an env assignment, a path to git, the
// unwrap depth limit) or a runtime-shaped one (a `$` expansion, a glob, an
// output redirect to a file) is raised to ask. Claude Code still applies
// settings deny and ask rules after a hook allow, and an allow from this hook
// never overrides an ask or deny from another hook.
//
// Accepted risks (owner choice), allowed without a prompt:
//   git rebase --exec '<cmd>' runs <cmd>; its payload is not inspected.
//   git -C / --git-dir / --work-tree to another path runs that repository's
//   hooks and core.* config.
//
// The classification of a command into history / publish / write / support /
// ungated lives in platforms/shared/shell/gates.ts, which the Pi and Kiro
// gates also use. This file owns only the verdicts for the Claude agents.
//
// Any other agent, or a session without one, gets no decision, so Claude
// Code's own permission flow runs unchanged.
//
// Set COMPANION_AGENTS_DEBUG=1 to append each hook input and decision to
// $CLAUDE_PLUGIN_DATA/doctrine.log.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gateCommand, insideDir, SUPPORT, UNGATED, type GateHit } from "../../shared/shell/gates.ts";
import { sessionDirs } from "./session-dirs.ts";


const PREFIX = "companion-agents:";

export type Verdict = "allow" | "ask" | "deny";

export interface Decision {
	verdict: Verdict;
	reason: string;
}

export interface HookInput {
	agent_type?: unknown;
	tool_name?: unknown;
	tool_input?: Record<string, unknown>;
	/** The session's current directory, as the hook input reports it. */
	cwd?: unknown;
}

/**
 * history: a git command that is not a read and not publish.
 * publish: git push, and a gh pr, gh release, or gh run write, also when a gh
 * global option comes first, plus every history command that is an ask
 * exception or comes wrapped (see the header).
 * write: a command that changes files or remote state (see the header).
 */
type Gate = "history" | "publish" | "write";

/**
 * The companion's verdict per gate. Its write segments never reach a gate
 * (they count as ungated), so write has no rule. Every other agent is denied.
 */
const COMPANION_RULES: Record<Exclude<Gate, "write">, Verdict> = {
	history: "allow",
	publish: "ask",
};

const HISTORY_DENY = "only the companion writes git history or runs a gh pr / release / run write; suggest a commit instead";
const PUBLISH_ASK =
	"git push, a gh pr / release / run write, a git config override, an upload-pack or transport helper URL, a merge strategy, or a wrapped git command needs your approval";

const HISTORY_ALLOW = "a git command runs without a prompt for the companion";
const WRITE_DENY = "this agent is read-only: it may not change files or remote state from the shell";

/** Why a gate fired: an allow or an ask explains itself, a deny names who may run it. */
function gateReason(gate: Gate, verdict: Verdict): string {
	if (verdict === "deny") return gate === "write" ? WRITE_DENY : HISTORY_DENY;
	return verdict === "allow" ? HISTORY_ALLOW : PUBLISH_ASK;
}

/** The doctrine decision for one tool call, or null to leave it alone. */
export function decide(input: HookInput, additionalDirs: string[] = []): Decision | null {
	const agentType = typeof input.agent_type === "string" ? input.agent_type : "";
	if (!agentType.startsWith(PREFIX)) return null;
	const profession = agentType.slice(PREFIX.length);
	if (input.tool_name !== "Bash") return null;
	const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
	const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : "";
	const isSessionDir =
		cwd === "" ? undefined : (path: string) => insideDir(path, cwd) || additionalDirs.some((dir) => insideDir(path, dir));
	let hits = gateCommand(command, 0, { cwd: cwd === "" ? undefined : cwd, isSessionDir });
	// The companion may write; a write segment is an ungated segment for it.
	if (profession === "companion") hits = hits.map((hit) => (hit === "write" ? UNGATED : hit));
	const decisions = hits
		.filter((hit): hit is GateHit => hit !== UNGATED && hit !== SUPPORT)
		.map((gate) => {
			const verdict: Verdict = profession === "companion" && gate !== "write" ? COMPANION_RULES[gate] : "deny";
			return { verdict, reason: gateReason(gate, verdict) };
		});
	const decision = strongest(decisions, profession);
	// A hook allow skips Claude Code's prompt for the whole command, so allow
	// only when every segment is an allowed history command. An ungated
	// segment next to it leaves the decision to Claude Code.
	if (decision?.verdict === "allow" && hits.includes(UNGATED)) return null;
	return decision;
}

/** Deny beats ask, ask beats allow; no hit means no decision. */
function strongest(hits: Decision[], profession: string): Decision | null {
	const pick = hits.find((hit) => hit.verdict === "deny") ?? hits.find((hit) => hit.verdict === "ask") ?? hits[0];
	if (!pick) return null;
	return { verdict: pick.verdict, reason: `companion-agents doctrine (${profession}): ${pick.reason}` };
}

// Run as a hook: PreToolUse JSON on stdin, a permission decision on stdout.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
	const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : "";
	const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
	// The settings read is lazy: only a command with a `cd` part needs it.
	const additionalDirs = /\bcd\s/.test(command) ? sessionDirs(cwd || process.cwd()) : [];
	const decision = decide(input, additionalDirs);
	if (process.env.COMPANION_AGENTS_DEBUG && process.env.CLAUDE_PLUGIN_DATA) {
		mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
		appendFileSync(join(process.env.CLAUDE_PLUGIN_DATA, "doctrine.log"), `${JSON.stringify({ input, decision })}\n`);
	}
	if (decision) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: decision.verdict,
					permissionDecisionReason: decision.reason,
				},
			}),
		);
	}
}
