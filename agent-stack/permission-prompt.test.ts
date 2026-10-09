/**
 * Unit tests for the pure permission-prompt model.
 *
 * Runs under plain Node (type stripping) with no dependencies:
 *   npm test
 *
 * `buildPromptModel` must never carry the rule regex, must show the human
 * reason, must name the blocked part with its index/total, and must keep the
 * four shell decisions and their meaning.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
	buildPromptModel,
	plainPromptTitle,
	type PromptModel,
} from "./permission-prompt.ts";

const REASON = "orchestrator commit requires user approval";
const REGEX = "(?:^|[;&|(\\n])\\s*git\\s+(push|pull)\\b";

function shellModel(overrides: Partial<Parameters<typeof buildPromptModel>[0]> = {}): PromptModel {
	return buildPromptModel({
		toolName: "bash",
		probe: 'git status && git commit -m "fix" && git push',
		segment: 'git commit -m "fix"',
		segmentIndex: 1,
		segmentCount: 3,
		reason: REASON,
		isSpanning: false,
		...overrides,
	});
}

function decisions(model: PromptModel): string[] {
	return model.options.map((option) => option.decision);
}

test("the Why line uses the human reason", () => {
	const model = shellModel();
	const why = model.lines.find((line) => line.startsWith("Why:"));
	assert.equal(why, `Why: ${REASON}`);
});

test("the model never carries the rule regex", () => {
	const model = shellModel();
	const text = JSON.stringify(model);
	assert.ok(!text.includes(REGEX));
	assert.ok(!model.lines.some((line) => line.includes("\\b")));
	assert.ok(!model.options.some((option) => option.label.includes(REGEX)));
});

test("the blocked part line names the segment and its index/total", () => {
	const model = shellModel();
	assert.notEqual(model.highlightIndex, -1);
	const blocked = model.lines[model.highlightIndex];
	assert.ok(blocked.includes("2 of 3"));
	assert.ok(blocked.includes('git commit -m "fix"'));
});

test("the blocked part line is zero-based-safe for the first segment", () => {
	const model = shellModel({ segment: "git status", segmentIndex: 0 });
	const blocked = model.lines[model.highlightIndex];
	assert.ok(blocked.includes("1 of 3"));
});

test("a shell segment prompt keeps the four decisions in order", () => {
	const model = shellModel();
	assert.equal(model.kind, "shell-segment");
	assert.deepEqual(decisions(model), [
		"deny",
		"allow-once-whole",
		"allow-once-segment",
		"always-allow",
	]);
});

test("the always-allow option states the remembered reason and session", () => {
	const model = shellModel();
	const always = model.options.find((option) => option.decision === "always-allow");
	assert.ok(always);
	assert.equal(model.remember, REASON);
	assert.ok(always.label.includes(REASON));
	assert.match(always.label, /session/i);
});

test("the always-allow detail line states the remembered reason and session", () => {
	const model = shellModel();
	const line = model.lines.find((line) => line.startsWith("Always allow remembers:"));
	assert.equal(line, `Always allow remembers: ${REASON} (session)`);
});

test("a non-bash tool shows the target and three simpler options", () => {
	const model = buildPromptModel({
		toolName: "read",
		probe: "/etc/hosts",
		segment: "/etc/hosts",
		segmentIndex: 0,
		segmentCount: 1,
		reason: "reading system host files",
		isSpanning: false,
	});
	assert.equal(model.kind, "target");
	assert.equal(model.target, "/etc/hosts");
	assert.equal(model.highlightIndex, -1);
	assert.deepEqual(decisions(model), ["deny", "allow-once-whole", "always-allow"]);
	const always = model.options.find((option) => option.decision === "always-allow");
	assert.ok(always?.label.includes("reading system host files"));
	assert.match(always?.label ?? "", /session/i);
});

test("a spanning probe shows the spanning note and keeps fail-closed decisions", () => {
	const model = shellModel({
		probe: "foo && bar",
		segment: "foo && bar",
		segmentIndex: -1,
		segmentCount: 2,
		isSpanning: true,
	});
	assert.equal(model.kind, "shell-spanning");
	assert.equal(model.highlightIndex, -1);
	assert.ok(model.lines.some((line) => /spans the whole command/i.test(line)));
	assert.deepEqual(decisions(model), [
		"deny",
		"allow-once-whole",
		"allow-once-segment",
		"always-allow",
	]);
});

test("a missing reason falls back without leaking the regex", () => {
	const model = shellModel({ reason: undefined });
	assert.equal(model.remember, "matches a permission rule");
	assert.ok(!JSON.stringify(model).includes(REGEX));
});

test("plainPromptTitle carries the target, blocked part, and Why", () => {
	const model = shellModel();
	const title = plainPromptTitle(model);
	assert.ok(title.includes(model.target));
	assert.ok(title.includes("Blocked part (2 of 3)"));
	assert.ok(title.includes(`Why: ${REASON}`));
});
