/**
 * The refused rows of the permission rule table.
 *
 * The file holds the compile refusals only.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { validateRows, type RuleRow } from "./permission-table.ts";
import type { Role } from "./permission-class.ts";

// --- refused rows -----------------------------------------------------------

function bashRow(over: Partial<RuleRow> = {}): RuleRow {
	return {
		id: "probe.row",
		tool: "bash",
		verdict: "deny",
		classes: ["reader"],
		verb: ["echo"],
		arg: "any",
		reason: "probe row",
		...over,
	};
}

function probeRow(over: Partial<RuleRow> = {}): RuleRow {
	return {
		id: "probe.shape",
		tool: "bash",
		verdict: "deny",
		classes: ["reader"],
		probe: "stream-write",
		arg: "any",
		reason: "probe shape",
		...over,
	};
}

test("an unknown field fails the load and names the row", () => {
	const row = { ...bashRow(), pattern: "x" } as unknown as RuleRow;
	assert.throws(() => validateRows([row]), /probe\.row.*unknown field "pattern"/);
});

test("a row that names an unknown profession fails the load and names the row", () => {
	assert.throws(
		() => validateRows([bashRow({ roles: ["captain"] as unknown as Role[] })]),
		/probe\.row.*unknown profession "captain"/,
	);
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["planner"] })]),
		/probe\.row.*profession "planner" is outside the row's classes/,
	);
});

test("a blank row id prints the placeholder word, never a blank name", () => {
	for (const id of ["", " ", " \t "]) {
		assert.throws(() => validateRows([bashRow({ id })]), /row "<missing>": id must be lower-case/);
	}
});

test("a forbidden regex character fails the load and names the row", () => {
	assert.throws(() => validateRows([bashRow({ verb: ["rm|sh"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ sub: ["a.*b"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ verb: ["(cat)"] })]), /probe\.row.*forbidden regex character/);
});

test("a regex character in a verb or a dotted tool name fails the load", () => {
	// A dot is data and the compiler escapes it: `checkout -- .` is a legal sub.
	assert.doesNotThrow(() => validateRows([bashRow({ sub: ["checkout -- ."] })]));
	assert.throws(() => validateRows([bashRow({ verb: ["foo|bar"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ verb: ["foo.bar*"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ tool: "bash.x" })]), /probe\.row.*plain lower-case name/);
});

test("an ask row with flags any and no span fails the load", () => {
	assert.throws(
		() => validateRows([bashRow({ verdict: "ask", flags: "any" })]),
		/probe\.row.*must set span/,
	);
	assert.doesNotThrow(() => validateRows([bashRow({ verdict: "ask", flags: "any", span: true })]));
});

test("unnamed must be a boolean on a roles row", () => {
	assert.doesNotThrow(() =>
		validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: true })]),
	);
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: "yes" as never })]),
		/probe\.row.*unnamed must be a boolean/,
	);
	// A false value widens nothing, so the schema refuses it instead of ignoring it.
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: false })]),
		/probe\.row.*omit a false value/,
	);
	// A row with no `roles` already joins the class compile, so unnamed is empty.
	assert.throws(() => validateRows([bashRow({ unnamed: true })]), /probe\.row.*must name roles/);
});

test("a probe row must be a deny row and carries no verb", () => {
	assert.doesNotThrow(() => validateRows([probeRow()]));
	assert.throws(() => validateRows([probeRow({ verdict: "ask" })]), /probe\.shape.*must be a deny row/);
	assert.throws(() => validateRows([probeRow({ verb: ["tee"] })]), /probe\.shape.*carries no verb/);
	assert.throws(() => validateRows([probeRow({ probe: "unknown" as never })]), /probe\.shape.*unknown probe/);
});

test("two rows with one id and two verdicts fail the load and name the row", () => {
	const deny = bashRow();
	const allow = bashRow({ verdict: "allow", classes: ["worker"] });
	assert.throws(() => validateRows([deny, allow]), /probe\.row.*conflicting verdict/);
});

test("two rows with one id and two geometries fail the load and name the row", () => {
	const first = bashRow();
	const second = bashRow({ verb: ["printf"] });
	assert.throws(() => validateRows([first, second]), /probe\.row.*conflicting geometry/);
	const third = bashRow({ reason: "another sentence" });
	assert.throws(() => validateRows([first, third]), /probe\.row.*conflicting geometry/);
});

test("a shared id with the same verdict and geometry is accepted", () => {
	assert.doesNotThrow(() => validateRows([bashRow(), bashRow({ classes: ["orchestrator"] })]));
});
