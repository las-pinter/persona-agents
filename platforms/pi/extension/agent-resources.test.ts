/**
 * Cases for frontmatter resource expansion on the pi prompt.
 *
 * A missing directory returns two empty arrays, the skip set keeps tool and
 * build directories out of the prompt, and a nested file keeps its slash path
 * and its text. A file path and a denied path also return two empty arrays; the
 * denied case skips when no mode denies the read.
 *
 * Run: npm test
 */

import { after, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveResources } from "./agent-resources.ts";

const SKIP_NAMES = [".git/", "node_modules/", "dist/"];

// One real tree: the walk reads the disk, so every entry must exist.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resources-"));
const files: [string, string][] = [
	[".git/a.md", "git\n"],
	["node_modules/b.md", "modules\n"],
	["dist/c.md", "dist\n"],
	["keep/d.md", "keep\n"],
	["a/b/c.md", "nested\n"],
];
for (const [rel, text] of files) {
	fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
	fs.writeFileSync(path.join(tmpRoot, rel), text);
}

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("agent resources: expansion cases", () => {
	test("a missing directory and an absent resources list yield two empty arrays and no throw", () => {
		const missing = path.join(tmpRoot, "absent");

		const result = resolveResources(["**/*.md"], missing);

		assert.deepEqual(result, { inlined: [], paths: [] });
		// No resources list at all must take the same early return, not a throw.
		assert.deepEqual(resolveResources(undefined, missing), { inlined: [], paths: [] });
	});

	test("a file path as the working directory yields two empty arrays and no throw", () => {
		const fileCwd = path.join(tmpRoot, "keep/d.md");

		assert.equal(fs.statSync(fileCwd).isFile(), true);
		const result = resolveResources(["**/*.md"], fileCwd);

		assert.deepEqual(result, { inlined: [], paths: [] });
	});

	test("a denied working directory yields two empty arrays, or skips when no mode denies it", (t) => {
		const denied = path.join(tmpRoot, "denied");
		fs.mkdirSync(denied, { recursive: true });
		fs.chmodSync(denied, 0o000);
		try {
			try {
				fs.readdirSync(denied);
			} catch (error) {
				assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
				const result = resolveResources(["**/*.md"], denied);

				assert.deepEqual(result, { inlined: [], paths: [] });
				return;
			}
			t.skip("a 0o000 directory stays readable here, so the walk cannot be denied");
		} finally {
			// The after hook removes the tree, so the mode must come back on a red run.
			fs.chmodSync(denied, 0o700);
		}
	});

	test("the skip set keeps tool and build directories out of the inlined text", () => {
		const result = resolveResources(["**/*.md"], tmpRoot);
		const paths = result.inlined.map((entry) => entry.path).sort();

		assert.deepEqual(paths, ["a/b/c.md", "keep/d.md"]);
		for (const entry of result.inlined) {
			for (const name of SKIP_NAMES) assert.equal(entry.path.startsWith(name), false, entry.path);
		}
	});

	test("a nested file keeps its slash path and its text", () => {
		const result = resolveResources(["**/*.md"], tmpRoot);
		const nested = result.inlined.find((entry) => entry.path === "a/b/c.md");

		assert.equal(nested?.path, "a/b/c.md");
		assert.equal(nested?.content, "nested\n");
	});
});
