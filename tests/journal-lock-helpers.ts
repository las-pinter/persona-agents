/**
 * Shared scaffolding for the journal write lock script cases.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 *
 * Run: npm test
 */

import { afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped script path, so a rename breaks the suite loudly. */
export const writeScript = path.join(
	repoRoot,
	"content",
	"skills",
	"common",
	"journal-management-generic",
	"scripts",
	"journal-write.sh",
);

export const AGENT = "orchestrator";
export const SESSION = "20261108T201812123456789";

/** Trees made by the running case; each case must leave no tree behind. */
let trees: string[] = [];

afterEach(() => {
	for (const tree of trees) fs.rmSync(tree, { recursive: true, force: true });
	trees = [];
});

/** A fresh home folder under the system temp folder, resolved to a real path. */
export function makeHome(): string {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "journal-lock-")));
	trees.push(home);
	return home;
}

export function journalsDir(home: string, agent: string = AGENT): string {
	return path.join(home, "agent-notes", agent, "journals");
}

/** The lock path the script documents, one lock per agent folder. */
export function lockPath(home: string, agent: string = AGENT): string {
	return path.join(journalsDir(home, agent), ".journal-write.lock");
}

export function prevPath(home: string, agent: string = AGENT): string {
	return path.join(journalsDir(home, agent), ".journal-write.prev");
}

/** The claim temp files left in the journals folder, so a case reads what stayed. */
export function claimNames(home: string): string[] {
	return fs.readdirSync(journalsDir(home)).filter((name) => name.startsWith(".journal-write.claim."));
}

export interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** Extra environment for one case, on top of HOME. */
export type RunEnv = Record<string, string>;

/** The longest one script call may run before the case fails, not hangs. */
export const RUN_TIMEOUT_MS = 30000;

