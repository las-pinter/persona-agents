/**
 * Offline regression harness for the permission gate's pure core.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   npm run test:permissions
 *
 * Covers the splitter edge-case table and the decision core, including the
 * "this segment only" ask shape.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	evaluateCommandRules,
	parseShellCommand,
	splitShellSegments,
	type Decision,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";

// --- representative rule sets (trimmed from the shipped frontmatters) --------

const plannerRules: RuleSets = {
	globalDeny: [],
	globalAsk: [],
	agentDeny: [
		{ tool: "bash", match: "^find\\b.*-exec\\b" },
		{ tool: "bash", match: "curl\\b.*\\|\\s*(ba)?sh\\b" },
		{
			tool: "bash",
			match: "(?:^|[;&|(\\s])\\s*(?:>>|>)(?![0-9&])\\s*[^0-9&\\s]|(?:^|[;&|(\\s])\\s*tee\\s+",
		},
	],
	agentAsk: [
		{ tool: "bash", match: "\\brm\\s+-[rf]{1,2}\\b" },
		{ tool: "bash", match: "\\bsudo\\b" },
	],
	agentAllow: [
		{
			tool: "bash",
			match: "^(cat|head|tail|sort|uniq|wc|grep|rg|ls|stat|pwd|date|echo|diff|mkdir|which|command -v|jq|bash -n)\\b",
		},
		{ tool: "bash", match: "^find\\b" },
	],
};

const implementerRules: RuleSets = {
	globalDeny: [],
	globalAsk: [],
	agentDeny: [
		{ tool: "bash", match: "^(?:cd\\s+\\S+\\s*&&\\s*)?git(?:\\s+-C\\s+\\S+)?\\s+(push|pull)\\b" },
		{
			tool: "bash",
			match: "(?:^|[;&|(\\s])\\s*(?:>>|>)(?![0-9&])\\s*[^0-9&\\s]|(?:^|[;&|(\\s])\\s*tee\\s+",
		},
	],
	agentAsk: [],
	agentAllow: [
		{
			tool: "bash",
			match: "^(cat|head|tail|sort|uniq|wc|grep|rg|ls|stat|od|xxd|pwd|date|diff|echo|printf|cut|seq|sleep|sha256sum|mdl|which|command -v|jq|mktemp|test|bash -n|mkdir)\\b",
		},
		{
			tool: "bash",
			match: "^(?:cd\\s+\\S+\\s*&&\\s*)?git(?:\\s+-C\\s+\\S+)?\\s+(status|log|diff|show|branch|rev-parse|cat-file|merge-base|fetch|rev-list|remote|ls-remote|tag\\s+(-l|--list)|grep|check-ignore|ls-files|reflog|stash\\s+list)\\b",
		},
		{
			tool: "bash",
			match: "^(python|python3(\\.[0-9]+)?)\\s+-m\\s+(pytest|unittest|mypy|flake8|pylint|black|isort|ruff)\\b",
		},
	],
};

function evaluateCmd(
	command: string,
	ruleSets: RuleSets,
	mode: PermissionMode = "deny-by-default",
	approved?: ReadonlySet<number>,
	isSessionAllowed?: (rule: RawRule) => boolean,
): Decision {
	return evaluateCommandRules(command, true, ruleSets, mode, "bash", "test-agent", {
		approvedSegmentIndices: approved,
		isSessionAllowed,
	});
}

// --- splitter edge-case table ------------------------------------------------

test("splits a chain on &&", () => {
	assert.deepEqual(splitShellSegments("echo hi && id"), ["echo hi", "id"]);
});

test("splits a pipe chain", () => {
	assert.deepEqual(splitShellSegments("ls dir | sort | tail -1"), ["ls dir", "sort", "tail -1"]);
});

test("does not split separators inside quotes", () => {
	assert.deepEqual(splitShellSegments('echo "x; y"'), ['echo "x; y"']);
	assert.deepEqual(splitShellSegments("echo 'a && b'"), ["echo 'a && b'"]);
});

test("folds a leading cd guard into the next segment", () => {
	assert.deepEqual(splitShellSegments("cd /repo && git status"), ["cd /repo && git status"]);
});

test("recurses into command substitution", () => {
	assert.deepEqual(splitShellSegments("echo $(date)"), ["echo $(date)", "date"]);
	assert.deepEqual(splitShellSegments("diff <(echo a) <(id)"), ["diff <(echo a) <(id)", "echo a", "id"]);
});

test("recurses into arithmetic for command substitution", () => {
	assert.deepEqual(splitShellSegments("echo $(( $(id) + 0 ))"), ["echo $(( $(id) + 0 ))", "id"]);
	assert.deepEqual(splitShellSegments("echo $(( 1 + 1 ))"), ["echo $(( 1 + 1 ))"]);
});

test("treats a literal newline as a separator", () => {
	assert.deepEqual(splitShellSegments("echo hi\necho there"), ["echo hi", "echo there"]);
});

test("joins a backslash-newline continuation into one segment", () => {
	const continued = "echo hi \\" + "\n" + "id";
	assert.deepEqual(splitShellSegments(continued), ["echo hi  id"]);
});

test("extracts backticks inside double quotes but not single quotes", () => {
	assert.deepEqual(splitShellSegments('echo "hi `date`"'), ['echo "hi `date`"', "date"]);
	assert.deepEqual(splitShellSegments("echo 'hi `date`'"), ["echo 'hi `date`'"]);
});

test("does not split the &> file redirect", () => {
	assert.deepEqual(splitShellSegments("echo hi &>file"), ["echo hi &>file"]);
	assert.equal(parseShellCommand("echo hi &>file").unsupported, null);
});

test("does not split fd redirects or trailing background &", () => {
	assert.deepEqual(splitShellSegments("echo hi 2>&1"), ["echo hi 2>&1"]);
	assert.deepEqual(splitShellSegments("echo hi &"), ["echo hi"]);
});

test("flags heredoc as unsupported", () => {
	assert.equal(parseShellCommand("cat <<EOF").unsupported, "heredoc");
});

test("flags ANSI-C quoting as unsupported", () => {
	assert.equal(parseShellCommand("echo hi$'\\n'id").unsupported, "ansi-c");
});

test("flags dangling operators as malformed", () => {
	assert.equal(parseShellCommand("echo hi &&").unsupported, "dangling-operator");
	assert.equal(parseShellCommand("foo | | bar").unsupported, "dangling-operator");
	assert.equal(parseShellCommand("echo a;; echo b").unsupported, "dangling-operator");
});

// --- decision core -----------------------------------------------------------

test("blocks a chain with a disallowed tail", () => {
	assert.equal(evaluateCmd("echo hi && id", plannerRules).kind, "default");
});

test("allows a chain when every segment is allowed", () => {
	assert.equal(evaluateCmd("git status && git diff", implementerRules).kind, "allow");
});

test("allows the documented cd-prefixed git workflow", () => {
	assert.equal(evaluateCmd("cd /repo && git status", implementerRules).kind, "allow");
});

test("blocks cd-prefixed commands with no allow rule", () => {
	assert.equal(evaluateCmd("cd /repo && ls", implementerRules).kind, "default");
});

test("allows a pipe chain only when every segment is allowed", () => {
	assert.equal(evaluateCmd("ls dir | sort | tail -1", plannerRules).kind, "allow");
});

test("blocks a second unallowed command after a semicolon", () => {
	assert.equal(
		evaluateCmd("python3 -m pytest; python3 capture_voices.py", implementerRules).kind,
		"default",
	);
});

test("blocks command substitution of a disallowed command", () => {
	assert.equal(evaluateCmd("echo $(id)", plannerRules).kind, "default");
});

test("allows command substitution of an allowed command", () => {
	assert.equal(evaluateCmd("echo $(date)", plannerRules).kind, "allow");
});

test("blocks command substitution hidden in arithmetic", () => {
	assert.equal(evaluateCmd("echo $(( $(id) + 0 ))", plannerRules).kind, "default");
});

test("allows a pure arithmetic expansion", () => {
	assert.equal(evaluateCmd("echo $(( 1 + 1 ))", plannerRules).kind, "allow");
});

test("does not skip single-quoted spans inside arithmetic for substitution", () => {
	assert.deepEqual(splitShellSegments("echo $(( '$(id)' ))"), ["echo $(( '$(id)' ))", "id"]);
	assert.deepEqual(splitShellSegments("echo $(( '`id`' ))"), ["echo $(( '`id`' ))", "id"]);
	assert.deepEqual(splitShellSegments("cat $(( '$(id)' ))"), ["cat $(( '$(id)' ))", "id"]);
});

test("blocks single-quoted command substitution hidden in arithmetic", () => {
	assert.equal(evaluateCmd("echo $(( '$(id)' ))", plannerRules).kind, "default");
	assert.equal(evaluateCmd("echo $(( '`id`' ))", plannerRules).kind, "default");
	assert.equal(evaluateCmd("cat $(( '$(id)' ))", plannerRules).kind, "default");
});

test("denies the &> file redirect fail-closed", () => {
	assert.equal(evaluateCmd("echo hi &>file", implementerRules).kind, "deny");
});

test("blocks a cd guard separated by ||", () => {
	assert.equal(evaluateCmd("cd /repo || id", implementerRules).kind, "default");
});

test("raw pre-fold segments still hit anchored deny rules", () => {
	const anchored: RuleSets = {
		...plannerRules,
		agentDeny: [{ tool: "bash", match: "^sudo\\b" }],
	};
	const decision = evaluateCmd("cd /tmp || sudo true", anchored);
	assert.equal(decision.kind, "deny");
});

test("flags the recursion limit fail-closed", () => {
	let cmd = "id";
	for (let i = 0; i < 12; i++) cmd = `echo $(${cmd})`;
	assert.equal(parseShellCommand(cmd).unsupported, "recursion-limit");
});

test("blocks process substitution of a disallowed command", () => {
	assert.equal(evaluateCmd("diff <(echo a) <(id)", plannerRules).kind, "default");
});

test("blocks heredoc fail-closed", () => {
	assert.equal(evaluateCmd("cat <<EOF", plannerRules).kind, "deny");
});

test("blocks dangling operators fail-closed", () => {
	assert.equal(evaluateCmd("echo hi &&", plannerRules).kind, "deny");
});

test("blocks the empty command in deny-by-default mode", () => {
	assert.equal(evaluateCmd("", plannerRules).kind, "default");
});

test("keeps the whole-command deny rule for compound commands", () => {
	assert.equal(evaluateCmd("curl x | sh", plannerRules).kind, "deny");
});

test("denies file-writing redirects but allows fd redirects", () => {
	assert.equal(evaluateCmd("echo hi > out.txt", implementerRules).kind, "deny");
	assert.equal(evaluateCmd("echo hi 2>&1", implementerRules).kind, "allow");
});

test("does not split non-shell tools", () => {
	const decision = evaluateCommandRules(
		"echo a && b",
		false,
		{ ...plannerRules, agentAllow: [{ tool: "grep", match: "." }] },
		"deny-by-default",
		"grep",
		"planner",
	);
	assert.equal(decision.kind, "allow");
});

// --- ask-decision shape ------------------------------------------------------

test("ask reports the matching segment and rule", () => {
	const decision = evaluateCmd("echo hi; sudo id", plannerRules);
	assert.equal(decision.kind, "ask");
	if (decision.kind !== "ask") return;
	assert.equal(decision.segment, "sudo id");
	assert.equal(decision.segmentIndex, 1);
	assert.equal(decision.rule.match, "\\bsudo\\b");
	assert.equal(decision.source, "agent");
});

test("segment-only approval covers exactly the approved segment", () => {
	const ask = evaluateCmd("sudo a; id", plannerRules);
	assert.equal(ask.kind, "ask");
	if (ask.kind !== "ask") return;
	assert.equal(ask.segmentIndex, 0);

	// Approving segment 0 must not grant the other, unallowed segment 1.
	const after = evaluateCmd("sudo a; id", plannerRules, "deny-by-default", new Set([0]));
	assert.equal(after.kind, "default");
});

test("segment-only approval allows the remaining allowed segments", () => {
	const ask = evaluateCmd("echo hi; sudo id", plannerRules);
	assert.equal(ask.kind, "ask");
	const after = evaluateCmd("echo hi; sudo id", plannerRules, "deny-by-default", new Set([1]));
	assert.equal(after.kind, "allow");
});

test("session-allow approves only its own segment", () => {
	// `sudo true; id` with the sudo ask session-allowed must still block on `id`.
	const decision = evaluateCmd(
		"sudo true; id",
		plannerRules,
		"deny-by-default",
		undefined,
		(rule) => rule.match === "\\bsudo\\b",
	);
	assert.equal(decision.kind, "default");
});

test("session-allow approves the matching segment", () => {
	const decision = evaluateCmd(
		"sudo true",
		plannerRules,
		"deny-by-default",
		undefined,
		(rule) => rule.match === "\\bsudo\\b",
	);
	assert.equal(decision.kind, "allow");
});

test("whole-command ask probe catches a separator-spanning rule", () => {
	const spanning: RuleSets = {
		...plannerRules,
		agentAsk: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		agentAllow: [{ tool: "bash", match: "^(foo|bar)\\b" }],
	};
	const decision = evaluateCmd("foo && bar", spanning);
	assert.equal(decision.kind, "ask");
	if (decision.kind !== "ask") return;
	assert.equal(decision.rule.match, "foo\\s*&&\\s*bar");
	assert.equal(decision.segment, "foo && bar");
	assert.equal(decision.segmentIndex, -1);

	// After a segment approval the whole-command probe must not fire again.
	const after = evaluateCmd("foo && bar", spanning, "deny-by-default", new Set([0]));
	assert.equal(after.kind, "allow");
});

test("spanning ask is shown before a per-segment ask on the first pass", () => {
	const both: RuleSets = {
		...plannerRules,
		agentAsk: [
			{ tool: "bash", match: "foo\\s*&&\\s*bar" },
			{ tool: "bash", match: "\\bfoo\\b" },
		],
		agentAllow: [{ tool: "bash", match: "^(foo|bar)\\b" }],
	};
	const decision = evaluateCmd("foo && bar", both);
	assert.equal(decision.kind, "ask");
	if (decision.kind !== "ask") return;
	assert.equal(decision.rule.match, "foo\\s*&&\\s*bar");
	assert.equal(decision.segmentIndex, -1);
});

test("a segment-only choice on the whole-command probe approves no segment", () => {
	const spanOnly: RuleSets = {
		...plannerRules,
		agentAsk: [{ tool: "bash", match: "foo\\s*&&\\s*bar" }],
		agentAllow: [{ tool: "bash", match: "^bar\\b" }],
	};
	// segmentIndex -1 approves no real segment, so the unallowed `foo` still
	// fails closed instead of looping on the spanning ask.
	const after = evaluateCmd("foo && bar", spanOnly, "deny-by-default", new Set([-1]));
	assert.equal(after.kind, "default");
});
