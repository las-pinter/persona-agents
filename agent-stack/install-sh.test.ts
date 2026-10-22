/**
 * Regression tests for install.sh.
 *
 * The installer writes into $HOME, so every test runs against a throw-away
 * HOME under os.tmpdir(). install.sh also probes PATH for kiro-cli, opencode,
 * and herdr, so the tests prepend a stub bin dir: the stubs satisfy the
 * probes, and the herdr stub replaces `herdr plugin link`, so the real herdr
 * plugin registry is never touched.
 *
 * The covered defects:
 *   1. a dry run must not create a file or a directory;
 *   2. a dry run must report the outcome the next real run produces;
 *   3. an option without a value must print a friendly error, not a raw
 *      shell "unbound variable" failure;
 *   4. the trailing-comma repair must not touch a comma inside a string;
 *   5. the MCP merge must never overwrite an entry the user already has;
 *   6. a config jq cannot read must not stop the install halfway;
 *   7. the installer must not touch the shell rc files;
 *   8. a run narrowed by --target or --profession must skip the herdr plugin.
 *
 * Run: npm test
 */

import { after, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(repoRoot, "install.sh");
const mcpExampleFile = path.join(repoRoot, "settings", "mcp.json.example");

/** The tools install.sh probes on PATH. The herdr stub replaces `herdr plugin link`. */
const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-stub-"));
for (const tool of ["kiro-cli", "opencode", "herdr"]) {
	const stub = path.join(stubBin, tool);
	fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(stub, 0o755);
}

/** The throw-away HOMEs to remove when the file is done. */
const tempHomes: string[] = [];

after(() => {
	for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(stubBin, { recursive: true, force: true });
});

/** A fresh empty HOME under the system temp dir. */
function makeHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-home-"));
	tempHomes.push(home);
	return home;
}

/**
 * A HOME that already holds an OpenCode config and both shell rc files.
 * The config makes the installer take the merge path. The rc files must stay
 * untouched: the installer adds no shell aliases.
 */
function populatedHome(): string {
	const home = makeHome();
	fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
	fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), '{ "mcp": {} }\n');
	fs.writeFileSync(path.join(home, ".bashrc"), "# test rc\n");
	fs.writeFileSync(path.join(home, ".zshrc"), "# test zshrc\n");
	return home;
}

/**
 * Every file and directory under `root`, as sorted relative paths.
 * A file entry also carries its content, so an append to an existing file
 * is visible: a path list alone would miss it.
 */
function listTree(root: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(root, full);
			if (entry.isDirectory()) {
				found.push(`${rel}/`);
				walk(full);
			} else {
				found.push(`${rel}\n${fs.readFileSync(full, "utf8")}`);
			}
		}
	};
	walk(root);
	return found.sort();
}

interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** Run install.sh against a throw-away HOME and a stubbed PATH. */
function runInstaller(home: string, args: string[]): RunResult {
	const result = spawnSync("bash", [installScript, ...args], {
		env: {
			...process.env,
			HOME: home,
			PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`,
		},
		encoding: "utf8",
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/** The installer options that keep a run short: one target, one theme, one profession. */
const FOCUSED = ["--target", "opencode", "--theme", "goblin", "--profession", "orchestrator"];

interface Outcome {
	/** What happens to the subject: it is written, left alone, or merged. */
	kind: "write" | "skip" | "merge";
	/** The file or merge target the outcome applies to. */
	subject: string;
}

/**
 * Map one output line to a canonical outcome.
 *
 * A real run and a dry run use different words for the same result
 * ("installed" and "would install"), so both map to one kind. The subject
 * names what the outcome applies to, so the two runs can be compared.
 */
function parseOutcome(line: string): Outcome | null {
	const text = line.trim().replace(/^\(dry-run\)\s+/, "");
	let match: RegExpExecArray | null;

	if ((match = /^installed: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^would install: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^created: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^would create if missing: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^skipped \(exists\): (.+)$/.exec(text))) return { kind: "skip", subject: match[1] };
	if ((match = /^skipped \(customize locally\): (.+)$/.exec(text))) return { kind: "skip", subject: match[1] };
	if ((match = /^generated: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^would generate: (.+)$/.exec(text))) return { kind: "write", subject: match[1] };
	if ((match = /^merged into (.+) \(\.(.+)\)$/.exec(text))) {
		return { kind: "merge", subject: `${match[1]}.${match[2]}` };
	}
	if ((match = /^would merge MCP settings from (.+) into (.+) at key '\.(.+)'$/.exec(text))) {
		return { kind: "merge", subject: `${match[2]}.${match[3]}` };
	}
	if ((match = /^would merge (.+) into (.+) at key '\.(.+)'$/.exec(text))) {
		return { kind: "merge", subject: `${match[2]}.${match[3]}` };
	}
	return null;
}

/** Every outcome line of an installer run, in output order. */
function outcomes(stdout: string): Outcome[] {
	const found: Outcome[] = [];
	for (const line of stdout.split("\n")) {
		const outcome = parseOutcome(line);
		if (outcome) found.push(outcome);
	}
	return found;
}

describe("install.sh dry run", () => {
	test("a dry run creates no file and no directory", () => {
		const home = makeHome();
		const result = runInstaller(home, ["--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(listTree(home), [], "a dry run must not create anything under HOME");
		// Both targets must be exercised: a stub target that never runs would
		// leave the tree empty for the wrong reason.
		assert.match(result.stdout, /would generate: \S+\.json/, "the kiro target must generate an agent");
		assert.match(result.stdout, /would generate: \S+\.md/, "the opencode target must generate an agent");
	});

	test("a dry run reports the outcome the next real run produces", () => {
		const home = populatedHome();

		// The dry run comes first, while every write path is still unexercised:
		// a created file or a rewritten config would each change this snapshot.
		const before = listTree(home);
		const dry = runInstaller(home, [...FOCUSED, "--dry-run"]);
		assert.equal(dry.status, 0, dry.stderr);
		assert.deepEqual(listTree(home), before, "a dry run must not create or change anything under HOME");

		const real = runInstaller(home, FOCUSED);
		assert.equal(real.status, 0, real.stderr);

		const dryOutcomes = outcomes(dry.stdout);
		assert.deepEqual(dryOutcomes, outcomes(real.stdout), "the dry run must report the outcome of the next real run");

		// A second dry run sees the files the real run wrote. It must report them
		// as skips, never as installs.
		const again = runInstaller(home, [...FOCUSED, "--dry-run"]);
		assert.equal(again.status, 0, again.stderr);
		const skipOutcomes = outcomes(again.stdout);
		assert.ok(
			skipOutcomes.some((outcome) => outcome.kind === "skip"),
			"the dry run must report the files it would skip",
		);
		assert.equal(
			skipOutcomes.filter((outcome) => outcome.kind === "write").length,
			0,
			"a file that already exists must not be reported as an install",
		);
		assert.doesNotMatch(again.stdout, /would install/, "an existing file must not be reported as an install");
	});

	test("a dry run marks every outcome line", () => {
		const home = populatedHome();
		runInstaller(home, FOCUSED);
		const dry = runInstaller(home, [...FOCUSED, "--dry-run"]);
		const outcomeLines = dry.stdout
			.split("\n")
			.filter((line) => parseOutcome(line) !== null)
			.map((line) => line.trim());
		assert.ok(outcomeLines.length > 0, "the dry run must report outcomes");
		for (const line of outcomeLines) {
			assert.match(line, /^\(dry-run\)/, `dry-run outcome line lacks the marker: ${line}`);
		}
	});
});

describe("install.sh option values", () => {
	for (const option of ["--target", "--theme", "--profession"]) {
		test(`${option} without a value prints a friendly error`, () => {
			const home = makeHome();
			const result = runInstaller(home, [option]);
			const output = `${result.stdout}${result.stderr}`;
			assert.notEqual(result.status, 0, "the run must fail");
			assert.match(output, new RegExp(`Error: ${option} requires a value`));
			assert.doesNotMatch(output, /unbound variable/, "the raw shell error must not appear");
			assert.deepEqual(listTree(home), [], "the failed run must not touch HOME");
		});
	}

	// A following option must not be taken as the value of the previous one.
	test("an option followed by another option prints a friendly error", () => {
		const home = makeHome();
		const result = runInstaller(home, ["--theme", "--force"]);
		const output = `${result.stdout}${result.stderr}`;
		assert.notEqual(result.status, 0, "the run must fail");
		assert.match(output, /Error: --theme requires a value/);
		assert.doesNotMatch(output, /unbound variable/, "the raw shell error must not appear");
		assert.deepEqual(listTree(home), [], "the failed run must not touch HOME");
	});
});

describe("install.sh config merge", () => {
	test("a comma inside a string value survives the merge", () => {
		const home = makeHome();
		const configDir = path.join(home, ".config", "opencode");
		fs.mkdirSync(configDir, { recursive: true });
		const config = path.join(configDir, "opencode.json");
		fs.writeFileSync(
			config,
			[
				"{",
				'  "note": "value, } here",',
				'  "note2": "value, ] here",',
				'  "model": "x",',
				'  "mcp": { "mine": { "type": "local", "command": "mycmd", "enabled": true } },',
				'  "list": [1, 2, ],',
				"}",
				"",
			].join("\n"),
		);

		const result = runInstaller(home, FOCUSED);
		assert.equal(result.status, 0, result.stderr);

		// A valid JSON result proves the trailing commas were repaired.
		const merged = JSON.parse(fs.readFileSync(config, "utf8")) as Record<string, unknown>;
		assert.equal(merged.note, "value, } here", "a comma inside a string must not be stripped");
		assert.equal(merged.note2, "value, ] here", "a comma inside a string must not be stripped");
		assert.equal(merged.model, "x", "an existing key must survive the merge");
		assert.deepEqual(merged.list, [1, 2], "a trailing comma must be stripped");

		const mcp = merged.mcp as Record<string, unknown>;
		assert.ok(mcp.mine, "the existing mcp entry must survive the merge");
		const example = JSON.parse(fs.readFileSync(mcpExampleFile, "utf8")) as {
			mcpServers?: Record<string, unknown>;
		};
		for (const key of Object.keys(example.mcpServers ?? {})) {
			assert.ok(mcp[key], `the merged mcp entry ${key} must be present`);
		}
	});
});

describe("install.sh MCP merge keeps user entries", () => {
	test("an MCP entry the user already has wins over the example", () => {
		const home = makeHome();
		const configDir = path.join(home, ".config", "opencode");
		fs.mkdirSync(configDir, { recursive: true });
		const config = path.join(configDir, "opencode.json");
		const mine = {
			type: "remote",
			url: "https://mcp.exa.ai/mcp",
			headers: { "x-api-key": "SECRET" },
			enabled: false,
		};
		fs.writeFileSync(config, JSON.stringify({ mcp: { exa: mine } }));

		const result = runInstaller(home, FOCUSED);
		assert.equal(result.status, 0, result.stderr);

		const mcp = (JSON.parse(fs.readFileSync(config, "utf8")) as { mcp: Record<string, unknown> }).mcp;
		assert.deepEqual(mcp.exa, mine, "the user's exa entry must survive unchanged");
		assert.ok(mcp.context7, "a missing example entry must still be added");
	});

	test("a config with comments is left unchanged and the install completes", () => {
		const home = makeHome();
		const configDir = path.join(home, ".config", "opencode");
		fs.mkdirSync(configDir, { recursive: true });
		const config = path.join(configDir, "opencode.json");
		const original = '{\n  // my model\n  "model": "x",\n  "mcp": {}\n}\n';
		fs.writeFileSync(config, original);

		const result = runInstaller(home, FOCUSED);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /cannot parse .*opencode\.json/, "the user must be told the merge was skipped");
		assert.equal(fs.readFileSync(config, "utf8"), original, "an unreadable config must not be rewritten");
		assert.ok(
			fs.existsSync(path.join(configDir, "plugins", "persona-agents.js")),
			"the plugins after the merge must still install",
		);
		assert.match(result.stdout, /Done!/);
	});
});

describe("install.sh leaves the shell alone", () => {
	test("a real run does not touch the shell rc files", () => {
		const home = populatedHome();
		const result = runInstaller(home, ["--theme", "goblin", "--profession", "orchestrator"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), "# test rc\n");
		assert.equal(fs.readFileSync(path.join(home, ".zshrc"), "utf8"), "# test zshrc\n");
		assert.ok(!fs.existsSync(path.join(home, ".bash_aliases")), "no ~/.bash_aliases may be created");
	});
});

describe("install.sh herdr plugin scope", () => {
	const herdrLink = /herdr plugin link/;

	test("a full install links the herdr plugin", () => {
		const result = runInstaller(makeHome(), ["--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, herdrLink);
	});

	test("an overseer-only install links the herdr plugin", () => {
		const result = runInstaller(makeHome(), ["--dry-run", "--profession", "overseer"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, herdrLink);
	});

	for (const args of [
		["--target", "opencode"],
		["--target", "kiro"],
		["--profession", "reviewer"],
	]) {
		test(`${args.join(" ")} skips the herdr plugin`, () => {
			const result = runInstaller(makeHome(), ["--dry-run", ...args]);
			assert.equal(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stdout, herdrLink);
			assert.doesNotMatch(result.stderr, /herdr not found/, "a skipped plugin must not warn about herdr");
		});
	}
});
