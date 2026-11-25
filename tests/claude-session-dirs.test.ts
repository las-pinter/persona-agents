/**
 * The session additional-directory reader
 * (platforms/claude/scripts/session-dirs.ts): the managed, user, and project
 * settings files, with `~` and relative entries resolved.
 *
 * Run: node --experimental-strip-types --test tests/claude-session-dirs.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionDirs } from "../platforms/claude/scripts/session-dirs.ts";

/** Write one settings file that lists additional directories. */
function settings(file: string, dirs: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ permissions: { additionalDirectories: dirs } }));
}

function withTemp(fn: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-agents-dirs-"));
	try {
		fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("session-dirs: every settings source", () => {
	test("managed base and drop-ins, user, project, and local", () => {
		withTemp((root) => {
			const home = path.join(root, "home");
			const project = path.join(root, "project");
			const config = path.join(root, "config");
			const managed = path.join(root, "managed", "managed-settings.json");
			settings(managed, ["/managed"]);
			settings(path.join(root, "managed", "managed-settings.d", "10-a.json"), ["/drop-a"]);
			settings(path.join(root, "managed", "managed-settings.d", "20-b.json"), ["/drop-b", "/drop-a"]);
			// A hidden file and a non-json file are not drop-ins.
			settings(path.join(root, "managed", "managed-settings.d", ".hidden.json"), ["/hidden"]);
			fs.writeFileSync(path.join(root, "managed", "managed-settings.d", "notes.txt"), "{}");
			settings(path.join(config, "settings.json"), ["/user", "/user"]);
			settings(path.join(project, ".claude", "settings.json"), ["/proj-abs", "~/notes", "rel"]);
			settings(path.join(project, ".claude", "settings.local.json"), ["/proj-local"]);

			const found = sessionDirs(project, { home, configDir: config, managedFile: managed, projectDir: project }).sort();
			const expected = [
				"/managed",
				"/drop-a",
				"/drop-b",
				"/user",
				"/proj-abs",
				path.join(home, "notes"),
				path.join(project, "rel"),
				"/proj-local",
			].sort();
			assert.deepEqual(found, expected);
		});
	});

	test("a malformed or missing file grants nothing", () => {
		withTemp((root) => {
			const project = path.join(root, "project");
			fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
			fs.writeFileSync(path.join(project, ".claude", "settings.json"), "{ not json");
			fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: {} }));
			assert.deepEqual(sessionDirs(project, { home: root, configDir: "", managedFile: "", projectDir: project }), []);
		});
	});

	test("a non-array value grants nothing", () => {
		withTemp((root) => {
			const project = path.join(root, "project");
			settings(path.join(project, ".claude", "settings.json"), "/not-an-array");
			assert.deepEqual(sessionDirs(project, { home: root, configDir: "", managedFile: "", projectDir: project }), []);
		});
	});
});
