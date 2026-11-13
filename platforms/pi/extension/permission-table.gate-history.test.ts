/**
 * The shipped verdicts for gated history and release verbs in the permission
 * rule table.
 *
 * Every case here reads the shipped decision for a gated verb: an allow, an
 * ask, or a deny. The row-shape and fence cases stay in
 * permission-table.gate.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { type Role } from "./permission-class.ts";
import {
	ANCHORED_HISTORY, ASK_EXCEPTIONS, CHAIN_ALLOW, grant, OVER_ASK, PLAIN_HISTORY,
	rowReason, shippedDecision, shippedVerdict, STILL_ASK, TAG_DELETE, WRAPPED_DEFAULT,
} from "./permission-table.test-helpers.ts";

// --- history verdicts -------------------------------------------------------

test("a plain history form allows for the orchestrator", () => {
	for (const probe of PLAIN_HISTORY) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("the git -C, pager-flag, and cd-fold forms of a plain history command allow", () => {
	for (const probe of ANCHORED_HISTORY) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("a chain of plain history commands allows", () => {
	for (const probe of CHAIN_ALLOW) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("a chain with a blocked npm form does not allow", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "git add . && npm test"), "allow");
	assert.equal(shippedVerdict("orchestrator", "bash", "git add . && npm test -- --watch"), "default");
});

test("a tag force-move asks", () => {
	for (const probe of ASK_EXCEPTIONS["tag force-move"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a commit --amend form asks", () => {
	for (const probe of ASK_EXCEPTIONS["commit --amend"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a quoted separator before an exception asks", () => {
	for (const probe of ASK_EXCEPTIONS["quoted separator before an exception"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a git -c override asks", () => {
	for (const probe of ASK_EXCEPTIONS["git -c override"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a brace expansion in a history command asks", () => {
	for (const probe of ASK_EXCEPTIONS["brace expansion"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a glob word in a history command asks", () => {
	for (const probe of ASK_EXCEPTIONS.glob) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a transport helper URL asks", () => {
	for (const probe of ASK_EXCEPTIONS["transport helper URL"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("an upload-pack option asks", () => {
	for (const probe of ASK_EXCEPTIONS["upload-pack"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a merge strategy asks", () => {
	for (const probe of ASK_EXCEPTIONS["merge strategy"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("an unknown git global option asks", () => {
	for (const probe of ASK_EXCEPTIONS["unknown global option"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a runtime-shaped history word asks", () => {
	for (const probe of ASK_EXCEPTIONS["runtime-shaped"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a wrapped history command asks", () => {
	for (const probe of ASK_EXCEPTIONS.wrapped) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("push, gh pr, gh run, gh release, and reset --soft ask", () => {
	for (const probe of STILL_ASK) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
	for (const probe of ["gh issue list", "gh runner list", "gh -R owner/repo run list"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
});

test("a quoted glob, brace, or option word over-asks", () => {
	for (const probe of OVER_ASK) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a tag delete denies", () => {
	for (const probe of TAG_DELETE) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "deny", probe);
	}
});

test("the bash -c and sh -c payloads fall to the mode default", () => {
	// The table holds no `bash -c` deny row, so the mode default blocks both forms.
	for (const probe of ["bash -c 'git commit -m x'", "sh -c 'git add .'"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
	for (const probe of WRAPPED_DEFAULT) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
});

// --- session grants ---------------------------------------------------------

const EXCEPTION_REASON = rowReason("git.history.exception");
const DIR_ASK_REASON = rowReason("git.dir-option.ask");

test("one exception row covers a pull strategy and an upload-pack, so one grant allows", () => {
	const probe = "git pull -s ours --upload-pack=evil /r";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: one exception row covers both forms, so one grant clears both.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("one exception row covers a brace and an upload-pack, so one grant allows", () => {
	const probe = "git pull {x,} --upload-pack=evil /r";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: the brace and the upload-pack sit in the same ask row.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("one exception row covers an amend and a glob, so one grant allows", () => {
	const probe = "git commit --amend *";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: the amend and the glob sit in the same ask row.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("a session grant on one of two matching asks still asks", () => {
	const probe = "git -C core.hooksPath commit --amend";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON)), "ask", probe);
});

test("a session grant on every matching ask allows", () => {
	const probe = "git -C core.hooksPath commit --amend";
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON, EXCEPTION_REASON)), "allow", probe);
});

test("the first ask that still blocks names its reason, and the next grant allows", () => {
	// Two orchestrator ask rows meet here: the dir-option ask and the exception ask.
	const probe = "git -C core.hooksPath commit --amend";
	const first = shippedDecision("orchestrator", "bash", probe, grant(DIR_ASK_REASON));
	assert.equal(first.kind, "ask", probe);
	if (first.kind !== "ask") return;
	assert.equal(first.rule.reason, EXCEPTION_REASON);
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON, first.rule.reason ?? "")), "allow", probe);
});

// --- non-orchestrator history -----------------------------------------------

test("a non-orchestrator never allows a plain history form", () => {
	for (const role of ["implementer", "tester", "planner", "reviewer", "researcher"] as Role[]) {
		for (const probe of [...PLAIN_HISTORY, ...ANCHORED_HISTORY]) {
			assert.equal(shippedVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the implementer denies gh run through a named row", () => {
	assert.equal(shippedVerdict("implementer", "bash", "gh run list"), "deny");
});

test("every non-orchestrator class denies gh run", () => {
	for (const role of ["planner", "reviewer", "researcher", "mascot", "implementer", "tester"] as Role[]) {
		assert.equal(shippedVerdict(role, "bash", "gh run list"), "deny", role);
	}
});
