/**
 * The argument handling of the `/permissions` and `/visualize` commands.
 *
 * Kept out of the extension wiring so the grammar is testable: a mistyped
 * command should say what it wanted, not add a rule nobody meant.
 *
 *   /permissions                              list
 *   /permissions check <shell command>        explain one decision
 *   /permissions init                         create the user policy file
 *   /permissions edit                         print the file paths
 *   /permissions allow|ask|deny <tool> <regex> [— reason] [--project]
 *
 *   /visualize [html|slides|md] [focus]       the visualize skill, with the text as its argument
 */

import type { Verdict } from "./policy.ts";

export interface RuleArgs {
	verdict: Verdict;
	tool: string;
	match: string;
	reason?: string;
	project: boolean;
}

export type ParsedArguments =
	| { action: "list" | "init" | "edit" }
	| { action: "check"; command: string }
	| { action: "rule"; rule: RuleArgs }
	| { action: "invalid"; message: string };

const USAGE = "usage: /permissions [list|check <cmd>|init|edit|allow|ask|deny <tool> <regex> [— reason] [--project]]";

/** Parse the text after `/permissions`. */
export function parsePermissionsArgs(args: string): ParsedArguments {
	const text = args.trim();
	if (text === "" || text === "list") return { action: "list" };
	if (text === "init") return { action: "init" };
	if (text === "edit") return { action: "edit" };
	if (text === "check") return { action: "invalid", message: "usage: /permissions check <shell command>" };
	if (text.startsWith("check ")) return { action: "check", command: text.slice("check ".length).trim() };

	const project = /(^|\s)--project\s*$/.test(text);
	const body = project ? text.replace(/\s*--project\s*$/, "") : text;
	const head = /^(allow|ask|deny)\s+(\S+)\s+(\S[\s\S]*)$/.exec(body);
	if (!head) return { action: "invalid", message: USAGE };
	const [, verdict, tool, rest] = head;
	// A reason follows an em dash or a spaced pipe, so a regex may keep both.
	const [pattern, ...reasonWords] = rest.split(/\s+—\s+|\s+\|\s+/u);
	const match = pattern.trim();
	if (match === "") return { action: "invalid", message: USAGE };
	try {
		new RegExp(match);
	} catch (error) {
		return { action: "invalid", message: `not a valid regex: ${(error as Error).message}` };
	}
	return {
		action: "rule",
		rule: {
			verdict: verdict as Verdict,
			tool,
			match,
			reason: reasonWords.join(" ").trim() || undefined,
			project,
		},
	};
}

/**
 * The message `/visualize` sends. Pi does not expand `$ARGUMENTS` in a skill
 * file, so the argument travels in the message; the skill's Pi branch reads it
 * from here.
 */
export function visualizeMessage(skillFile: string, args: string): string {
	const argument = args.trim();
	return [
		`Read the visualize skill at ${skillFile} and follow it.`,
		argument === "" ? "Argument: none (the default html one-pager about this session)." : `Argument: ${argument}`,
	].join("\n");
}
