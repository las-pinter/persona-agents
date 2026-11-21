/**
 * The Kiro commit doctrine, in two hook shapes.
 *
 * The doctrine lives in `AGENTS.md`; the classification of a command into
 * history / publish / write / support / ungated lives in
 * `platforms/shared/shell/gates.ts`, shared with the Claude and Pi adapters.
 *
 *   permission (companion)  PermissionRequest: return an allow decision for a
 *                           git command or a reviewed/trivial commit.
 *                           Anything else returns no decision, so Kiro shows its
 *                           own prompt: an unmatched call is ask.
 *   pretool (reviewer)      PreToolUse: block every history, publish, or write
 *                           segment the gate can see. Reads pass.
 *
 * A git command is allowed only when every segment is history or an inert
 * support part; one ungated segment next to it leaves the call to Kiro's
 * prompt, exactly like the Claude doctrine.
 *
 * The commit gate reads the same change key the review did. A trivial change,
 * or an `Approve` stored for that exact key, allows the commit silently; a
 * missing review, or one that asked for changes, falls through to Kiro's ask.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isCommitCommand, isTrivial } from "../../shared/review/review.ts";
import { commandSegments, gateCommand, gitSubcommand, insideDir, shellWords, unwrapSegment, SUPPORT, UNGATED, type GateHit, type Hit } from "../../shared/shell/gates.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
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
	"git push, gh pr, gh release, gh run, a git config override, or a wrapped git command needs your approval";
/** Why an unreviewed commit asks the owner. */
export const REVIEW_ASK = "this change has no independent review, so the commit needs your approval";
/** Why a commit against another repository asks the owner. */
export const OTHER_REPO_ASK = "a commit against another repository needs your approval";
/** Why a command that is not git work asks the owner. */
export const UNGATED_ASK = "this command is not git work, so it needs your approval";
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
	/** The project notes folder, resolved lazily; a cd into it is a session directory. */
	notesDir?: () => string;
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
 * The git top-level of a directory, or null when it is not in a repository.
 */
function gitTopLevel(dir: string): string | null {
	const run = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2000 });
	if (run.status !== 0) return null;
	const top = (run.stdout ?? "").trim();
	return top === "" ? null : resolve(top);
}

/**
 * True when a commit in the command runs in a different repository from the
 * session, or in none. The running directory is tracked across the segments,
 * so a trailing `cd` back into the session does not hide the commit's tree.
 */
function commitOutsideRepo(command: string, cwd: string): boolean {
	const here = gitTopLevel(cwd);
	let dir = cwd;
	for (const raw of commandSegments(command)) {
		const words = shellWords(raw);
		let i = 0;
		while (words[i] === "cd") {
			const target = words[i + 1] ?? "";
			if (target === "") dir = homedir();
			else if (target !== "-" && !/[$`*?[\]{}]/.test(target)) {
				dir = target === "~" ? homedir() : target.startsWith("~/") ? resolve(homedir(), target.slice(2)) : resolve(dir, target);
			}
			if (words[i + 2] !== "&&") {
				i += 2;
				break;
			}
			i += 3;
		}
		if (words[i] !== "git" || words[i + 1] !== "commit") continue;
		const there = gitTopLevel(dir);
		if (here === null || there === null || here !== there) return true;
	}
	return false;
}

/**
 * True when a git command names another repository through a leading path
 * option. `git commit -C <ref>` reuses a message, not a repository, and must
 * not match.
 */
function namesAnotherRepo(command: string): boolean {
	for (const raw of commandSegments(command)) {
		const words = shellWords(unwrapSegment(raw));
		let i = 0;
		if (words[i] === "sudo") i++;
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
		if (words[i] !== "git") continue;
		if (gitSubcommand(words.slice(i + 1)).pathOption) return true;
	}
	return false;
}

/**
 * The doctrine decision for one shell command.
 *
 * A companion write segment is ungated: the companion may write. The reviewer
 * may not.
 */
export function commandDecision(profile: AgentProfile, command: string, ctx: GateContext): Decision {
	// A cd is a session directory inside the cwd or the project notes folder.
	const notes = { path: undefined as string | undefined };
	const notesDir = (): string => (notes.path ??= ctx.notesDir ? ctx.notesDir() : "");
	const isSessionDir = (path: string): boolean => {
		if (insideDir(path, ctx.cwd)) return true;
		const dir = notesDir();
		return dir !== "" && insideDir(path, dir);
	};
	const raw = gateCommand(command, 0, { cwd: ctx.cwd, isSessionDir });
	const hits = profile === "companion" ? raw.map((hit) => (hit === "write" ? UNGATED : hit)) : raw;
	const gated = hits.filter((hit): hit is GateHit => hit !== UNGATED && hit !== SUPPORT);

	if (profile === "reviewer") {
		if (gated.length > 0) return { verdict: "deny", reason: denyReason(gated) };
		return { verdict: "allow", reason: "no gated segment" };
	}

	if (gated.includes("publish")) return { verdict: "ask", reason: PUBLISH_ASK };
	if (gated.length === 0) return { verdict: "ask", reason: UNGATED_ASK };
	const plainHistory = gated.every((hit) => hit === "history") && !hits.includes(UNGATED);
	if (!plainHistory) return { verdict: "ask", reason: MIXED_ASK };

	if (!isCommitCommand(command)) return { verdict: "allow", reason: "a git command" };

	// The gate reads the change in the session's cwd. A commit aimed at another
	// repository (a path option or a cd into one) would be judged against the
	// wrong tree, so it asks.
	if (namesAnotherRepo(command) || commitOutsideRepo(command, ctx.cwd)) {
		return { verdict: "ask", reason: OTHER_REPO_ASK };
	}

	const { change, key } = changeKey(ctx.cwd);
	if (isTrivial(change)) return { verdict: "allow", reason: "a trivial change needs no review before a commit", key };
	const review = reviewFor(ctx.stateDir, key);
	// The Stop hook writes the sub-session. A hand-written entry that omits it
	// is ignored; one that sets it is indistinguishable from a real record.
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
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const ctx: GateContext = {
		cwd,
		stateDir: stateDirOf(kiro),
		sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
		notesDir: () => projectDir(cwd, home),
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
