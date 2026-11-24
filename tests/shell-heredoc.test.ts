/**
 * Heredoc normalization in the shared shell gate: a quoted heredoc or a
 * single-quoted here-string that only feeds `git commit -F -` is data.
 *
 * Run: node --experimental-strip-types --test tests/shell-heredoc.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { commandSegments, gateCommand, normalizeHeredocs, SUPPORT, UNGATED, type GateOptions, type Hit } from "../platforms/shared/shell/gates.ts";
import { redirectTargets } from "../platforms/shared/shell/scan.ts";

function hits(command: string, options?: GateOptions): Hit[] {
	return [...new Set(gateCommand(command, 0, options))].sort();
}

const repo: GateOptions = {
	cwd: "/repo",
	isSessionDir: (path) => path === "/repo" || path.startsWith("/repo/"),
};

describe("heredocs: a message that only feeds git commit", () => {
	test("a quoted heredoc is removed and leaves a plain commit", () => {
		const command = "git commit -F - <<'EOF'\nmsg\nEOF";
		assert.equal(normalizeHeredocs(command).trim(), "git commit -F -");
		assert.deepEqual(hits(command), ["history"]);
	});

	test("a double-quoted delimiter is read the same way", () => {
		assert.deepEqual(hits('git commit -F - <<"EOF"\nmsg\nEOF'), ["history"]);
	});

	test("<<- strips tabs from the close line", () => {
		assert.deepEqual(hits("git commit -F - <<-'EOF'\n\tmsg\n\tEOF"), ["history"]);
	});

	test("a single-quoted here-string is removed", () => {
		assert.deepEqual(hits("git commit -F - <<<'msg'"), ["history"]);
	});

	test("a command inside the body is data, not a hit", () => {
		const command = "git commit -F - <<'EOF'\n$(git push)\ngit push\nEOF";
		assert.deepEqual(hits(command), ["history"]);
	});

	test("the observed chain: the pipe on the header line, the log after the close", () => {
		const chain = [
			"cd /repo && cargo fmt && git add -A && git commit -q -F - <<'EOF' | grep -v Passed | tail -5",
			"msg",
			"EOF",
			"git log --oneline -1",
		].join("\n");
		assert.deepEqual(hits(chain, repo), [SUPPORT, "history"].sort());
	});

	test("a redirect inside the message body is data", () => {
		assert.deepEqual(redirectTargets("git commit -F - <<'EOF'\nsee > /tmp/out\nEOF"), []);
		assert.deepEqual(redirectTargets("git commit -F - <<'EOF' > /tmp/head\nmsg\nEOF"), ["/tmp/head"]);
	});

	test("commandSegments sees the commit in a chain", () => {
		const chain = [
			"cd /repo && cargo fmt && git add -A && git commit -q -F - <<'EOF' | grep -v Passed | tail -5",
			"msg",
			"EOF",
			"git log --oneline -1",
		].join("\n");
		assert.ok(commandSegments(chain).some((segment) => /git commit -q -F -/.test(segment)));
	});
});

describe("heredocs: a form the gate does not read stays fail-closed", () => {
	const FAIL_CLOSED = [
		// Unquoted: the body expands.
		"git commit -F - <<EOF\nmsg\nEOF",
		// An expanding here-string.
		'git commit -F - <<<"$MSG"',
		// No -F -: the message is not on stdin.
		"git commit -m x <<'EOF'\nmsg\nEOF",
		// A file message, not stdin.
		"git commit -F msg <<'EOF'\nmsg\nEOF",
		// A wrapped commit.
		"sudo git commit -F - <<'EOF'\nmsg\nEOF",
		"/usr/bin/git commit -F - <<'EOF'\nmsg\nEOF",
		// No close line.
		"git commit -F - <<'EOF'\nmsg",
	];
	for (const command of FAIL_CLOSED) {
		test(JSON.stringify(command), () => {
			assert.deepEqual(hits(command), ["publish"]);
		});
	}

	test("a here-string keeps the rest of its line in the gate", () => {
		assert.deepEqual(hits("git commit -F - <<<'msg' && git push"), ["history", "publish"].sort());
		assert.deepEqual(hits("git commit -F - <<<'msg'; rm -rf x"), ["history", "write"].sort());
	});

	test("a token inside a comment is not a heredoc", () => {
		assert.deepEqual(hits("git commit -F - # <<'EOF'\ngit push\nEOF"), ["publish"]);
		assert.deepEqual(hits("git commit -F - #comment <<'EOF'\nmsg\nEOF"), ["publish"]);
	});

	test("a data heredoc for a plain reader is left to the existing path", () => {
		assert.deepEqual(hits("cat <<'EOF'\nhi\nEOF"), [UNGATED]);
	});
});
