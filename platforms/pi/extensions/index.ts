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
 * A session without `--agent persona-agents:<name>` gets no sections and no
 * gate; the commands and tools are registered but refuse. Every fault is contained:
 * a bad theme or an unreadable policy refuses the agent and says why, rather
 * than running half-configured.
 *
 * The event handlers share one session object (`../scripts/session.ts`). The
 * permission dialog, the review run, and the row renderers that take it live in
 * `../scripts/`; this file keeps the handlers, the commands, and the tools.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadRegistry, promptSections, resolveTheme, themeNames, type Registry } from "../scripts/context.ts";
import { dayOf, entryPath, findEntry, recentSessionLogs } from "../../shared/notes/session-log.ts";
import { hasMaterial, sources, type Payload } from "../../shared/notes/session-log-net.ts";
import { buildManifest, reloadContext, summaryInstructions, type EntryLike } from "../../shared/compaction/manifest.ts";
import { startupContext } from "../../shared/notes/notes.ts";
import { projectDir, projectName } from "../../shared/notes/notes-paths.ts";
import {
	BUILTIN_TOOLS,
	sessionLogLine,
	listLine,
	permissionsLine,
	retroLine,
	reviewLine,
	summarizeReview,
	toolCallLine,
} from "../scripts/summary.ts";
import { contentDir, homeDir } from "../scripts/paths.ts";
import { appendDecision, loadPolicy, piAgentDir } from "../scripts/policy-file.ts";
import { decidePolicy, decisionRecord, type PolicyEnv, type PolicyFileRef } from "../scripts/policy.ts";
import { DEFAULT_THEME, resolveProfile, type Profile } from "../scripts/profile.ts";
import { parseDecisions, retroMessage, sessionDecisions, summarizeSession, type DecisionLine } from "../../shared/retro/retro.ts";
import { oneLine, parseReviewArgs, type BriefInput } from "../../shared/review/brief.ts";
import { isCommitCommand, type Verdict as ReviewVerdict } from "../../shared/review/review.ts";
import { type Session } from "../scripts/session.ts";
import { permissionsCommand, handleAsk } from "../scripts/permissions-ui.ts";
import { executeReview, piInvocation, reviewGate } from "../scripts/review-run.ts";
import { collapsedRow, bodyText } from "../scripts/render.ts";

/** The message type of the read list, so a renderer can find it later. */
const READ_LIST = "persona-agents:read-list";
/** The message type of the reload list sent after a compaction. */
const RELOAD_LIST = "persona-agents:reload-list";
/** The section names this extension owns in the system prompt. */
const SECTIONS = ["profession", "persona", "platform"] as const;

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

/** The status-line text: the profile, and the theme when it has a persona. */
function statusText(profile: Profile, theme: string): string {
	return `🎭 ${profile.name}${profile.persona ? ` · ${theme}` : ""}`;
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
	ctx.ui.setStatus("persona-agents", statusText(profile, theme));
	ctx.ui.notify(`persona-agents: ${profile.name} (${profile.persona ? theme : "no persona"}), notes: ${notesDir}`, "info");
	return session;
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
	ctx.ui.setStatus("persona-agents", statusText(session.profile, session.theme));
	ctx.ui.notify(`persona-agents: theme ${session.theme} applies from your next message`, "info");
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
		ctx.ui.setStatus("persona-agents", statusText(session.profile, session.theme));
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
			"Do the implementation, the tests, and the small look-ups yourself; send wide or costly research to a subagent and work from its summary.",
			"Keep chat short: what changed, what you verified, what is next.",
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
			const file = join(dir, `session-log-${session.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
			writeFileSync(file, JSON.stringify(payload));
			// Detached: a shutdown must not wait for a model, and this process is
			// about to exit. The writer removes its own payload.
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../scripts/session-log-writer.ts", import.meta.url)), file],
				{ detached: true, stdio: "ignore", env: { ...process.env, PERSONA_AGENTS_SESSION_LOG_WRITER: "1" } },
			);
			child.unref();
		} catch {
			// A session log is a convenience; a failed spawn is not worth an error.
		}
	});

	pi.registerTool({
		name: "session-log",
		label: "Session log",
		description:
			"This session's log: `path` for where it goes, `write` to save the whole entry there, `recent` to read the last days. Use `path` first when you wrap up.",
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
			return collapsedRow(theme, sessionLogLine(text));
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
				if (text.trim() === "") return { content: [{ type: "text", text: "session-log write needs the entry text" }], isError: true };
				const path = entryPath(notesDir, session.id);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
				return { content: [{ type: "text", text: `session log written: ${path}` }], details: { path } };
			}
			if (action === "recent") {
				const days = typeof params.days === "number" && params.days > 0 ? Math.min(params.days, 30) : 3;
				const entries = recentSessionLogs(notesDir, days);
				return {
					content: [
						{
							type: "text",
							text: entries.length ? entries.map((entry) => `<!-- ${entry.path} -->\n${entry.text}`).join("\n\n") : "no session logs",
						},
					],
				};
			}
			return { content: [{ type: "text", text: "session-log action must be path, write, or recent" }], isError: true };
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
				sessionLogs: existsSync(entry) ? [entry] : [],
			});
			pi.sendMessage(
				{ customType: "persona-agents:retro", content: retroMessage(join(contentDir(), "skills", "retro", "SKILL.md"), facts), display: true },
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
