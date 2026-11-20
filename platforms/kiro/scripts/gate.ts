/**
 * The Kiro commit doctrine, in two hook shapes.
 *
 * The doctrine lives in `AGENTS.md`; the classification of a command into
 * history / publish / write / ungated lives in `platforms/shared/shell/gates.ts`,
 * shared with the Claude and Pi adapters.
 *
 *   permission (companion)  PermissionRequest: return an allow decision for a
 *                           plain history command or a reviewed/trivial commit.
 *                           Anything else returns no decision, so Kiro shows its
 *                           own prompt: an unmatched call is ask.
 *   pretool (reviewer)      PreToolUse: block every history, publish, or write
 *                           segment the gate can see. Reads pass.
 *
 * A plain history command is allowed only when every segment is history; one
 * ungated segment next to it leaves the call to Kiro's prompt, exactly like the
 * Claude doctrine.
 *
 * The commit gate reads the same change key the review did. A trivial change,
 * or an `Approve` stored for that exact key, allows the commit silently; a
 * missing review, or one that asked for changes, falls through to Kiro's ask.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { isCommitCommand, isTrivial } from "../../shared/review/review.ts";
import { gateCommand, UNGATED, type Hit } from "../../shared/shell/gates.ts";
import { changeKey } from "./change.ts";
import { appendDecision, reviewFor } from "./state.ts";
import { kiroHome as resolveKiroHome, stateDir as stateDirOf } from "./paths.ts";

export type AgentProfile = "companion" | "reviewer";
export type Verdict = "allow" | "ask" | "deny";

/** Why the doctrine stops a reviewer's shell write or history command. */
export const HISTORY_DENY =
	"only the companion writes git history or runs gh pr / gh release / gh run; suggest a commit instead";
/** Why a publish command asks the owner. */
export const PUBLISH_ASK =
	"git push, gh pr, gh release, gh run, a tag delete or force-move, a git config override, commit --amend, or a wrapped git command needs your approval";
/** Why an unreviewed commit asks the owner. */
export const REVIEW_ASK = "this change has no independent review, so the commit needs your approval";
/** Why a command that is not a plain history command asks the owner. */
export const UNGATED_ASK = "this command is not a plain history command, so it needs your approval";
/** Why a command that mixes gated and ungated segments asks. */
const MIXED_ASK = "this command mixes a history command with another segment, so it needs your approval";

/** One gate decision. */
export interface Decision {
	verdict: Verdict;
	reason: string;
	/** The change key, for a commit decision. */
	key?: string;
}

/** What the gate needs to decide a commit. */
export interface GateContext {
	cwd: string;
	stateDir: string;
	sessionId?: string;
	/** The current time, injected by the tests. */
	now?: Date;
}

/** Why a gated reviewer segment is denied. */
function denyReason(hits: Hit[]): string {
	if (hits.includes("publish")) return HISTORY_DENY;
	if (hits.includes("history")) return HISTORY_DENY;
	return "this agent is read-only: it may not change files or remote state from the shell";
}

/**
 * The doctrine decision for one shell command.
 *
 * A companion write segment is ungated: the companion may write. The reviewer
 * may not.
 */
export function commandDecision(profile: AgentProfile, command: string, ctx: GateContext): Decision {
	const raw = gateCommand(command);
	const hits = profile === "companion" ? raw.map((hit) => (hit === "write" ? UNGATED : hit)) : raw;
	const gated = hits.filter((hit): hit is Exclude<Hit, typeof UNGATED> => hit !== UNGATED);

	if (profile === "reviewer") {
		if (gated.length > 0) return { verdict: "deny", reason: denyReason(gated) };
		return { verdict: "allow", reason: "no gated segment" };
	}

	if (gated.includes("publish")) return { verdict: "ask", reason: PUBLISH_ASK };
	if (gated.length === 0) return { verdict: "ask", reason: UNGATED_ASK };
	const plainHistory = gated.every((hit) => hit === "history") && !hits.includes(UNGATED);
	if (!plainHistory) return { verdict: "ask", reason: MIXED_ASK };

	if (!isCommitCommand(command)) return { verdict: "allow", reason: "a plain git add, commit, pull, merge, rebase, or tag" };

	const { change, key } = changeKey(ctx.cwd);
	if (isTrivial(change)) return { verdict: "allow", reason: "a trivial change needs no review before a commit", key };
	const review = reviewFor(ctx.stateDir, key);
	// Only a record the Stop hook wrote carries a sub-session. A hand-written
	// entry (the companion can run node) does not unlock a commit.
	const usable = review && review.subSession ? review : null;
	if (usable?.verdict === "Approve") return { verdict: "allow", reason: "an independent review approved this exact change", key };
	if (usable) return { verdict: "ask", reason: `the review returned ${usable.verdict}, so this commit needs your approval`, key };
	return { verdict: "ask", reason: REVIEW_ASK, key };
}

/** The decision for one hook event, with the event's guards applied. */
export function hookDecision(profile: AgentProfile, input: Record<string, unknown>, ctx: GateContext): Decision | null {
	const tool = typeof input.tool_name === "string" ? input.tool_name : "";
	if (tool !== "execute_bash" && tool !== "execute_pwsh") return null;
	const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
	const command = typeof toolInput.command === "string" ? toolInput.command : "";
	if (!command) return null;
	return commandDecision(profile, command, ctx);
}

/** The PermissionRequest stdout for a decision; an ask is no output. */
export function permissionOutput(decision: Decision): string {
	if (decision.verdict === "allow") {
		return JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } });
	}
	if (decision.verdict === "deny") {
		return JSON.stringify({ hookSpecificOutput: { decision: { behavior: "deny", message: decision.reason } } });
	}
	return "";
}

/** The PreToolUse result: exit 2 and stderr for a deny, exit 0 otherwise. */
export function preToolResult(decision: Decision): { exitCode: number; stderr: string } {
	if (decision.verdict === "deny") {
		return { exitCode: 2, stderr: `persona-agents doctrine: ${decision.reason}\n` };
	}
	return { exitCode: 0, stderr: "" };
}

/** Log the decision the way the retro reads it. */
export function logDecision(profile: AgentProfile, tool: string, command: string, decision: Decision, ctx: GateContext): void {
	if (decision.verdict === "allow" && !process.env.PERSONA_AGENTS_DEBUG) return;
	appendDecision(ctx.stateDir, {
		at: (ctx.now ?? new Date()).toISOString(),
		session: ctx.sessionId,
		agent: profile,
		tool,
		verdict: decision.verdict,
		reason: decision.reason,
		command,
	});
}

function option(name: string, argv: string[]): string | undefined {
	const arg = argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const mode = process.argv[2];
	const profile = process.argv[3] === "reviewer" ? "reviewer" : "companion";
	const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
	const home = option("home", process.argv) ?? homedir();
	const kiro = option("kiro-home", process.argv) ?? resolveKiroHome(process.env, home);
	const ctx: GateContext = {
		cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
		stateDir: stateDirOf(kiro),
		sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
	};
	const decision = hookDecision(profile, input, ctx);
	if (!decision) process.exit(0);
	const tool = typeof input.tool_name === "string" ? input.tool_name : "shell";
	const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
	logDecision(profile, tool, typeof toolInput.command === "string" ? toolInput.command : "", decision, ctx);
	if (mode === "pretool") {
		const result = preToolResult(decision);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exit(result.exitCode);
	}
	if (mode === "permission") {
		const output = permissionOutput(decision);
		if (output) process.stdout.write(`${output}\n`);
	}
}