/** The one spawn call, with the environment the case chooses. */
export function runRaw(args: string[], home: string, env: RunEnv = {}, timeoutMs?: number): RunResult {
	const result = spawnSync("bash", [writeScript, ...args], {
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		timeout: timeoutMs ?? RUN_TIMEOUT_MS,
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

export function run(home: string, args: string[], env: RunEnv = {}, timeoutMs?: number): RunResult {
	return runRaw([...args, "--home", home], home, env, timeoutMs);
}

/** One spawned run with a signal handle, so a case can end the run it started. */
export interface SpawnedRun {
	kill: (signal: NodeJS.Signals) => boolean;
	done: Promise<RunResult>;
}

export function spawnRun(home: string, args: string[], env: RunEnv = {}): SpawnedRun {
	const child = spawn("bash", [writeScript, ...args, "--home", home], {
		env: { ...process.env, HOME: home, ...env },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const done = new Promise<RunResult>((resolve) => {
		child.on("close", (status) => resolve({ stdout, stderr, status: status ?? -1 }));
	});
	return { kill: (signal: NodeJS.Signals) => child.kill(signal), done };
}

export function startAsync(home: string, args: string[], env: RunEnv = {}): Promise<RunResult> {
	return spawnRun(home, args, env).done;
}

export function runAsync(home: string, args: string[]): Promise<RunResult> {
	return startAsync(home, args);
}

export function rows(text: string): string[] {
	const all = text.split("\n");
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	return all;
}

/** The value of one `name value` row, so a case reads the output it asserts. */
export function rowOf(text: string, name: string): string {
	const row = rows(text).find((line) => line.startsWith(`${name} `));
	assert.ok(row, `the output must hold a ${name} row: ${text}`);
	return row.slice(name.length + 1);
}

/** The lock keys each on its own line, so a case reads the record it asserts. */
export function recordOf(home: string): Record<string, string> {
	const record: Record<string, string> = {};
	for (const row of rows(fs.readFileSync(lockPath(home), "utf8"))) {
		const at = row.indexOf(" ");
		if (at > 0) record[row.slice(0, at)] = row.slice(at + 1);
	}
	return record;
}

export function recordText(session: string, token: string, at: number, agent: string = AGENT): string {
	return `agent ${agent}\nsession ${session}\ntoken ${token}\nat ${at}\nhost test-host\n`;
}

/** A lock record planted before a case runs, with the journals folder made. */
export function plantLock(home: string, text: string): string {
	fs.mkdirSync(journalsDir(home), { recursive: true });
	fs.writeFileSync(lockPath(home), text);
	return lockPath(home);
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export async function settle(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `date` shim folder that goes first on PATH. The epoch-second read touches
 * the mark, then waits for a release file the case touches after the other
 * process returns. A race window never depends on a sleep width. The wait is
 * bounded, so a case that never releases fails instead of hanging. An unset
 * release variable means no wait at all.
 */
export function makeDateShim(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-date-"));
	trees.push(dir);
	const realDate = (spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout ?? "").trim();
	assert.ok(realDate.startsWith("/"), `the real date path resolves to a file: ${realDate}`);
	const body = [
		"#!/usr/bin/env bash",
		'for arg in "$@"; do',
		'  if [ "$arg" = "+%s" ]; then',
		'    if [ -n "${JOURNAL_GATE_MARK:-}" ]; then : >"$JOURNAL_GATE_MARK"; fi',
		'    if [ -n "${JOURNAL_GATE_RELEASE:-}" ]; then',
		"      waited=0",
		'      while [ ! -e "$JOURNAL_GATE_RELEASE" ]; do',
		"        sleep 0.01",
		"        waited=$((waited + 1))",
		'        if [ "$waited" -ge 2000 ]; then break; fi',
		"      done",
		"    fi",
		"    break",
		"  fi",
		"done",
		`exec ${realDate} "$@"`,
		"",
	].join("\n");
	fs.writeFileSync(path.join(dir, "date"), body, { mode: 0o755 });
	fs.chmodSync(path.join(dir, "date"), 0o755);
	return dir;
}

/** The gate environment: the shim first on PATH, its mark, and its release file. */
export function gateEnv(shim: string, mark: string, release: string): RunEnv {
	return {
		PATH: `${shim}:${process.env.PATH ?? ""}`,
		JOURNAL_GATE_MARK: mark,
		JOURNAL_GATE_RELEASE: release,
	};
}

/** Wait for the shim mark, so the second process starts inside the window. */
export async function waitForMark(mark: string): Promise<void> {
	const deadline = Date.now() + 10000;
	while (!fs.existsSync(mark)) {
		if (Date.now() > deadline) assert.fail(`the shim never marked the window: ${mark}`);
		await settle(10);
	}
}

/** The absolute path of one real tool, so a shim can forward to it. */
export function realToolPath(name: string): string {
	const found = (spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout ?? "").trim();
	assert.ok(found.startsWith("/"), `the real ${name} path resolves to a file: ${found}`);
	return found;
}

/** A shim folder in front of PATH, holding one tool body per name. */
export function makeShimDir(bodies: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-shim-"));
	trees.push(dir);
	for (const [name, body] of Object.entries(bodies)) {
		fs.writeFileSync(path.join(dir, name), `${body}\n`, { mode: 0o755 });
		fs.chmodSync(path.join(dir, name), 0o755);
	}
	return dir;
}

/** The PATH environment for one shim folder. */
export function shimPath(dir: string): RunEnv {
	return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

/** A `cksum` body that answers a counted value, so two reads never agree. */
export function countingCksum(realCksum: string, firstIsReal: boolean): string {
	return [
		"#!/usr/bin/env bash",
		'count="$(dirname "$0")/cksum-count"',
		"now=0",
		'if [ -f "$count" ]; then now=$(cat "$count"); fi',
		"now=$((now + 1))",
		'printf "%s\\n" "$now" >"$count"',
		...(firstIsReal ? [`if [ "$now" -lt 2 ]; then exec ${realCksum} "$@"; fi`] : []),
		'printf "%s %s\\n" "$now" "$now"',
	].join("\n");
}

/** The age a `stale` row reports, so a case asserts a floor and not one value. */
export function staleAgeOf(text: string): number {
	const match = / age (\d+)s$/.exec(rowOf(text, "stale"));
	assert.ok(match, `the stale row names an age: ${text}`);
	return Number(match[1]);
}
