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
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRegistry, promptSections, resolveTheme, themeNames, type Registry } from "../scripts/context.ts";
import { buildManifest, reloadContext, summaryInstructions, type EntryLike, type Manifest } from "../scripts/manifest.ts";
import { parsePermissionsArgs } from "../scripts/commands.ts";
import { startupContext } from "../scripts/notes.ts";
import { projectDir, projectName } from "../scripts/notes-paths.ts";
import { agentsDir, contentDir, homeDir } from "../scripts/paths.ts";
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
import {
	commitGate,
	isCommitCommand,
	isTrivial,
	makeChange,
	parseVerdict,
	reviewKey,
	reviewerPrompt,
	type Change,
	type Verdict as ReviewVerdict,
} from "../scripts/review.ts";

/** The message type of the read list, so a renderer can find it later. */
const READ_LIST = "persona-agents:read-list";
/** The message type of the reload list sent after a compaction. */
const RELOAD_LIST = "persona-agents:reload-list";
/** The section names this extension owns in the system prompt. */
const SECTIONS = ["profession", "persona", "platform"] as const;

interface Session {
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

function sessionId(): string {
	return process.env.PI_SESSION_ID || "unknown";
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

/** The reviewer's prompt: the agent file body, without its frontmatter. */
function reviewerBody(dir: string = agentsDir()): string {
	const file = join(dir, "reviewer.md");
	const text = readFileSync(file, "utf8");
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	return (match ? text.slice(match[0].length) : text).trim();
}

/** The change a commit would record: the diff, the untracked paths, and their fingerprint. */
async function readChange(pi: ExtensionAPI, cwd: string): Promise<Change> {
	const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
	let diff = await pi.exec("git", ["diff", "HEAD"], { cwd });
	if (diff.stdout.trim() === "") {
		// A clean tree commits nothing, so review the last commit instead.
		diff = await pi.exec("git", ["show", "HEAD", "--format="], { cwd });
	}
	const change = makeChange(diff.stdout, status.stdout);
	const signature = change.untracked
		.map((path) => {
			try {
				const stat = statSync(join(cwd, path));
				return `${path}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${path}:missing`;
			}
		})
		.join("\n");
	return { ...change, signature };
}

/** Run the reviewer in its own process: read-only tools, its own profile, its own gate. */
async function runReviewer(
	pi: ExtensionAPI,
	cwd: string,
	scope: string,
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
			reviewerPrompt(scope),
		],
		{ cwd, timeout: 300_000, signal },
	);
	const text = result.stdout.trim();
	return { text, verdict: parseVerdict(text) };
}

/** Run a review, remember its verdict for the exact change, and return the text. */
async function executeReview(
	pi: ExtensionAPI,
	session: Session,
	scope: string,
	signal?: AbortSignal,
): Promise<{ text: string; verdict: ReviewVerdict | null; key: string }> {
	const change = await readChange(pi, session.env.cwd);
	const key = reviewKey(change);
	const { text, verdict } = await runReviewer(pi, session.env.cwd, scope, signal);
	if (verdict) {
		session.reviews.set(key, verdict);
		pi.appendEntry("persona-agents:review", { at: new Date().toISOString(), key, verdict, files: change.files });
	}
	return { text, verdict, key };
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
		// Git failed: never block a commit on the gate's own tooling problem.
		return undefined;
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
			const { text, verdict } = await executeReview(pi, session, "");
			return { block: true, reason: `review finished: ${verdict ?? "no verdict"}. Fix what it asks, then commit again.\n\n${text}` };
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
			if (typeof theme === "string" && theme in session.registry) session.theme = theme;
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

	pi.on("before_agent_start", (event, _ctx) => {
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
		const text = startupContext(session.env.notesDir, projectName(session.env.cwd));
		return { message: { customType: READ_LIST, content: text, display: true } };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!session) return undefined;
		// Record what must survive, then let Pi's own summarizer run with our
		// focus. A model or auth failure here falls back to Pi's default summary;
		// the reload list still recovers the plan from the files.
		const manifest = buildManifest((event.branchEntries ?? []) as EntryLike[], session.env.notesDir);
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
		const manifest = session.manifest ?? buildManifest(ctx.sessionManager.getEntries() as EntryLike[], session.env.notesDir);
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
		if (decision.verdict === "allow") {
			if (logsAllows()) appendDecision(logFile(), decisionRecord(session.profile, event.toolName, input, decision, { session: sessionId() }));
			return undefined;
		}
		appendDecision(logFile(), decisionRecord(session.profile, event.toolName, input, decision, { session: sessionId() }));
		if (decision.verdict === "deny") return { block: true, reason: decision.reason };
		if (decision.verdict === "ask") return handleAsk(ctx, session, event.toolName, input, decision);
		// Allowed by policy: the companion still needs a review for a real commit.
		if (session.profile.name === "companion" && event.toolName === "bash" && typeof input.command === "string" && isCommitCommand(input.command)) {
			return reviewGate(pi, ctx, session);
		}
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

	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Run an independent, read-only review of the current change in a separate context. Returns findings with severity and location, and a verdict. Use it before committing a non-trivial change.",
		parameters: {
			type: "object",
			properties: { scope: { type: "string", description: "Optional: a base ref, commit range, or paths to review." } },
			additionalProperties: false,
		},
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!session) return { content: [{ type: "text", text: "persona-agents: not running as a persona-agents agent" }] };
			const scope = typeof params.scope === "string" ? params.scope : "";
			try {
				const { text, verdict, key } = await executeReview(pi, session, scope, signal);
				return {
					content: [{ type: "text", text: `${text}\n\nreview key: ${key}` }],
					details: { verdict, key },
				};
			} catch (error) {
				return { content: [{ type: "text", text: `the review could not run: ${(error as Error).message}` }], isError: true };
			}
		},
	});

	pi.registerCommand("review", {
		description: "Run an independent review of the current change",
		handler: (args, ctx) => {
			if (!session) {
				ctx.ui.notify("persona-agents: not running as a persona-agents agent", "warning");
				return;
			}
			executeReview(pi, session, args.trim())
				.then(({ text, verdict }) => {
					pi.sendMessage({ customType: "persona-agents:review", content: `## Review\n\n${verdict ?? "no verdict"}\n\n${text}`, display: true });
				})
				.catch((error: unknown) => ctx.ui.notify(`the review could not run: ${(error as Error).message}`, "error"));
		},
	});

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
