/**
 * persona-agents for Pi — the wiring.
 *
 * `pi --agent persona-agents:companion` runs a Pi session as the companion: one
 * agent that plans, implements, tests, reviews, and commits with the owner, in
 * the voice of a persona theme. The logic lives in `../scripts/` as pure
 * modules; this file only connects it to Pi's events.
 *
 *   session_start      resolve the profile, resolve the theme, set the tools,
 *                      load the permission policy, show the footer
 *   before_agent_start the profession, the persona, and the platform note as
 *                      prompt sections; the startup read list as one message
 *   tool_call          the permission gate: allow, ask with the UI, or block
 *   session_compact    queue the reload list for the next run
 *
 * A session without `--agent persona-agents:<name>` gets no sections, no gate,
 * and no commands: a plain Pi session is unchanged. Every fault is contained:
 * a bad theme or an unreadable policy refuses the agent and says why, rather
 * than running half-configured.
 *
 * The file stays one module because every event handler shares the one session
 * object; splitting it would thread that state through several files.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadRegistry, promptSections, resolveTheme, themeNames, type Registry } from "../scripts/context.ts";
import { dayOf, entryPath, findEntry, recentJournal } from "../../shared/notes/journal.ts";
import { hasMaterial, sources, type Payload } from "../../shared/notes/journal-net.ts";
import { buildManifest, reloadContext, summaryInstructions, type EntryLike, type Manifest } from "../../shared/compaction/manifest.ts";
import { parsePermissionsArgs } from "../scripts/commands.ts";
import { startupContext } from "../../shared/notes/notes.ts";
import { projectDir, projectName } from "../../shared/notes/notes-paths.ts";
import {
	BUILTIN_TOOLS,
	journalLine,
	listLine,
	permissionsLine,
	retroLine,
	reviewLine,
	summarizeReview,
	toolCallLine,
} from "../scripts/summary.ts";
import { contentDir, homeDir } from "../scripts/paths.ts";
import { reviewerBody } from "../scripts/review-body.ts";
import {
	addRule,
	appendDecision,
	decidePolicy,
	decisionRecord,
	describeRules,
	initPolicyFile,
	loadPolicy,
	piAgentDir,
	suggestGrant,
	type PolicyEnv,
	type PolicyFileRef,
	type PolicyState,
	type Rule,
	type Verdict,
} from "../scripts/policy.ts";
import { DEFAULT_THEME, resolveProfile, type Profile } from "../scripts/profile.ts";
import { parseDecisions, RETRO_INSTRUCTION, sessionDecisions, summarizeSession, type DecisionLine } from "../../shared/retro/retro.ts";
import {
	buildBrief,
	commitGate,
	deriveTask,
	failedChange,
	finalizeBrief,
	isCommitCommand,
	isTrivial,
	isWorkingTreeScope,
	makeChange,
	oneLine,
	parseReviewArgs,
	parseVerdict,
	promptForBrief,
	reviewerFailure,
	reviewKey,
	REVIEWER_TIMEOUT_MS,
	subjectsFromQueries,
	untrackedFiles,
	type Brief,
	type BriefInput,
	type Change,
	type Verdict as ReviewVerdict,
} from "../../shared/review/review.ts";

/** The message type of the read list, so a renderer can find it later. */
const READ_LIST = "persona-agents:read-list";
/** The message type of the reload list sent after a compaction. */
const RELOAD_LIST = "persona-agents:reload-list";
/** The section names this extension owns in the system prompt. */
const SECTIONS = ["profession", "persona", "platform"] as const;
/** The plain text of a tool result or a message body. */
function bodyText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && "type" in part)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** One line that never wraps, whatever the terminal width. */
class CollapsedRow implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.text, width)];
	}

	invalidate(): void {}
}

/** A collapsed row: the mark, then the one line the summarizer built. */
function collapsedRow(theme: { fg(color: string, text: string): string }, line: string): Component {
	return new CollapsedRow(`${theme.fg("accent", "▸ ")}${line}`);
}

interface Session {
	/** The id of this Pi session, from its manager: an inherited env var is not it. */
	id: string;
	profile: Profile;
	theme: string;
	registry: Registry;
	env: PolicyEnv;
	policy: PolicyState;
	refs: PolicyFileRef[];
	/** The read list is sent on the first run, and again after a compaction. */
	startupSent: boolean;
	reloadPending: boolean;
	/** The manifest saved before a compaction, sent once the summary lands. */
	manifest: Manifest | null;
	/** Review verdicts, by the key of the change they cover. */
	reviews: Map<string, ReviewVerdict>;
	/** Set when the owner chose to stop asking about commits this session. */
	skipReview: boolean;
}

