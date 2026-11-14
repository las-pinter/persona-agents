/**
 * Sidebar data tests for the git workspace parse: the porcelain status lines,
 * the numstat rows, the merge of the two, and the branch name.
 *
 * Run: npm test -- platforms/pi/extension/sidebar-data-git.test.ts
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createSidebarData } from "./sidebar-data.ts";
import {
	flush,
	makeCapturingPi,
	makeFakeCtx,
	readFiles,
} from "./sidebar-data-fixtures.ts";

// --- porcelain parsing -------------------------------------------------------

test("a porcelain rename keeps the destination path", async () => {
	const files = await readFiles({ status: { stdout: "R  old.ts -> new.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["new.ts"],
	);
});

test("a porcelain rename with spaces keeps the full destination path", async () => {
	const files = await readFiles({ status: { stdout: "R  old name.ts -> new name.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["new name.ts"],
	);
});

test("a porcelain path with spaces is kept whole", async () => {
	const files = await readFiles({ status: { stdout: " M a path/with spaces.ts" } });

	assert.deepEqual(
		files.map((file) => file.path),
		["a path/with spaces.ts"],
	);
});

test("a porcelain untracked line marks the file untracked", async () => {
	const files = await readFiles({ status: { stdout: "?? scratch file.ts" } });

	assert.deepEqual(files, [{ path: "scratch file.ts", added: 0, removed: 0, untracked: true }]);
});

// --- numstat parsing ---------------------------------------------------------

test("a normal numstat row carries added and removed counts", async () => {
	const files = await readFiles({
		status: { stdout: " M code.ts" },
		numstat: { stdout: "12\t3\tcode.ts" },
	});

	assert.deepEqual(files, [{ path: "code.ts", added: 12, removed: 3, untracked: false }]);
});

test("a binary numstat row counts zero added and removed lines", async () => {
	const files = await readFiles({
		status: { stdout: " M image.png" },
		numstat: { stdout: "-\t-\timage.png" },
	});

	assert.deepEqual(files, [{ path: "image.png", added: 0, removed: 0, untracked: false }]);
});

test("a numstat path with spaces is kept whole", async () => {
	const files = await readFiles({
		status: { stdout: " M a file with spaces.ts" },
		numstat: { stdout: "5\t2\ta file with spaces.ts" },
	});

	assert.equal(files[0]?.path, "a file with spaces.ts");
	assert.equal(files[0]?.added, 5);
	assert.equal(files[0]?.removed, 2);
});

test("an unbraced numstat rename resolves to the new path", async () => {
	const files = await readFiles({
		status: { stdout: "R  old name.ts -> new name.ts" },
		numstat: { stdout: "0\t0\told name.ts => new name.ts" },
	});

	assert.deepEqual(files, [{ path: "new name.ts", added: 0, removed: 0, untracked: false }]);
});

test("a braced numstat rename joins the directory and the new name", async () => {
	const files = await readFiles({
		status: { stdout: "R  dir/old.ts -> dir/new.ts" },
		numstat: { stdout: "0\t0\tdir/{old.ts => new.ts}" },
	});

	assert.deepEqual(
		files.map((file) => file.path),
		["dir/new.ts"],
	);
});

// --- combining status and numstat --------------------------------------------

test("an untracked file with no numstat row keeps untracked and zero stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts\n M code.ts" },
		numstat: { stdout: "3\t0\tcode.ts" },
	});

	assert.equal(files.length, 2);
	assert.deepEqual(files.find((file) => file.path === "scratch.ts"), {
		path: "scratch.ts",
		added: 0,
		removed: 0,
		untracked: true,
	});
	assert.deepEqual(files.find((file) => file.path === "code.ts"), {
		path: "code.ts",
		added: 3,
		removed: 0,
		untracked: false,
	});
});

test("a numstat-only path is added as tracked with zero untracked", async () => {
	const files = await readFiles({
		status: { stdout: " M code.ts" },
		numstat: { stdout: "1\t1\tcode.ts\n2\t0\tonly-in-diff.ts" },
	});

	assert.deepEqual(files.find((file) => file.path === "only-in-diff.ts"), {
		path: "only-in-diff.ts",
		added: 2,
		removed: 0,
		untracked: false,
	});
});

test("an errored numstat keeps the status entries with zero line stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts\n M code.ts" },
		numstat: { code: 1, stdout: "fatal: bad revision 'HEAD'" },
	});

	assert.deepEqual(files, [
		{ path: "scratch.ts", added: 0, removed: 0, untracked: true },
		{ path: "code.ts", added: 0, removed: 0, untracked: false },
	]);
});

test("an empty numstat keeps the status entries with zero line stats", async () => {
	const files = await readFiles({
		status: { stdout: "?? scratch.ts" },
		numstat: { code: 0, stdout: "" },
	});

	assert.deepEqual(files, [{ path: "scratch.ts", added: 0, removed: 0, untracked: true }]);
});

// --- workspace branch --------------------------------------------------------

test("a changed workspace cwd clears the old branch name", async () => {
	const { pi, piHandlers } = makeCapturingPi({ branch: "main" });
	const data = createSidebarData(pi);
	try {
		data.subscribe(makeFakeCtx([], "/repo"));
		await flush();
		assert.equal(data.snapshot().workspace.branch, "main", "the first read kept no branch");
		piHandlers.get("session_start")?.({}, makeFakeCtx([], "/repo"));
		assert.equal(
			data.snapshot().workspace.branch,
			"main",
			"a session start in the unchanged cwd dropped the branch name",
		);
		piHandlers.get("session_start")?.({}, makeFakeCtx([], "/elsewhere"));
		assert.equal(
			data.snapshot().workspace.branch,
			null,
			"the old branch name outlived its repository",
		);
	} finally {
		data.dispose();
	}
});
