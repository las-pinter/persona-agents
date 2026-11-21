/**
 * The shared shell gate (platforms/shared/shell/gates.ts): the inert `support`
 * class for a session cd, a read, a formatter, and a pipe filter.
 *
 * Run: node --experimental-strip-types --test tests/shell-gates.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { gateCommand, SUPPORT, UNGATED, type GateOptions, type Hit } from "../platforms/shared/shell/gates.ts";

/** The distinct hits of one command, sorted for a stable comparison. */
function hits(command: string, options?: GateOptions): Hit[] {
	return [...new Set(gateCommand(command, 0, options))].sort();
}

const repo: GateOptions = {
	cwd: "/repo",
	isSessionDir: (path) => path === "/repo" || path.startsWith("/repo/"),
};

describe("shell gate: reads are support", () => {
	for (const command of ["git status", "git log", "git diff", "git rev-parse HEAD", "git branch -a", "git remote -v", "git config --get user.name"]) {
		test(command, () => {
			assert.deepEqual(hits(command), [SUPPORT]);
		});
	}

	test("a git read with an expansion or a glob is not support", () => {
		assert.deepEqual(hits("git log $OPS && git add -A"), [UNGATED, "history"].sort());
		assert.deepEqual(hits("git config $X && git add -A"), [UNGATED, "history"].sort());
		assert.deepEqual(hits("git log *.ts && git add -A"), [UNGATED, "history"].sort());
		assert.deepEqual(hits("git log --output=/tmp/x && git add -A"), ["write", "history"].sort());
	});

	test("a read that runs a program, writes history, or reaches a remote is not support", () => {
		for (const command of [
			"git grep -O sh foo && git add -A",
			"git diff --ext-diff && git add -A",
			"git log --ext-diff && git add -A",
			"git show --textconv && git add -A",
			"git cat-file --filters HEAD:a && git add -A",
			"git help -w commit && git add -A",
			"git reflog expire --all && git add -A",
			"git remote show origin && git add -A",
		]) {
			assert.deepEqual(hits(command), [UNGATED, "history"].sort(), command);
		}
		assert.deepEqual(hits("git diff --no-ext-diff && git add -A"), [SUPPORT, "history"].sort());
	});
});

describe("shell gate: a formatter is support", () => {
	for (const command of ["cargo fmt", "rustfmt src/main.rs", "ruff format", "black .", "prettier --write src/a.ts", "gofmt -w main.go"]) {
		test(command, () => {
			assert.deepEqual(hits(command), [SUPPORT]);
		});
	}

	test("a non-formatter form of the same program is ungated", () => {
		assert.deepEqual(hits("cargo test"), [UNGATED]);
		assert.deepEqual(hits("ruff check --fix"), [UNGATED]);
		assert.deepEqual(hits("prettier src/a.ts"), [UNGATED]);
	});

	test("a glob in a formatter argument keeps support", () => {
		assert.deepEqual(hits("prettier --write src/*.ts"), [SUPPORT]);
	});

	test("a formatter with an output redirect is a write", () => {
		assert.deepEqual(hits("cargo fmt > out.txt"), ["write", SUPPORT].sort());
	});
});

describe("shell gate: a filter is support only in a pipe", () => {
	test("the observed filters are support", () => {
		assert.deepEqual(hits("git log | grep -v Passed | tail -5"), [SUPPORT]);
		assert.deepEqual(hits("git log | head -n 5"), [SUPPORT]);
		assert.deepEqual(hits("git log | wc -l"), [SUPPORT]);
		assert.deepEqual(hits("git log | sort -k1,1 | uniq -c"), [SUPPORT]);
	});

	test("a filter outside a pipe, or with a file, is ungated", () => {
		assert.deepEqual(hits("grep foo"), [UNGATED]);
		assert.deepEqual(hits("git log | grep foo file"), [SUPPORT, UNGATED].sort());
		assert.deepEqual(hits("git log | sort -o out"), [SUPPORT, UNGATED].sort());
		assert.deepEqual(hits("git log | tee out"), ["write", SUPPORT].sort());
	});

	test("a cd does not hand its pipe to the next command", () => {
		assert.deepEqual(hits("git log | cd /repo && sort -k1", repo), [SUPPORT, UNGATED].sort());
	});
});

describe("shell gate: a wrapped or substituted part is not support", () => {
	for (const command of ["sudo cargo fmt", "env cargo fmt", "xargs cargo fmt", "/usr/bin/cargo fmt", "bash -c 'cargo fmt'"]) {
		test(command, () => {
			assert.deepEqual(hits(command), [UNGATED]);
		});
	}

	test("a substitution anywhere demotes support", () => {
		assert.deepEqual(hits("cargo fmt $(pwd)"), [UNGATED]);
		assert.deepEqual(hits("git log $(pwd)"), [UNGATED]);
	});
});

describe("shell gate: a cd part", () => {
	test("a session target is support", () => {
		assert.deepEqual(hits("cd /repo && git commit -m x", repo), [SUPPORT, "history"].sort());
		assert.deepEqual(hits("cd /repo/sub && git commit -m x", repo), [SUPPORT, "history"].sort());
		assert.deepEqual(hits("cd /repo", repo), [SUPPORT]);
	});

	test("a target outside the session is ungated", () => {
		assert.deepEqual(hits("cd /elsewhere && git commit -m x", repo), [UNGATED, "history"].sort());
		assert.deepEqual(hits("cd - && git commit -m x", repo), [UNGATED, "history"].sort());
		assert.deepEqual(hits("cd /elsewhere", repo), [UNGATED]);
	});

	test("~ expands to the home folder", () => {
		const home: GateOptions = {
			cwd: "/repo",
			home: "/home/u",
			isSessionDir: (path) => path === "/home/u/agent-notes",
		};
		assert.deepEqual(hits("cd ~/agent-notes && git commit -m x", home), [SUPPORT, "history"].sort());
		assert.deepEqual(hits("cd ~ && git commit -m x", home), [UNGATED, "history"].sort());
	});

	test("a cd in one segment sets the directory for the next", () => {
		const work: GateOptions = {
			cwd: "/work/repo",
			isSessionDir: (path) => path === "/work" || path.startsWith("/work/"),
		};
		// From /work, `../evil` is outside the granted /work; from /work/repo it is not.
		assert.deepEqual(hits("cd /work && git add -A; cd ../evil && git commit -m x", work), [SUPPORT, UNGATED, "history"].sort());
		assert.deepEqual(hits("cd .. && git commit -m x", work), [SUPPORT, "history"].sort());
	});

	test("without a session predicate no cd is support", () => {
		assert.deepEqual(hits("cd /repo && git commit -m x"), [UNGATED, "history"].sort());
	});
});

describe("shell gate: the observed chain", () => {
	const chain =
		"cd /repo && cargo fmt && git add -A && git commit -q -F msg | grep -v Passed | tail -5; git log --oneline -1";

	test("inert parts plus history", () => {
		assert.deepEqual(hits(chain, repo), [SUPPORT, "history"].sort());
	});

	test("a publish in the chain is still a publish", () => {
		assert.deepEqual(hits("cd /repo && cargo fmt && git add -A && git push", repo), [SUPPORT, "history", "publish"].sort());
	});
});