function policyRefs(cwd: string, trusted: boolean): PolicyFileRef[] {
	const refs: PolicyFileRef[] = [
		// The user file comes first in the list; loadPolicy orders by scope.
		{ path: join(piAgentDir(), "persona-agents", "policy.json"), scope: "user" },
	];
	if (trusted) refs.push({ path: join(cwd, ".pi", "persona-agents", "policy.json"), scope: "project" });
	return refs;
}

/** True when the log keeps allowed calls too (the audit trail is otherwise failures only). */
function logsAllows(): boolean {
	return process.env.PERSONA_AGENTS_DEBUG === "1";
}

/** Start the agent for this session, or return null and explain why. */
function startSession(pi: ExtensionAPI, ctx: ExtensionContext): Session | null {
	const raw = pi.getFlag("agent");
	if (typeof raw !== "string" || raw === "") return null;

	let profile: Profile | null;
	try {
		profile = resolveProfile(raw);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return null;
	}
	if (!profile) return null;

	const content = contentDir();
	const home = homeDir();
	let registry: Registry;
	let theme: string;
	try {
		registry = loadRegistry(content);
		const flag = pi.getFlag("persona");
		const wanted = typeof flag === "string" ? flag : process.env.PERSONA_AGENTS_THEME || DEFAULT_THEME;
		theme = resolveTheme(registry, wanted);
		// Read the sections once so a broken profession or persona refuses the
		// session now, not on the first tool call.
		promptSections(content, registry, theme, profile);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return null;
	}

	const notesDir = projectDir(ctx.cwd, home);
	const env: PolicyEnv = {
		cwd: ctx.cwd,
		home,
		notesDir,
		policyFiles: [],
		piAgentDir: piAgentDir(),
	};
	const refs = policyRefs(ctx.cwd, ctx.isProjectTrusted());
	env.policyFiles = refs.map((ref) => ref.path);
	const policy = loadPolicy(refs, profile.name);

	const session: Session = {
		id: ctx.sessionManager.getSessionId() || "unknown",
		profile,
		theme,
		registry,
		env,
		policy,
		refs,
		startupSent: false,
		reloadPending: false,
		manifest: null,
		reviews: new Map(),
		skipReview: false,
	};

	// Tools: add what the profile needs, remove what it must not hold, keep the
	// rest of the user's selection (MCP tools, other extensions' tools).
	const active = new Set(pi.getActiveTools());
	for (const name of profile.drop) active.delete(name);
	for (const name of profile.require) active.add(name);
	pi.setActiveTools([...active]);

	if (policy.errors.length > 0) {
		for (const error of policy.errors) ctx.ui.notify(`${error.message} — the gate fails closed until this is fixed`, "error");
	}
	ctx.ui.setStatus("persona-agents", `🎭 ${profile.name}${profile.persona ? ` · ${theme}` : ""}`);
	ctx.ui.notify(`persona-agents: ${profile.name} (${profile.persona ? theme : "no persona"}), notes: ${notesDir}`, "info");
	return session;
}

/** The permission policy after a file change, re-read so the next call sees it. */
function reloadPolicy(session: Session): void {
	session.policy = loadPolicy(session.refs, session.profile.name);
}

/** The ask dialog, by answer. A label is read once, from here. */
const ASK = {
	once: "Run once",
	session: "Always this session",
	project: "Always in this project",
	user: "Always for me",
	deny: "Deny",
} as const;
const ASK_OPTIONS: string[] = Object.values(ASK);

/** Handle one ask: ask the owner and apply the answer. Returns a block result or undefined. */
async function handleAsk(
	ctx: ExtensionContext,
	session: Session,
	tool: string,
	input: Record<string, unknown>,
	decision: { verdict: Verdict; reason: string },
): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) {
		return { block: true, reason: `${decision.reason} (no UI to ask here, so the call is denied)` };
	}
	const grant = suggestGrant(tool, input, session.env);
	const choice = await ctx.ui.select(`${decision.reason}\n\n${tool}: ${grant.matched}`, ASK_OPTIONS);
	if (choice === ASK.session) {
		session.policy.grants.push({ tool, match: grant.match, reason: decision.reason });
		ctx.ui.notify(`persona-agents: allowed for this session — ${tool} /${grant.match}/`, "info");
		return undefined;
	}
	if (choice === ASK.project || choice === ASK.user) {
		const scope = choice === ASK.project ? "project" : "user";
		const ref = session.refs.find((candidate) => candidate.scope === scope);
		if (!ref) {
			ctx.ui.notify("persona-agents: no project policy file; add the rule to your user policy instead", "warning");
			return { block: true, reason: decision.reason };
		}
		const rule: Rule = { tool, match: grant.match, verdict: "allow", reason: decision.reason };
		try {
			addRule(ref, session.profile.name, rule);
			reloadPolicy(session);
			ctx.ui.notify(`persona-agents: added an allow rule to ${ref.path}`, "info");
			return undefined;
		} catch (error) {
			ctx.ui.notify(`persona-agents: could not write ${ref.path}: ${(error as Error).message}`, "error");
			return { block: true, reason: decision.reason };
		}
	}
	if (choice === ASK.deny) {
		// A deny from the dialog is a decision for this once; say so plainly.
		ctx.ui.notify("persona-agents: denied; ask again or add a deny rule to the policy", "warning");
	}
	return { block: true, reason: decision.reason };
}

