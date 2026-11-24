/**
 * The permission dialog and the `/permissions` command: ask the owner, apply
 * the answer to the session or a policy file, and report the rules.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePermissionsArgs } from "./commands.ts";
import { addRule, describeRules, initPolicyFile, loadPolicy, ruleTarget } from "./policy-file.ts";
import { decidePolicy, suggestGrant, type Rule, type Verdict } from "./policy.ts";
import { type Session } from "./session.ts";

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
export async function handleAsk(
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
export function permissionsCommand(pi: ExtensionAPI, session: Session, args: string, ctx: ExtensionContext): void {
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
	const ref = ruleTarget(session.refs, rule.project);
	if (!ref) {
		ctx.ui.notify("persona-agents: no project policy file, because Pi does not trust this project; nothing was written", "warning");
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
