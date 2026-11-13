/**
 * One tool call for the pi permission gate.
 *
 * `permissions.ts` owns the compiled rule sources and the install wiring. This
 * module owns one call: the caller checks, the verdict order, the ask path, and
 * the single approve-and-retry step both ask paths share. The verdict order is
 * fixed: deny, ask, allow, the skill-script rescue, then the mode default.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./resolver.ts";
import { evaluateCommandRules, type RawRule, type RuleSets } from "./command-segments.ts";
import type { OverlayRules } from "./permission-config.ts";
import {
	buildPromptModel,
	blockedLabel,
	DENIED_BY_USER_REASON,
	renderRootPermissionPrompt,
	type PermissionChoice,
} from "./permission-prompt.ts";
import { SHELL_PROBES, isShellTool } from "./shell-tools.ts";
import { childAskQueue } from "./child-ask.ts";
import { UNKNOWN_RUN_REASON, type RunRecord, type RunRegistry } from "./run-registry.ts";
import { sessionIdOf } from "./session-id.ts";
import type { GateRuleSourceFactory } from "./permissions.ts";

/**
 * The structural rescue `permissions.ts` hands in: it is exported and tested
 * there, so the gate call receives it rather than importing it back.
 */
export type SkillScriptRescue = (
	command: string,
	approvedSegmentIndices: ReadonlySet<number>,
	skillScriptsDirs: string[],
	cwd: string,
	ruleSets: RuleSets,
	toolName: string,
	isSessionAllowed?: (rule: RawRule) => boolean,
) => boolean;

/** Everything one call reads, built once per installed gate. */
export interface GateCallInput {
	event: ToolCallEvent;
	ctx: ExtensionContext;
	getActiveAgent: () => AgentConfig | null;
	source: GateRuleSourceFactory;
	registry: RunRegistry;
	overlay: OverlayRules;
	sessionAllow: Set<string>;
	derivedSkillScriptDirs: (agent: AgentConfig, cwd: string) => string[];
	allSegmentsAreSkillScripts: SkillScriptRescue;
}

/**
 * The grant key. One answer covers one session, role, tool, and rule.
 * A key that lacks one part would lend the grant to a sibling or the root.
 */
function grantKey(sessionId: string, role: string, toolName: string, ruleId: string): string {
	return `${sessionId}|${role}|${toolName}|${ruleId}`;
}

function probeFor(toolName: string, input: Record<string, unknown>): string {
	// The shell field comes from the shell-tool owner, so a new shell tool lands once.
	const shellField = SHELL_PROBES.get(toolName);
	if (shellField !== undefined) return String(input[shellField] ?? "");
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "edit":
		case "write":
			return String(input.path ?? input.pattern ?? input.glob ?? "");
		default:
			return JSON.stringify(input);
	}
}

/** The agent fields the gate reads, for a child whose record names its own role. */
const NO_AGENT: AgentConfig = { name: "", description: "", systemPrompt: "", source: "user", filePath: "" };

/**
 * The child agent. Its identity comes from the run record. A project child
 * therefore keeps its own source and its own skill lists, never the root's.
 */
function childAgentOf(record: Readonly<RunRecord>): AgentConfig {
	return {
		...NO_AGENT,
		name: record.role,
		permissionClass: record.class,
		source: record.source,
		skills: record.skills,
		alwaysLoad: record.alwaysLoad,
	};
}

/**
 * Approve the matched segment and evaluate the rest of the call again. A
 * spanning ask approves no segment, so the call runs now.
 */
function retryAfterApproval(args: {
	approvedSegments: Set<number>;
	evaluateRound: () => Promise<ToolCallEventResult | undefined>;
	isShell: boolean;
	segmentIndex: number;
}): Promise<ToolCallEventResult | undefined> {
	if (!args.isShell || args.segmentIndex < 0) return Promise.resolve(undefined);
	args.approvedSegments.add(args.segmentIndex);
	return args.evaluateRound();
}

