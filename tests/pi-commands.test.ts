/**
 * The `/permissions` argument grammar (platforms/pi/scripts/commands.ts).
 *
 * A mistyped command must say what it wanted, never add a rule nobody meant.
 *
 * Run: node --experimental-strip-types --test tests/pi-commands.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parsePermissionsArgs, visualizeMessage } from "../platforms/pi/scripts/commands.ts";

describe("pi commands: /permissions arguments", () => {
	test("an empty argument or list asks for the report", () => {
		assert.deepEqual(parsePermissionsArgs(""), { action: "list" });
		assert.deepEqual(parsePermissionsArgs("  list "), { action: "list" });
	});

	test("init and edit name the files", () => {
		assert.deepEqual(parsePermissionsArgs("init"), { action: "init" });
		assert.deepEqual(parsePermissionsArgs("edit"), { action: "edit" });
	});

	test("check takes the rest of the line as the command", () => {
		assert.deepEqual(parsePermissionsArgs("check git push"), { action: "check", command: "git push" });
		assert.deepEqual(parsePermissionsArgs("check"), { action: "invalid", message: "usage: /permissions check <shell command>" });
	});

	test("a rule carries its verdict, tool, and pattern", () => {
		assert.deepEqual(parsePermissionsArgs("allow bash ^git push"), {
			action: "rule",
			rule: { verdict: "allow", tool: "bash", match: "^git push", reason: undefined, project: false },
		});
		assert.deepEqual(parsePermissionsArgs("deny * secrets"), {
			action: "rule",
			rule: { verdict: "deny", tool: "*", match: "secrets", reason: undefined, project: false },
		});
	});

	test("a reason follows an em dash or a spaced pipe", () => {
		assert.equal(parsePermissionsArgs("deny bash ^rm — never touch the tree").action, "rule");
		const dash = parsePermissionsArgs("deny bash ^rm — never touch the tree");
		assert.ok(dash.action === "rule");
		assert.equal(dash.rule.reason, "never touch the tree");
		assert.equal(dash.rule.match, "^rm");

		const piped = parsePermissionsArgs("ask bash ^npm publish | releases are the owner's call");
		assert.ok(piped.action === "rule");
		assert.equal(piped.rule.reason, "releases are the owner's call");
		assert.equal(piped.rule.match, "^npm publish");
	});

	test("a regex may keep its own alternation and anchors", () => {
		const piped = parsePermissionsArgs("allow bash ^git (push|fetch)\\b");
		assert.ok(piped.action === "rule");
		assert.equal(piped.rule.match, "^git (push|fetch)\\b");
	});

	test("--project targets the repository policy file", () => {
		const parsed = parsePermissionsArgs("allow bash ^npm test --project");
		assert.ok(parsed.action === "rule");
		assert.equal(parsed.rule.project, true);
		assert.equal(parsed.rule.match, "^npm test");
	});

	test("a regex that does not compile is refused before any file is written", () => {
		const parsed = parsePermissionsArgs("allow bash ^npm (run");
		assert.equal(parsed.action, "invalid");
		if (parsed.action === "invalid") assert.match(parsed.message, /^not a valid regex/);
	});

	test("a mistyped command is refused with the usage line", () => {
		for (const args of ["maybe bash x", "allow", "allow bash", "allow bash   "]) {
			const parsed = parsePermissionsArgs(args);
			assert.equal(parsed.action, "invalid", args);
			if (parsed.action === "invalid") assert.match(parsed.message, /^usage: \/permissions/);
		}
	});
});

describe("pi commands: /visualize message", () => {
	const skill = "/pkg/content/skills/visualize/SKILL.md";

	test("the message names the skill file", () => {
		const message = visualizeMessage(skill, "");
		assert.match(message, /^Read the visualize skill at \/pkg\/content\/skills\/visualize\/SKILL\.md and follow it\.$/m);
	});

	test("the argument travels verbatim, trimmed", () => {
		const message = visualizeMessage(skill, "  slides the review flow — for the team ");
		assert.match(message, /^Argument: slides the review flow — for the team$/m);
	});

	test("an empty argument asks for the default one-pager", () => {
		for (const args of ["", "   "]) {
			assert.match(visualizeMessage(skill, args), /^Argument: none \(the default html one-pager about this session\)\.$/m, JSON.stringify(args));
		}
	});
});