/** The text `/permissions` prints. */
function permissionsReport(session: Session): string {
	const lines = [
		`# Permissions — ${session.profile.id}`,
		"",
		`Policy files (project first when trusted):`,
		...session.refs.map((ref) => `- ${ref.scope}: ${ref.path}`),
		"",
		"## Rules (first match wins; the built-in doctrine decides when none match)",
		...describeRules(session.policy),
	];
	if (session.policy.grants.length > 0) {
		lines.push("", "## Session grants (this session only)", ...session.policy.grants.map((grant) => `- allow ${grant.tool} /${grant.match}/`));
	}
	if (session.policy.errors.length > 0) {
		lines.push("", "## Load errors — the gate fails closed", ...session.policy.errors.map((error) => `- ${error.message}`));
	}
	lines.push(
		"",
		"## Built-in floor (no file can loosen it)",
		"- credential and secret paths, destructive system commands, remote scripts piped to a shell",
		"- writes to git hooks, Pi settings, and the policy files themselves",
		"",
		"Narrow a rule with /permissions allow|ask|deny <tool> <regex> [--project].",
	);
	return lines.join("\n");
}

/** The text `/permissions check` prints for one command. */
function checkReport(session: Session, command: string): string {
	const input = { command };
	const decision = decidePolicy(session.profile, "bash", input, session.policy, session.env);
	return [
		`# ${decision.verdict} — ${command}`,
		"",
		`- source: ${decision.source}`,
		`- reason: ${decision.reason}`,
		...(decision.matched ? [`- matched: ${decision.matched}`] : []),
	].join("\n");
}

/** `/permissions` for a live session: list, explain, or edit the policy. */
function permissionsCommand(pi: ExtensionAPI, session: Session, args: string, ctx: ExtensionContext): void {
	const parsed = parsePermissionsArgs(args);
	if (parsed.action === "invalid") {
		ctx.ui.notify(parsed.message, "warning");
		return;
	}
	if (parsed.action === "list") {
		pi.sendMessage({ customType: "persona-agents:permissions", content: permissionsReport(session), display: true });
		return;
	}
	if (parsed.action === "check") {
		if (!parsed.command) {
			ctx.ui.notify("usage: /permissions check <shell command>", "warning");
			return;
		}
		pi.sendMessage({ customType: "persona-agents:permissions", content: checkReport(session, parsed.command), display: true });
		return;
	}
	if (parsed.action === "edit") {
		ctx.ui.notify(session.refs.map((ref) => `${ref.scope}: ${ref.path}`).join("\n"), "info");
		return;
	}
	if (parsed.action === "init") {
		const ref = session.refs.find((candidate) => candidate.scope === "user") ?? session.refs[0];
		initPolicyFile(ref);
		reloadPolicy(session);
		ctx.ui.notify(`persona-agents: policy file ready at ${ref.path}`, "info");
		return;
	}
	if (parsed.action !== "rule") {
		ctx.ui.notify("usage: /permissions allow|ask|deny <tool> <regex> [--project]", "warning");
		return;
	}
	const rule = parsed.rule;
	const ref = session.refs.find((candidate) => candidate.scope === (rule.project ? "project" : "user")) ?? session.refs[0];
	if (!ref) {
		ctx.ui.notify("persona-agents: no policy file to write", "warning");
		return;
	}
	try {
		addRule(ref, session.profile.name, { tool: rule.tool, match: rule.match, verdict: rule.verdict, reason: rule.reason });
		reloadPolicy(session);
		const errors = session.policy.errors.map((error) => error.message);
		ctx.ui.notify(
			errors.length > 0 ? `persona-agents: rule added, but the policy does not load: ${errors[0]}` : `persona-agents: ${rule.verdict} rule added to ${ref.path}`,
			errors.length > 0 ? "error" : "info",
		);
	} catch (error) {
		ctx.ui.notify(`persona-agents: ${(error as Error).message}`, "error");
	}
}