/** Evaluate one tool call and return the verdict, or undefined to run it. */
export async function evaluateCall(call: GateCallInput): Promise<ToolCallEventResult | undefined> {
	const {
		allSegmentsAreSkillScripts,
		ctx,
		derivedSkillScriptDirs,
		event,
		getActiveAgent,
		overlay,
		registry,
		sessionAllow,
		source,
	} = call;
	const toolName = event.toolName;
	const input = (event.input ?? {}) as Record<string, unknown>;
	if (toolName.startsWith("mcp__") || toolName.includes(".")) return undefined;

	// A child answer must not cover its sibling or the root.
	const sessionId = sessionIdOf(ctx);
	const routing = childAskQueue();
	if (routing && sessionId) routing.noteContext(sessionId, ctx);
	const record = sessionId ? registry.get(sessionId) : undefined;
	// The depth comes from the registry walk, never from the record's own copy.
	// A record that under-reports its depth is still judged as the child it is.
	const walk = sessionId ? registry.walk(sessionId) : null;
	const depth = walk !== null && walk.ok ? walk.depth : null;
	// Assumption: a context with no session id is the root. pi always supplies
	// one, so that fallback keeps its pre-child behaviour and stays unreachable.
	// A bound registry with no record for the caller denies. The live root role
	// must not cover an id the registry never saw.
	if (sessionId && !record) {
		return { block: true, reason: UNKNOWN_RUN_REASON };
	}
	// A walk that stops short places no depth, so the caller cannot be judged
	// as a root. It is refused rather than given the root role.
	if (sessionId && walk !== null && !walk.ok) {
		return { block: true, reason: `Blocked: broken parent chain at session ${walk.failureId}` };
	}
	// The child agent comes from its own record, never from the root.
	const childRecord = depth === 0 ? undefined : record;
	const agent: AgentConfig | null = childRecord ? childAgentOf(childRecord) : getActiveAgent();

	// MCP and namespaced tools (mcp__context7__…, server.tool, …) are never
	// gated by this regex gate — deliberate: they are research/read-only
	// services or extension namespaces, and child subagents are already
	// limited to their `tools:` loadout. The gate exists to
	// constrain bash/read/edit/write/etc. tool calls.
	const probe = probeFor(toolName, input);
	const fromSource = source(agent);
	const mode = fromSource.mode;
	const isShell = isShellTool(toolName);
	const skillDirs = isShell && agent ? derivedSkillScriptDirs(agent, ctx.cwd) : [];
	// The table rows come first, then the live overlay. Deny wins by order, so an
	// overlay row can only add a verdict; it can never loosen a table row.
	const ruleSets: RuleSets = {
		globalDeny: [...fromSource.ruleSets.globalDeny, ...overlay.deny],
		agentDeny: fromSource.ruleSets.agentDeny,
		globalAsk: [...fromSource.ruleSets.globalAsk, ...overlay.ask],
		agentAsk: fromSource.ruleSets.agentAsk,
		agentAllow: fromSource.ruleSets.agentAllow,
	};
	// The root keeps its live role; a child keeps the role its record fixed at the build.
	const grantRole = (depth === 0 ? undefined : record?.role) ?? agent?.name ?? "<none>";
	const sessionKey = (match: string): string =>
		grantKey(sessionId ?? "<none>", grantRole, toolName, match);
	const isSessionAllowed = (rule: RawRule): boolean => sessionAllow.has(sessionKey(rule.match));

	// User-approved segments ("Always allow" on a segment) for THIS call.
	const approvedSegments = new Set<number>();

	// Resolve asks round by round: a segment "Always allow" approves exactly
	// one segment, then the remaining segments are re-evaluated.
	const evaluateRound = async (): Promise<ToolCallEventResult | undefined> => {
		const decision = evaluateCommandRules(probe, isShell, ruleSets, mode, toolName, agent?.name ?? null, {
			approvedSegmentIndices: approvedSegments,
			isSessionAllowed,
		});

		if (decision.kind === "deny") {
			return { block: true, reason: decision.reason };
		}
		if (decision.kind === "default") {
			// The regex verdict fell through to deny-by-default. A loaded skill's
			// real script is the one structural exception. Segments an allow rule
			// already matched are skipped, so a mixed command works. Deny and ask
			// already won above, so this can never override them.
			if (
				skillDirs.length > 0 &&
				allSegmentsAreSkillScripts(
					probe,
					approvedSegments,
					skillDirs,
					ctx.cwd,
					ruleSets,
					toolName,
					isSessionAllowed,
				)
			) {
				return undefined;
			}
			return { block: true, reason: decision.reason };
		}
		if (decision.kind === "allow") return undefined;

		// decision.kind === "ask"
		const rule = decision.rule;
		const key = sessionKey(rule.match);

		// The rule's regex is never shown; the model drops a reason that repeats it.
		const promptModel = buildPromptModel({
			toolName,
			probe,
			segment: decision.segment,
			segmentStart: decision.segmentStart,
			reason: rule.reason,
			match: rule.match,
			source: decision.source,
			agentName: agent?.name ?? null,
			isSpanning: decision.segmentIndex === -1,
		});

		// A child ask has no UI of its own, so it goes to the root queue and waits
		// for the owner. The captured root surface renders the shared prompt, and
		// the answer becomes the child verdict. Depth 0 is the caller itself, so a
		// root ask stays on the inline path below.
		if (routing && record && sessionId && depth !== 0) {
			const outcome = await routing.enqueue({
				sessionId,
				role: record.role,
				toolName,
				key,
				model: promptModel,
				remember: (grant) => sessionAllow.add(grant),
			});
			if (outcome.kind === "block") return { block: true, reason: outcome.reason };
			if (outcome.alwaysAllow) {
				return retryAfterApproval({
					approvedSegments,
					evaluateRound,
					isShell,
					segmentIndex: decision.segmentIndex,
				});
			}
			return undefined;
		}

		if (!ctx.hasUI) {
			// Fail closed. The label is stable and never the rule regex.
			return {
				block: true,
				reason: blockedLabel(toolName, decision.source, agent?.name ?? null, rule.reason, rule.match),
			};
		}

		const choice: PermissionChoice = await renderRootPermissionPrompt(ctx, promptModel);

		if (choice === "always-allow") {
			sessionAllow.add(key); // remembered for the rest of the session
			return retryAfterApproval({
				approvedSegments,
				evaluateRound,
				isShell,
				segmentIndex: decision.segmentIndex,
			});
		}
		if (choice === "allow-once") {
			return undefined; // user approved — allow this call once
		}
		return { block: true, reason: DENIED_BY_USER_REASON };
	};

	return evaluateRound();
}
