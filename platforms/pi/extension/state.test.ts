/**
 * State tests: the one debug-log writer honours its flag and stamps its line.
 *
 * The writer fixes the log path at module load, so TMPDIR points at a scratch
 * folder before the module loads. The real temp log is never touched.
 *
 * Run: node --experimental-strip-types --test platforms/pi/extension/state.test.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const FLAG = "PI_AGENT_STACK_DEBUG";
/** An ISO stamp and one space: the prefix the writer puts on every line. */
const ISO_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

/** The scratch folder the writer logs into. TMPDIR must be set before the load. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "state-debug-log-"));
const savedTmpdir = process.env["TMPDIR"];
process.env["TMPDIR"] = scratch;

const state = await import("./state.ts");
const logPath: string = state.DEBUG_AGENT_STACK_PATH;
const savedFlag = process.env[FLAG];

/** Put the debug flag back to its load-time value. */
function restoreFlag(): void {
	if (savedFlag === undefined) delete process.env[FLAG];
	else process.env[FLAG] = savedFlag;
}

after(() => {
	if (savedTmpdir === undefined) delete process.env["TMPDIR"];
	else process.env["TMPDIR"] = savedTmpdir;
	fs.rmSync(scratch, { recursive: true, force: true });
});

test("the log path sits in the scratch folder", () => {
	assert.equal(path.dirname(logPath), scratch, "the writer logs into the scratch folder, not the agent folder");
});

test("the flag unset writes no log file", () => {
	delete process.env[FLAG];
	try {
		state.debugLog("case", "unset");
		assert.equal(fs.existsSync(logPath), false, "no log file exists after a call with the flag unset");
	} finally {
		restoreFlag();
	}
});

test("the flag set writes one line that starts with an ISO stamp", () => {
	process.env[FLAG] = "1";
	try {
		state.debugLog("case", "set");
		const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
		assert.equal(lines.length, 1, "one call writes one line");
		assert.match(lines[0] ?? "", ISO_STAMP, "the line starts with an ISO stamp");
	} finally {
		if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
		restoreFlag();
	}
});