/** `/persona` for a live session: show or switch the theme. */
function personaCommand(pi: ExtensionAPI, session: Session, args: string, ctx: ExtensionContext): void {
	const wanted = args.trim();
	if (wanted === "") {
		ctx.ui.notify(`persona-agents: theme ${session.theme}; available: ${themeNames(session.registry).join(", ")}`, "info");
		return;
	}
	try {
		session.theme = resolveTheme(session.registry, wanted);
	} catch (error) {
		ctx.ui.notify((error as Error).message, "error");
		return;
	}
	pi.appendEntry("persona-agents:theme", { theme: session.theme });
	ctx.ui.setStatus("persona-agents", `🎭 ${session.profile.name}${session.profile.persona ? ` · ${session.theme}` : ""}`);
	ctx.ui.notify(`persona-agents: theme ${session.theme} applies from your next message`, "info");
}

/** The command and arguments that start another Pi process. */
function piInvocation(): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script] };
	return { command: "pi", args: [] };
}

/** The change a commit would record: the diff, the untracked paths, and their fingerprint. */
async function readChange(pi: ExtensionAPI, cwd: string): Promise<Change> {
	// Keep non-ASCII paths readable; a space still quotes, and `unquotePath` undoes it.
	const quote = ["-c", "core.quotePath=false"];
	// `-uall` lists each file of an untracked directory, not just the folder.
	const status = await pi.exec("git", [...quote, "status", "--porcelain", "-uall"], { cwd });
	let diff = await pi.exec("git", [...quote, "diff", "HEAD"], { cwd });
	if (diff.stdout.trim() === "" && status.stdout.trim() === "") {
		// A clean tree commits nothing, so review the last commit instead.
		diff = await pi.exec("git", [...quote, "show", "HEAD", "--format="], { cwd });
	}
	const change = makeChange(
		diff.stdout,
		status.stdout,
		"",
		// An untracked file is not in the diff; its lines still count toward the
		// trivial-change limit. A file over the cap is measured by size, not read.
		untrackedFiles(status.stdout).map((path) => {
			const full = join(cwd, path);
			try {
				const size = statSync(full).size;
				if (size > 1024 * 1024) return "\n".repeat(Math.ceil(size / 1024));
				return readText(full) ?? "";
			} catch {
				return "";
			}
		}),
	);
	// A failed read is not a small change; the gate must ask.
	if (status.code !== 0 || diff.code !== 0) return failedChange();
	// The signature hashes every changed file's worktree content and mode, so
	// the key is the same before and after `git add` and changes on a chmod.
	const signature = [...change.files]
		.sort()
		.map((path) => {
			try {
				// Git tracks only the executable bit, so the key does too. A file
				// over the cap is measured by size and mtime, not read whole.
				const stat = statSync(join(cwd, path));
				const mode = stat.mode & 0o111 ? "exec" : "file";
				if (stat.size > 1024 * 1024) return `${path}:${mode}:${stat.size}:${stat.mtimeMs}`;
				const content = createHash("sha256").update(readFileSync(join(cwd, path))).digest("hex");
				return `${path}:${mode}:${content}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("\n");
	return { ...change, signature };
}

/** Read a file for the brief: its text, or null when it cannot be read. */
function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * The brief one review starts from: the author's fields cut once, then the
 * missing ones filled from the notes. Git is asked for commit subjects only
 * when the notes name no task, so a study review costs no git call.
 */
async function prepareBrief(
	pi: ExtensionAPI,
	session: Session,
	input: BriefInput,
): Promise<{ brief: Brief; dropped: string; notes: string[] }> {
	const prepared = buildBrief(input);
	const indexPath = join(session.env.notesDir, "studies", "index.md");
	// Absent is normal (""), unreadable is not (null), and the two are not the same note.
	const indexText = existsSync(indexPath) ? readText(indexPath) : "";
	const finalized = finalizeBrief(prepared.brief, prepared.given, {
		notesDir: session.env.notesDir,
		indexText,
		readFile: readText,
	});
	let brief = finalized.brief;
	// No scope means the uncommitted change, which has no commits of its own.
	if (finalized.needsSubjects && brief.scope !== "") {
		const subjects = await subjectsFromQueries(brief.scope, async (args) => pi.exec("git", args, { cwd: session.env.cwd }));
		brief = { ...brief, task: deriveTask("", "", subjects) };
	}
	return { brief, dropped: prepared.dropped, notes: finalized.notes };
}

/** Run the reviewer in its own process: read-only tools, its own profile, its own gate. */
async function runReviewer(
	pi: ExtensionAPI,
	cwd: string,
	brief: Brief,
	signal?: AbortSignal,
): Promise<{ text: string; verdict: ReviewVerdict | null }> {
	const invocation = piInvocation();
	const result = await pi.exec(
		invocation.command,
		[
			...invocation.args,
			// The child loads this extension explicitly, so the reviewer profile and
			// its policy apply even when the package is not installed.
			"--extension",
			fileURLToPath(import.meta.url),
			"-p",
			"--no-session",
			"--agent",
			"persona-agents:reviewer",
			"--tools",
			"read,grep,find,ls,bash",
			"--append-system-prompt",
			reviewerBody(),
			promptForBrief(brief),
		],
		{ cwd, timeout: REVIEWER_TIMEOUT_MS, signal },
	);
	const failure = reviewerFailure({ ...result, aborted: signal?.aborted === true });
	if (failure !== "") throw new Error(failure);
	const text = result.stdout.trim();
	return { text, verdict: parseVerdict(text) };
}

/** A review request: the fields the caller holds, and the text it dropped. */
interface ReviewRequest {
	input: BriefInput;
	/** Text the caller removed before the fields, named back in the result. */
	dropped?: string;
}

/**
 * Run a review, remember its verdict for the exact change, and return the
 * reviewer's text with the key and the notes that belong beside it.
 */
async function executeReview(
	pi: ExtensionAPI,
	session: Session,
	request: ReviewRequest,
	signal?: AbortSignal,
): Promise<{ text: string; verdict: ReviewVerdict | null; key: string; notes: string[] }> {
	const change = await readChange(pi, session.env.cwd);
	const prepared = await prepareBrief(pi, session, request.input);
	// Only a review of the whole working tree unlocks a commit of it. A named
	// ref, range, or path list did not see the uncommitted change.
	const key = isWorkingTreeScope(prepared.brief.scope) ? reviewKey(change) : "";
	const notes = [...prepared.notes];
	const dropped = [prepared.dropped, request.dropped ?? ""].filter((part) => part !== "").join("\n");
	if (dropped !== "") notes.push(`ignored brief text: "${oneLine(dropped, 200)}"`);
	if (key === "") notes.push("the scope is not the uncommitted change, so this review does not unlock a commit");
	const { text, verdict } = await runReviewer(pi, session.env.cwd, prepared.brief, signal);
	if (verdict && key !== "") {
		session.reviews.set(key, verdict);
		pi.appendEntry("persona-agents:review", { at: new Date().toISOString(), key, verdict, files: change.files });
	}
	return { text, verdict, key, notes };
}

/** The ask when a commit has no covering review. */
async function reviewGate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: Session,
): Promise<{ block: true; reason: string } | undefined> {
	if (session.skipReview) return undefined;
	let change: Change;
	try {
		change = await readChange(pi, session.env.cwd);
	} catch {
		// A failed read is unknown, not trivial: ask rather than allow silently.
		return { block: true, reason: "the change could not be read, so this commit needs your approval" };
	}
	const key = reviewKey(change);
	const gate = commitGate({ trivial: isTrivial(change), reviewed: session.reviews.get(key) ?? null });
	if (gate.verdict === "allow") return undefined;
	if (!ctx.hasUI) return { block: true, reason: gate.reason };
	const shape = `${change.files.length} files, +${change.addedLines} -${change.removedLines}`;
	const choice = await ctx.ui.select(`${gate.reason}\n\n${shape}`, [
		"Run the review now",
		"Commit anyway",
		"Always allow this session",
		"Cancel",
	]);
	if (choice === "Commit anyway") return undefined;
	if (choice === "Always allow this session") {
		session.skipReview = true;
		return undefined;
	}
	if (choice === "Run the review now") {
		try {
			const { text, verdict, notes } = await executeReview(pi, session, { input: {} });
			const extra = notes.map((note) => `\n${note}`).join("");
			return { block: true, reason: `review finished: ${verdict ?? "no verdict"}. Fix what it asks, then commit again.\n\n${text}${extra}` };
		} catch (error) {
			return { block: true, reason: `the review could not run: ${(error as Error).message}` };
		}
	}
	return { block: true, reason: gate.reason };
}

export default function personaAgents(pi: ExtensionAPI): void {
	let session: Session | null = null;

	pi.registerFlag("agent", {
		description: 'Run as a persona-agents agent, e.g. "persona-agents:companion"',
		type: "string",
	});
	pi.registerFlag("persona", {
		description: `Persona theme for the companion (default ${DEFAULT_THEME})`,
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		session = null;
		session = startSession(pi, ctx);
		if (!session) {
			ctx.ui.setStatus("persona-agents", undefined);
			return;
		}
		// A theme chosen with /persona earlier in this session survives a reload.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "persona-agents:theme") continue;
			const theme = (entry.data as { theme?: unknown } | undefined)?.theme;
			if (typeof theme === "string" && Object.hasOwn(session.registry, theme)) session.theme = theme;
		}
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "persona-agents:review") continue;
			const data = entry.data as { key?: unknown; verdict?: unknown } | undefined;
			if (typeof data?.key === "string" && typeof data.verdict === "string" && ["Approve", "Request Changes", "Reject"].includes(data.verdict)) {
				session.reviews.set(data.key, data.verdict as ReviewVerdict);
			}
		}
		ctx.ui.setStatus("persona-agents", `🎭 ${session.profile.name}${session.profile.persona ? ` · ${session.theme}` : ""}`);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!session) return undefined;
		const options = event.systemPromptOptions;
		const sections = promptSections(contentDir(), session.registry, session.theme, session.profile);
		// Set ours and delete a stale one, so a theme or profile change never
		// leaves an old section in the prompt Pi patches.
		for (const name of SECTIONS) {
			if (sections[name]) options.sections[name] = sections[name];
			else delete options.sections[name];
		}
		options.promptGuidelines.push(
			"Do the work yourself in one context; use a subagent only for an independent review or a wide read-only search.",
			"Keep chat short: what changed, what you verified, what is next.",
			"Code, commits, notes, studies, and journals stay persona-free.",
		);
		if (session.startupSent && !session.reloadPending) return undefined;
		session.startupSent = true;
		session.reloadPending = false;
		const text = startupContext(session.env.notesDir, projectName(session.env.cwd), ctx.sessionManager.getSessionId());
		return { message: { customType: READ_LIST, content: text, display: true } };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!session) return undefined;
		// Record what must survive, then let Pi's own summarizer run with our
		// focus. A model or auth failure here falls back to Pi's default summary;
		// the reload list still recovers the plan from the files.
		const manifest = buildManifest((event.branchEntries ?? []) as EntryLike[], session.env.notesDir, ctx.sessionManager.getSessionId());
		session.manifest = manifest;
		const own = summaryInstructions(manifest);
		const instructions = event.customInstructions ? `${event.customInstructions}\n\n${own}` : own;
		const model = ctx.model;
		if (!model) return undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			// Pi supplies this module at runtime; importing it lazily keeps the
			// extension loadable (and testable) without Pi present.
			const { compact } = await import("@earendil-works/pi-coding-agent");
			const compaction = await compact(
				event.preparation,
				model,
				auth.apiKey,
				auth.headers,
				instructions,
				event.signal,
				ctx.thinkingLevel,
			);
			return { compaction };
		} catch (error) {
			// A cancelled compaction is not a failure worth a notice; Pi handles it.
			if (!event.signal.aborted) {
				ctx.ui.notify(`persona-agents: keeping Pi's default summary: ${(error as Error).message}`, "warning");
			}
			return undefined;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!session) return;
		const manifest =
			session.manifest ?? buildManifest(ctx.sessionManager.getEntries() as EntryLike[], session.env.notesDir, ctx.sessionManager.getSessionId());
		session.manifest = null;
		pi.appendEntry("persona-agents:compacted", {
			at: new Date().toISOString(),
			reason: event.reason,
			skills: manifest.skills.length,
			docs: manifest.docs.length,
		});
		// Deliver now: steer mid-run, store when idle. The next run then does
		// not send the startup list again.
		pi.sendMessage(
			{ customType: RELOAD_LIST, content: reloadContext(manifest), display: true },
			ctx.isIdle() ? {} : { deliverAs: "steer" },
		);
		session.startupSent = true;
		session.reloadPending = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!session) return undefined;
		const input = event.input ?? {};
		const decision = decidePolicy(session.profile, event.toolName, input, session.policy, session.env);
		if (decision.verdict === "deny") {
			appendDecision(logFile(), decisionRecord(session.profile, event.toolName, input, decision, { session: session.id }));
			return { block: true, reason: decision.reason };
		}
		if (decision.verdict === "ask") {
			appendDecision(logFile(), decisionRecord(session.profile, event.toolName, input, decision, { session: session.id }));
			return handleAsk(ctx, session, event.toolName, input, decision);
		}
		// Allowed by policy: the companion still needs a review for a real commit.
		if (session.profile.name === "companion" && event.toolName === "bash" && typeof input.command === "string" && isCommitCommand(input.command)) {
			const gate = await reviewGate(pi, ctx, session);
			if (gate) return gate;
		}
		if (logsAllows()) appendDecision(logFile(), decisionRecord(session.profile, event.toolName, input, decision, { session: session.id }));
		return undefined;
	});

	pi.registerCommand("permissions", {
		description: "Show or edit the persona-agents permission policy",
		handler: (args, ctx) => {
			if (!session) {
				ctx.ui.notify("persona-agents: not running as a persona-agents agent (start with --agent persona-agents:companion)", "warning");
				return;
			}
			permissionsCommand(pi, session, args, ctx);
		},
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (!session || event.reason !== "quit" || session.profile.name !== "companion") return;
		const notesDir = session.env.notesDir;
		const at = new Date();
		const yesterday = new Date(at.getTime() - 86_400_000);
		// A wrap-up already ran, or the session wrote nothing worth an entry.
		if (findEntry(notesDir, session.id, [dayOf(at), dayOf(yesterday)])) return;
		const payload: Payload = {
			session: session.id,
			notesDir,
			at: at.toISOString(),
			pi: piInvocation(),
			sources: sources(ctx.sessionManager.getEntries() as EntryLike[], notesDir),
		};
		if (!hasMaterial(payload.sources)) return;
		try {
			const dir = join(piAgentDir(), "persona-agents");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `journal-${session.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
			writeFileSync(file, JSON.stringify(payload));
			// Detached: a shutdown must not wait for a model, and this process is
			// about to exit. The writer removes its own payload.
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../scripts/journal-writer.ts", import.meta.url)), file],
				{ detached: true, stdio: "ignore", env: { ...process.env, PERSONA_AGENTS_JOURNAL_WRITER: "1" } },
			);
			child.unref();
		} catch {
			// A journal entry is a convenience; a failed spawn is not worth an error.
		}
	});

	pi.registerTool({
		name: "journal",
		label: "Journal",
		description:
			"This session's journal entry: `path` for where it goes, `write` to save the whole entry there, `recent` to read the last days. Use `path` first when you wrap up.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["path", "write", "recent"] },
				text: { type: "string", description: "The complete entry, for action `write`." },
				days: { type: "number", description: "For `recent`: how many day folders, default 3." },
			},
			required: ["action"],
			additionalProperties: false,
		},
		renderResult(result, { expanded }, theme) {
			const text = bodyText(result.content);
			if (expanded) return new Text(text, 0, 0);
			return collapsedRow(theme, journalLine(text));
		},
		async execute(_toolCallId, params) {
			if (!session) return { content: [{ type: "text", text: "persona-agents: not running as a persona-agents agent" }], isError: true };
			const notesDir = session.env.notesDir;
			const action = String(params.action);
			if (action === "path") {
				const path = entryPath(notesDir, session.id);
				return { content: [{ type: "text", text: path }], details: { path } };
			}
			if (action === "write") {
				const text = typeof params.text === "string" ? params.text : "";
				if (text.trim() === "") return { content: [{ type: "text", text: "journal write needs the entry text" }], isError: true };
				const path = entryPath(notesDir, session.id);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
				return { content: [{ type: "text", text: `journal entry written: ${path}` }], details: { path } };
			}
			if (action === "recent") {
				const days = typeof params.days === "number" && params.days > 0 ? Math.min(params.days, 30) : 3;
				const entries = recentJournal(notesDir, days);
				return {
					content: [
						{
							type: "text",
							text: entries.length ? entries.map((entry) => `<!-- ${entry.path} -->\n${entry.text}`).join("\n\n") : "no journal entries",
						},
					],
				};
			}
			return { content: [{ type: "text", text: "journal action must be path, write, or recent" }], isError: true };
		},
	});

	pi.registerCommand("retro", {
		description: "Print-only retrospective of this session, from the facts it recorded",
		handler: (_args, ctx) => {
			if (!session) {
				ctx.ui.notify("persona-agents: not running as a persona-agents agent", "warning");
				return;
			}
			let decisions: DecisionLine[] = [];
			try {
				decisions = sessionDecisions(parseDecisions(readFileSync(logFile(), "utf8")), session.id);
			} catch {
				// No log yet is normal: the retro then runs on the entries alone.
			}
			const entry = entryPath(session.env.notesDir, session.id);
			const facts = summarizeSession({
				entries: ctx.sessionManager.getEntries() as EntryLike[],
				decisions,
				journal: existsSync(entry) ? [entry] : [],
			});
			pi.sendMessage(
				{ customType: "persona-agents:retro", content: `${RETRO_INSTRUCTION}\n\n${facts}`, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Run an independent, read-only review of the current change in a separate context. Returns findings with severity and location, and a verdict. Use it before committing a non-trivial change. The brief says what was done and where, never what to check.",
		parameters: {
			type: "object",
			properties: {
				scope: { type: "string", description: "Optional: a base ref, commit range, or paths to review. Other text in it is dropped and named back." },
				task: { type: "string", description: "Optional: one line, the goal and the study task id. Derived from the study in progress when left out." },
				decisions: { type: "string", description: "Optional: the file that holds the owner decisions, or `none`. Derived from the study in progress when left out." },
			},
			additionalProperties: false,
		},
		renderResult(result, { expanded }, theme) {
			const text = bodyText(result.content);
			if (expanded) return new Text(text, 0, 0);
			// A failed review is never summarized into a clean-looking row.
			if (result.isError) return collapsedRow(theme, `review  failed: ${oneLine(text, 120)}`);
			return collapsedRow(theme, reviewLine(summarizeReview(text)));
		},
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!session) return { content: [{ type: "text", text: "persona-agents: not running as a persona-agents agent" }], isError: true };
			const input: BriefInput = {};
			if (typeof params.scope === "string") input.scope = params.scope;
			if (typeof params.task === "string") input.task = params.task;
			if (typeof params.decisions === "string") input.decisions = params.decisions;
			try {
				const { text, verdict, key, notes } = await executeReview(pi, session, { input }, signal);
				const extra = notes.map((note) => `\n${note}`).join("");
				return {
					content: [{ type: "text", text: `${text}\n\nreview key: ${key}${extra}` }],
					details: { verdict, key, notes },
				};
			} catch (error) {
				return { content: [{ type: "text", text: `the review could not run: ${(error as Error).message}` }], isError: true };
			}
		},
	});

	pi.registerCommand("review", {
		description: "Run an independent review of the current change: a scope, or scope=/task=/decisions= labels",
		handler: (args, ctx) => {
			if (!session) {
				ctx.ui.notify("persona-agents: not running as a persona-agents agent", "warning");
				return;
			}
			const parsed = parseReviewArgs(args);
			executeReview(pi, session, { input: parsed.input, dropped: parsed.dropped })
				.then(({ text, verdict, notes, key }) => {
					const extra = notes.map((note) => `\n${note}`).join("");
					pi.sendMessage({
						customType: "persona-agents:review",
						content: `## Review\n\n${verdict ?? "no verdict"}\n\n${text}${extra}\n\nreview key: ${key}`,
						display: true,
					});
				})
				.catch((error: unknown) => ctx.ui.notify(`the review could not run: ${(error as Error).message}`, "error"));
		},
	});

	pi.registerToolRenderer((toolName, next) => {
		if (!BUILTIN_TOOLS.has(toolName)) return next();
		const base = next();
		return {
			...base,
			renderCall: (args, theme, context) => {
				// Expanded, the owner wants the real call: Pi's own renderer, or the line.
				if (context?.expanded) return base?.renderCall?.(args, theme, context) ?? new Text(toolCallLine(toolName, args), 0, 0);
				return collapsedRow(theme, toolCallLine(toolName, args));
			},
		};
	});

	pi.registerMessageRenderer("persona-agents:review", (message, options, theme) => {
		const text = bodyText(message.content);
		if (options.expanded) return new Text(text, 0, 0);
		return collapsedRow(theme, reviewLine(summarizeReview(text)));
	});

	pi.registerMessageRenderer("persona-agents:permissions", (message, options, theme) => {
		const text = bodyText(message.content);
		if (options.expanded) return new Text(text, 0, 0);
		return collapsedRow(theme, permissionsLine(text));
	});

	pi.registerMessageRenderer("persona-agents:retro", (message, options, theme) => {
		const text = bodyText(message.content);
		if (options.expanded) return new Text(text, 0, 0);
		return collapsedRow(theme, retroLine(text));
	});

	for (const [type, name] of [[READ_LIST, "read list"], [RELOAD_LIST, "reload list"]] as const) {
		pi.registerMessageRenderer(type, (message, options, theme) => {
			const text = bodyText(message.content);
			if (options.expanded) return new Text(text, 0, 0);
			return collapsedRow(theme, listLine(name, text));
		});
	}

	pi.registerCommand("persona", {
		description: "Show or change the persona theme for this session",
		handler: (args, ctx) => {
			if (!session) {
				ctx.ui.notify("persona-agents: not running as a persona-agents agent", "warning");
				return;
			}
			personaCommand(pi, session, args, ctx);
		},
	});

}

/** The decisions log: `<pi agent dir>/persona-agents/decisions.ndjson`. */
function logFile(): string {
	return join(piAgentDir(), "persona-agents", "decisions.ndjson");
}
