/**
 * Tests for the startup report script.
 *
 * Every case spawns bash with the real script and a throw-away home under
 * os.tmpdir(), so no case reads or writes the real home folder.
 *
 * Run: npm test
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportScript = path.join(
	repoRoot,
	"content",
	"skills",
	"orchestrator",
	"journal-management",
	"scripts",
	"startup-report.sh",
);

/** Trees made by the running case; each case must leave no tree behind. */
let caseTrees: string[] = [];

/** Remove every tree the case made, so a failure leaves no litter. */
function dropCaseTrees(): void {
	for (const tree of caseTrees) fs.rmSync(tree, { recursive: true, force: true });
	caseTrees = [];
}

afterEach(dropCaseTrees);

/** A fresh tree under the system temp folder, resolved to a real path. */
function makeTree(): string {
	const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "startup-report-")));
	caseTrees.push(tree);
	return tree;
}

/** A home with agent-notes for the default agent, and nothing else. */
function goodHome(): string {
	const home = makeTree();
	fs.mkdirSync(path.join(home, "agent-notes", "orchestrator"), { recursive: true });
	return home;
}

/** A project folder under the home, with a summary file and a rules folder. */
function projectTree(home: string, project: string): { projectDir: string; rulesDir: string } {
	const projectDir = path.join(home, "agent-notes", "project-notes", project);
	const rulesDir = path.join(projectDir, "rules");
	fs.mkdirSync(rulesDir, { recursive: true });
	return { projectDir, rulesDir };
}

/** Write `count` rule files; file `index` holds the text from `body`. */
function writeRules(rulesDir: string, count: number, body: (index: number) => string): void {
	for (let index = 1; index <= count; index += 1) {
		fs.writeFileSync(path.join(rulesDir, `rule-${index}.md`), body(index));
	}
}

/** Write a summary file with exactly `count` lines. */
function writeSummary(projectDir: string, count: number): void {
	const rows = Array.from({ length: count }, (_unused, index) => `summary line ${index + 1}`);
	fs.writeFileSync(path.join(projectDir, "summary.md"), `${rows.join("\n")}\n`);
}

interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** The one spawn call: bash, an argv array, an absolute path, a temp HOME. */
function runReport(home: string, args: string[]): RunResult {
	const result = spawnSync("bash", [reportScript, ...args], {
		env: { ...process.env, HOME: home },
		encoding: "utf8",
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/** stdout as lines, so a case can assert one whole printed line. */
function outLines(stdout: string): string[] {
	return stdout.split("\n");
}

/** Assert stdout holds this line exactly once. */
function assertWholeLine(result: RunResult, expected: string): void {
	const found = outLines(result.stdout).filter((line) => line === expected);
	assert.equal(found.length, 1, `stdout must hold this line once: ${expected}`);
}

describe("startup-report.sh input guards", () => {
	test("--help prints usage and exits 0", () => {
		const home = makeTree();
		const result = runReport(home, ["--help"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(
			result,
			`Usage: bash ${reportScript} [--home PATH] [--agent TYPE] [--project NAME] [--no-dump] [--help]`,
		);
	});

	test("an unknown flag exits 1", () => {
		const home = makeTree();
		const result = runReport(home, ["--bogus"]);
		assert.equal(result.status, 1, "an unknown flag is a user error");
		assert.equal(result.stdout, "", "an unknown flag prints nothing on stdout");
	});

	test("--home without agent-notes exits 1", () => {
		const home = makeTree();
		const result = runReport(home, ["--home", home]);
		assert.equal(result.status, 1, "a wrong --home path must stop the run");
		assert.ok(result.stderr.includes("no agent-notes folder"), "stderr must name the cause");
	});
});

describe("startup-report.sh report keys", () => {
	test("a good home reports the flag home rule", () => {
		const home = goodHome();
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(result, `home ${home}`);
		assertWholeLine(result, "home_rule flag");
	});
});

describe("startup-report.sh breach lines", () => {
	test("a 31 line summary reports a summary breach", () => {
		const home = goodHome();
		const { projectDir } = projectTree(home, "demo");
		writeSummary(projectDir, 31);
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, "a breach is a report, not a failure");
		assertWholeLine(result, "breach summary-lines 31 limit 30");
	});

	test("nine rule files report a rules file breach", () => {
		const home = goodHome();
		const { rulesDir } = projectTree(home, "demo");
		writeRules(rulesDir, 9, (index) => `rule ${index} body\n`);
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, "a breach is a report, not a failure");
		assertWholeLine(result, "breach rules-files 9 limit 8");
	});

	test("a 30 line summary sits at the limit and reports no breach", () => {
		const home = goodHome();
		const { projectDir } = projectTree(home, "demo");
		writeSummary(projectDir, 30);
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(result, "breach none");
	});

	test("eight rule files sit at the limit and report no breach", () => {
		const home = goodHome();
		const { rulesDir } = projectTree(home, "demo");
		writeRules(rulesDir, 8, (index) => `rule ${index} body\n`);
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(result, "breach none");
	});
});

describe("startup-report.sh content dump", () => {
	test("the dump frames the rules block and copies a rule body", () => {
		const home = goodHome();
		const { rulesDir } = projectTree(home, "demo");
		writeRules(rulesDir, 1, () => "keep the journal short\n");
		const result = runReport(home, ["--home", home, "--project", "demo"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(result, `--- rules ${rulesDir} ---`);
		assertWholeLine(result, "--- end rules ---");
		assert.ok(result.stdout.includes("keep the journal short"), "the dump must copy the rule body");
	});

	test("--no-dump prints no rules block", () => {
		const home = goodHome();
		const { rulesDir } = projectTree(home, "demo");
		writeRules(rulesDir, 1, () => "keep the journal short\n");
		const result = runReport(home, ["--home", home, "--project", "demo", "--no-dump"]);
		assert.equal(result.status, 0, result.stderr);
		assertWholeLine(result, `home ${home}`);
		const opens = outLines(result.stdout).filter((line) => line.startsWith("--- rules "));
		assert.deepEqual(opens, [], "the report alone must print no rules block");
		assert.ok(!result.stdout.includes("keep the journal short"), "the rule body stays out of the report");
	});
});
