/**
 * Tests for the journal write lock script: hold, refresh, and release.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 * This file pins one script's contract, which is why it sits in the 501-1000 band.
 *
 * Run: npm test
 */

import { afterEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped script path, so a rename breaks the suite loudly. */
const writeScript = path.join(
	repoRoot,
	"content",
	"skills",
	"common",
	"journal-management-generic",
	"scripts",
	"journal-write.sh",
);

const AGENT = "orchestrator";
const SESSION = "20261108T201812123456789";
const STALE_AGE = 601;

/** Trees made by the running case; each case must leave no tree behind. */
let trees: string[] = [];

afterEach(() => {
	for (const tree of trees) fs.rmSync(tree, { recursive: true, force: true });
	trees = [];
});

/** A fresh home folder under the system temp folder, resolved to a real path. */
function makeHome(): string {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "journal-lock-")));
	trees.push(home);
	return home;
}

function journalsDir(home: string, agent: string = AGENT): string {
	return path.join(home, "agent-notes", agent, "journals");
}

/** The lock path the script documents, one lock per agent folder. */
function lockPath(home: string, agent: string = AGENT): string {
	return path.join(journalsDir(home, agent), ".journal-write.lock");
}

function prevPath(home: string, agent: string = AGENT): string {
	return path.join(journalsDir(home, agent), ".journal-write.prev");
}

/** The claim temp files left in the journals folder, so a case reads what stayed. */
function claimNames(home: string): string[] {
	return fs.readdirSync(journalsDir(home)).filter((name) => name.startsWith(".journal-write.claim."));
}

export interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** Extra environment for one case, on top of HOME. */
type RunEnv = Record<string, string>;

/** The longest one script call may run before the case fails, not hangs. */
const RUN_TIMEOUT_MS = 30000;

/** The one spawn call, with the environment the case chooses. */
function runRaw(args: string[], home: string, env: RunEnv = {}, timeoutMs?: number): RunResult {
	const result = spawnSync("bash", [writeScript, ...args], {
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		timeout: timeoutMs ?? RUN_TIMEOUT_MS,
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

function run(home: string, args: string[], env: RunEnv = {}, timeoutMs?: number): RunResult {
	return runRaw([...args, "--home", home], home, env, timeoutMs);
}

function startAsync(home: string, args: string[], env: RunEnv = {}): Promise<RunResult> {
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
	return new Promise<RunResult>((resolve) => {
		child.on("close", (status) => resolve({ stdout, stderr, status: status ?? -1 }));
	});
}

function runAsync(home: string, args: string[]): Promise<RunResult> {
	return startAsync(home, args);
}

function rows(text: string): string[] {
	const all = text.split("\n");
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	return all;
}

/** The value of one `name value` row, so a case reads the output it asserts. */
function rowOf(text: string, name: string): string {
	const row = rows(text).find((line) => line.startsWith(`${name} `));
	assert.ok(row, `the output must hold a ${name} row: ${text}`);
	return row.slice(name.length + 1);
}

/** The lock keys each on its own line, so a case reads the record it asserts. */
function recordOf(home: string): Record<string, string> {
	const record: Record<string, string> = {};
	for (const row of rows(fs.readFileSync(lockPath(home), "utf8"))) {
		const at = row.indexOf(" ");
		if (at > 0) record[row.slice(0, at)] = row.slice(at + 1);
	}
	return record;
}

function recordText(session: string, token: string, at: number, agent: string = AGENT): string {
	return `agent ${agent}\nsession ${session}\ntoken ${token}\nat ${at}\nhost test-host\n`;
}

/** A lock record planted before a case runs, with the journals folder made. */
function plantLock(home: string, text: string): string {
	fs.mkdirSync(journalsDir(home), { recursive: true });
	fs.writeFileSync(lockPath(home), text);
	return lockPath(home);
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

async function settle(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `date` shim folder that goes first on PATH. It sleeps on the epoch-second
 * read only, so a race window is wide and real, and it marks the sleep so a
 * case can start the second process inside that window.
 */
function makeDateShim(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-date-"));
	trees.push(dir);
	const realDate = (spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout ?? "").trim();
	assert.ok(realDate.startsWith("/"), `the real date path resolves to a file: ${realDate}`);
	const body = [
		"#!/usr/bin/env bash",
		'for arg in "$@"; do',
		'  if [ "$arg" = "+%s" ]; then',
		'    if [ -n "${JOURNAL_DATE_MARK:-}" ]; then : >"$JOURNAL_DATE_MARK"; fi',
		'    sleep "${JOURNAL_DATE_SLEEP:-0}"',
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

/** The shim environment: its folder first on PATH, a sleep width, and a mark. */
function shimEnv(shim: string, sleep: string, mark: string): RunEnv {
	return { PATH: `${shim}:${process.env.PATH ?? ""}`, JOURNAL_DATE_SLEEP: sleep, JOURNAL_DATE_MARK: mark };
}

/** Wait for the shim mark, so the second process starts inside the window. */
async function waitForMark(mark: string): Promise<void> {
	const deadline = Date.now() + 10000;
	while (!fs.existsSync(mark)) {
		if (Date.now() > deadline) assert.fail(`the date shim never marked the sleep: ${mark}`);
		await settle(10);
	}
}

/** The absolute path of one real tool, so a shim can forward to it. */
function realToolPath(name: string): string {
	const found = (spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout ?? "").trim();
	assert.ok(found.startsWith("/"), `the real ${name} path resolves to a file: ${found}`);
	return found;
}

/** A shim folder in front of PATH, holding one tool body per name. */
function makeShimDir(bodies: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-shim-"));
	trees.push(dir);
	for (const [name, body] of Object.entries(bodies)) {
		fs.writeFileSync(path.join(dir, name), `${body}\n`, { mode: 0o755 });
		fs.chmodSync(path.join(dir, name), 0o755);
	}
	return dir;
}

/** The PATH environment for one shim folder. */
function shimPath(dir: string): RunEnv {
	return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

/** A `cksum` body that answers a counted value, so two reads never agree. */
function countingCksum(realCksum: string, firstIsReal: boolean): string {
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
function staleAgeOf(text: string): number {
	const match = / age (\d+)s$/.exec(rowOf(text, "stale"));
	assert.ok(match, `the stale row names an age: ${text}`);
	return Number(match[1]);
}

describe("A — a held lock blocks", () => {
	test("a second hold with a short timeout reports the holder", () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", "first"]);
		assert.equal(first.status, 0, first.stderr);
		assert.equal(rowOf(first.stdout, "lock"), lockPath(home));
		assert.ok(rowOf(first.stdout, "token").startsWith("first-"), first.stdout);
		assert.match(rowOf(first.stdout, "at"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		assert.match(rowOf(first.stdout, "deadline"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

		const second = run(home, ["hold", "--agent", AGENT, "--session", "second", "--timeout", "1"]);
		assert.equal(second.status, 4, second.stderr);
		assert.match(second.stderr, /^held .* by first since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
		assert.equal(recordOf(home).session, "first");
	});

	test("the documented lock path comes from the default home", () => {
		const home = makeHome();
		const result = runRaw(["hold", "--agent", AGENT, "--session", SESSION], home);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);
	});
});

describe("B — two holders never both proceed", () => {
	test("one of eight holds wins, and a release frees the lock", async () => {
		for (let round = 1; round <= 20; round += 1) {
			const home = makeHome();
			const results = await Promise.all(
				Array.from({ length: 8 }, (_unused, index) =>
					runAsync(home, ["hold", "--agent", AGENT, "--session", `r${round}s${index}`, "--timeout", "1"]),
				),
			);
			const winners = results.filter((result) => result.status === 0);
			const waiters = results.filter((result) => result.status === 4);
			assert.equal(winners.length, 1, `round ${round} has one holder`);
			assert.equal(waiters.length, 7, `round ${round} has seven waiters`);

			const token = rowOf(winners[0]?.stdout ?? "", "token");
			const record = recordOf(home);
			assert.equal(token, record.token, `round ${round} names the winner token`);
			const released = run(home, [
				"release",
				"--agent",
				AGENT,
				"--session",
				record.session ?? "",
				"--token",
				token,
			]);
			assert.equal(released.status, 0, released.stderr);
			assert.equal(fs.existsSync(lockPath(home)), false, `round ${round} removes the lock`);

			const next = run(home, ["hold", "--agent", AGENT, "--session", `next${round}`]);
			assert.equal(next.status, 0, next.stderr);
		}
	});
});

describe("C — a dead holder is broken", () => {
	test("a record past the TTL is broken and kept in the prev file", () => {
		const home = makeHome();
		const lock = plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);

		const match = /^(.*) age (\d+)s$/.exec(rowOf(result.stdout, "stale"));
		assert.ok(match, `the stale row names the lock and the age: ${result.stdout}`);
		assert.equal(match[1], lock);
		const age = Number(match[2]);
		assert.ok(
			age >= STALE_AGE && age <= STALE_AGE + 30,
			`the age meets the floor and stays under the widened ceiling, got ${age}`,
		);

		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("an empty lock file is stale at age 0", () => {
		const home = makeHome();
		plantLock(home, "");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(rowOf(result.stdout, "stale"), / age 0s$/);
		assert.equal(fs.existsSync(prevPath(home)), true);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("an incomplete record is stale at age 0", () => {
		const home = makeHome();
		plantLock(home, "agent orchestrator\nsession dead\n");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(rowOf(result.stdout, "stale"), / age 0s$/);
		assert.equal(recordOf(home).token.startsWith(`${SESSION}-`), true);
	});

	test("a break that never wins ends at the timeout", () => {
		const home = makeHome();
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// Every digest read differs from the last, so the claim never equals the
		// probe and the break never wins.
		const shim = makeShimDir({ cksum: countingCksum(realToolPath("cksum"), false) });

		const started = Date.now();
		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			shimPath(shim),
			20000,
		);
		const elapsed = Date.now() - started;
		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.ok(elapsed < 10000, `the wait is bounded, took ${elapsed} ms`);
		assert.match(result.stderr, /^held .* by dead-session since /m);
		assert.equal(recordOf(home).session, "dead-session", "the unbroken record stays");
	});

	test("a stale retry sleeps before the next poll", () => {
		const home = makeHome();
		const sleepLog = path.join(home, "sleeps");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// Every digest read differs, so the break never wins and the caller takes
		// the retry turn. The sleep body marks the turn, so a missing sleep is red.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), false),
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
		});

		const startMs = Date.now();
		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog },
			20000,
		);

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.equal(
			fs.existsSync(sleepLog),
			true,
			`the stale retry slept before the next poll; elapsed ${Date.now() - startMs} ms`,
		);
		assert.ok(rows(fs.readFileSync(sleepLog, "utf8")).length >= 1, "the stale retry made one sleep");
	});

	test("an incomplete retry sleeps before the next poll", () => {
		const home = makeHome();
		const sleepLog = path.join(home, "sleeps");
		plantLock(home, "agent orchestrator\nsession dead\n");
		// The incomplete break never wins, so the caller takes the retry turn.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), false),
			sleep: [
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >>"$SLEEP_LOG"',
				`exec ${realToolPath("sleep")} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), SLEEP_LOG: sleepLog },
			20000,
		);

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.equal(fs.existsSync(sleepLog), true, "the incomplete retry slept before the next poll");
		assert.ok(rows(fs.readFileSync(sleepLog, "utf8")).length >= 1, "the incomplete retry made one sleep");
	});

	test("a hold ends within the timeout bound plus one poll", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		plantLock(home, recordText("other-session", "other-session-1", start));
		// The date shim answers the epoch from a clock file and the sleep shim moves
		// that clock one second, so the poll count measures the wait bound.
		const shim = makeShimDir({
			date: [
				"#!/usr/bin/env bash",
				'for arg in "$@"; do',
				'  if [ "$arg" = "+%s" ]; then',
				'    cat "$CLOCK"',
				"    exit 0",
				"  fi",
				"done",
				`exec ${realToolPath("date")} "$@"`,
			].join("\n"),
			sleep: [
				"#!/usr/bin/env bash",
				'now=$(cat "$CLOCK")',
				'printf "%s\\n" "$((now + 1))" >"$CLOCK"',
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "3"],
			{ ...shimPath(shim), CLOCK: clock },
			20000,
		);
		const waited = Number(fs.readFileSync(clock, "utf8").trim()) - start;

		assert.equal(result.status, 4, `the wait ends at the timeout: ${result.stderr}`);
		assert.ok(waited >= 3, `the hold waits at least the timeout, got ${waited}`);
		assert.ok(waited <= 4, `the hold ends within the timeout plus one poll, got ${waited}`);
	});

	test("two breakers on one stale record leave exactly one holder", async () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "slow-breaker-slept");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));

		// The slow breaker probes at once, then sleeps inside its epoch read, so
		// the fast breaker breaks the record and creates in that window.
		const slow = startAsync(
			home,
			["hold", "--agent", AGENT, "--session", "slow", "--timeout", "1"],
			shimEnv(shim, "0.8", mark),
		);
		await waitForMark(mark);

		const fast = run(home, ["hold", "--agent", AGENT, "--session", "fast", "--timeout", "1"]);
		assert.equal(fast.status, 0, fast.stderr);
		assert.ok(staleAgeOf(fast.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${fast.stdout}`);
		assert.equal(recordOf(home).session, "fast");

		const slowResult = await slow;
		assert.equal(slowResult.status, 4, slowResult.stderr);
		assert.match(slowResult.stderr, /^held .* by fast since /m);
		assert.equal(recordOf(home).session, "fast");
		assert.equal(recordOf(home).token, rowOf(fast.stdout, "token"));
		assert.match(fs.readFileSync(prevPath(home), "utf8"), /^session dead-session$/m);
	});
});

describe("D — release ownership", () => {
	test("a wrong token keeps the lock and a good token removes it", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");

		const wrong = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", `${token}x`]);
		assert.equal(wrong.status, 5, wrong.stderr);
		assert.equal(rowOf(wrong.stderr, "lock lost"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), true);

		const second = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", `${token}x`]);
		assert.equal(second.status, 5, second.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);

		const good = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(good.status, 0, good.stderr);
		assert.equal(rowOf(good.stdout, "released"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), false);

		const gone = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(gone.status, 5, gone.stderr);
	});

	test("a release claim failure with the record still present exits 3", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");
		// The move fails and leaves the source in place, as an IO fault does.
		const shim = makeShimDir({ mv: ["#!/usr/bin/env bash", "exit 1"].join("\n") });

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", token],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock release claim failed/m);
		assert.equal(fs.existsSync(lockPath(home)), true, "the lock stays in place");
		assert.equal(claimNames(home).length, 0, "the failed claim temp is removed");
	});

	test("another session and another agent never release the lock", () => {
		const home = makeHome();
		const held = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(held.status, 0, held.stderr);
		const token = rowOf(held.stdout, "token");

		const otherSession = run(home, ["release", "--agent", AGENT, "--session", "other", "--token", token]);
		assert.equal(otherSession.status, 5, otherSession.stderr);
		const otherAgent = run(home, ["release", "--agent", "tester", "--session", SESSION, "--token", token]);
		assert.equal(otherAgent.status, 5, otherAgent.stderr);
		assert.equal(fs.existsSync(lockPath(home)), true);
	});
});

describe("E — refresh", () => {
	test("a second hold from the same session keeps the token and moves at", async () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(first.status, 0, first.stderr);
		const token = rowOf(first.stdout, "token");
		const at = rowOf(first.stdout, "at");
		const deadline = rowOf(first.stdout, "deadline");
		const before = recordOf(home).at;

		await settle(1100);
		const second = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(rowOf(second.stdout, "token"), token);
		assert.notEqual(rowOf(second.stdout, "at"), at);
		assert.notEqual(rowOf(second.stdout, "deadline"), deadline);
		assert.equal(recordOf(home).token, token);
		assert.ok(Number(recordOf(home).at) > Number(before), "the refresh moves the at field");
	});

	test("a refresh whose re-probe finds the name gone creates once", () => {
		const home = makeHome();
		plantLock(home, recordText(SESSION, `${SESSION}-old`, nowSeconds()));
		const realCat = realToolPath("cat");
		// The failed move leaves the record at the name. The second lock read then
		// removes it, so held_fail creates instead of returning to the claim compare.
		const shim = makeShimDir({
			mv: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ]; then',
				'  now=0',
				'  if [ -f "$CAT_COUNT" ]; then now=$(cat "$CAT_COUNT"); fi',
				'  now=$((now + 1))',
				'  printf "%s\\n" "$now" >"$CAT_COUNT"',
				'  if [ "$now" -ge 2 ]; then',
				'    rm -f -- "$target"',
				"    exit 1",
				"  fi",
				"fi",
				`exec ${realCat} "$@"`,
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION],
			{ ...shimPath(shim), CAT_COUNT: path.join(home, "cat-count") },
			15000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.match(rowOf(result.stdout, "token"), new RegExp(`^${SESSION}-\\d+$`), result.stdout);
		assert.notEqual(rowOf(result.stdout, "token"), `${SESSION}-old`);
		assert.equal(recordOf(home).session, SESSION);
	});

	test("an old token exits 5 after another session breaks the lock", () => {
		const home = makeHome();
		const first = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(first.status, 0, first.stderr);
		const token = rowOf(first.stdout, "token");

		// Age the held record past the TTL, so the next hold breaks it as stale.
		const record = recordOf(home);
		fs.writeFileSync(lockPath(home), recordText(SESSION, record.token ?? token, nowSeconds() - STALE_AGE));

		const other = run(home, ["hold", "--agent", AGENT, "--session", "other"]);
		assert.equal(other.status, 0, other.stderr);
		const lost = run(home, ["release", "--agent", AGENT, "--session", SESSION, "--token", token]);
		assert.equal(lost.status, 5, lost.stderr);
		assert.equal(rowOf(lost.stderr, "lock lost"), lockPath(home));
		assert.equal(fs.existsSync(lockPath(home)), true);
	});

	test("a refresh never buries a lock that another session took", async () => {
		const home = makeHome();
		const shim = makeDateShim();
		const mark = path.join(home, "refresh-slept");
		plantLock(home, recordText("aa", "aa-1", nowSeconds() - STALE_AGE));

		// The owner refreshes its own stale record; the epoch read sleeps, so the
		// other session breaks the record and takes the lock in that window.
		const refresh = startAsync(home, ["hold", "--agent", AGENT, "--session", "aa"], shimEnv(shim, "0.8", mark));
		await waitForMark(mark);

		const breaker = run(home, ["hold", "--agent", AGENT, "--session", "bb"]);
		assert.equal(breaker.status, 0, breaker.stderr);
		assert.ok(staleAgeOf(breaker.stdout) >= STALE_AGE, `the age is at least ${STALE_AGE}: ${breaker.stdout}`);

		const refreshResult = await refresh;
		assert.equal(refreshResult.status, 4, refreshResult.stderr);
		assert.match(refreshResult.stderr, /^held .* by bb since /m);
		assert.equal(recordOf(home).session, "bb");
		assert.equal(recordOf(home).token, rowOf(breaker.stdout, "token"));
	});
});

describe("F — a record that goes away mid-call", () => {
	test("a failed restore drops the claim once the prev copy holds the bytes", () => {
		const home = makeHome();
		const plant = recordText(SESSION, `${SESSION}-1`, nowSeconds());
		plantLock(home, plant);
		// The first digest read answers the planted bytes and every later read
		// another value, so the claim compare sees a changed record. `ln` always
		// fails, so the record cannot go back to the lock name.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), true),
			ln: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
		});

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", `${SESSION}-1`],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock restore failed/m);
		assert.equal(result.stderr.includes(prevPath(home)), true, `the error names the prev copy: ${result.stderr}`);
		assert.equal(result.stderr.split(prevPath(home)).length - 1, 1, `the error names the prev copy once: ${result.stderr}`);
		assert.equal(fs.readFileSync(prevPath(home), "utf8"), plant);
		assert.equal(claimNames(home).length, 0, "the prev copy lets the claim go");
	});

	test("a failed restore keeps the claim when the prev copy fails and names it", () => {
		const home = makeHome();
		const plant = recordText(SESSION, `${SESSION}-1`, nowSeconds());
		plantLock(home, plant);
		// The link and the prev copy both fail, so the claim is the only copy left.
		const shim = makeShimDir({
			cksum: countingCksum(realToolPath("cksum"), true),
			ln: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
			cp: ["#!/usr/bin/env bash", "exit 1"].join("\n"),
		});

		const result = run(
			home,
			["release", "--agent", AGENT, "--session", SESSION, "--token", `${SESSION}-1`],
			shimPath(shim),
		);

		assert.equal(result.status, 3, result.stderr);
		assert.equal(rows(result.stderr).length, 1, `one error line: ${result.stderr}`);
		assert.match(result.stderr, /^Error: lock restore failed/m);
		const claimed = /\/\S*\/\.journal-write\.claim\.[A-Za-z0-9]+/.exec(result.stderr);
		assert.ok(claimed, `the error names the kept claim: ${result.stderr}`);
		assert.equal(claimed[0].startsWith(journalsDir(home)), true, claimed[0]);
		assert.equal(result.stderr.split(claimed[0]).length - 1, 1, `the error names the claim once: ${result.stderr}`);
		assert.equal(fs.readFileSync(claimed[0], "utf8"), plant);
		assert.equal(claimNames(home).length, 1, "the claimed record stays on disk");
		assert.equal(fs.existsSync(prevPath(home)), false, "the failed copy leaves no prev file");
		assert.equal(result.stderr.includes(lockPath(home)), false, "the error does not name the lock");
	});

	test("a record that goes away before the read is absent, not an IO fault", () => {
		const home = makeHome();
		const realCat = realToolPath("cat");
		plantLock(home, recordText("dead-session", "dead-session-4242", nowSeconds() - STALE_AGE));
		// The first read of the lock name removes it and fails, so the name is gone
		// between the exist test and the read.
		const shim = makeShimDir({
			cat: [
				"#!/usr/bin/env bash",
				'target=""',
				'for arg in "$@"; do target="$arg"; done',
				'if [ "${target##*/}" = ".journal-write.lock" ] && [ -f "$target" ]; then',
				'  rm -f -- "$target"',
				"  exit 1",
				"fi",
				`exec ${realCat} "$@"`,
			].join("\n"),
		});

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], shimPath(shim), 15000);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(recordOf(home).session, SESSION, "the caller creates the lock");
	});

	test("a vanished record at the re-probe is created, not reported incomplete", () => {
		const home = makeHome();
		const clock = path.join(home, "clock");
		const start = 1000000000;
		fs.writeFileSync(clock, `${start}\n`);
		const lock = plantLock(home, recordText("other-session", "other-session-1", start));
		// The live holder drops its record during the wait and the clock reaches
		// the deadline, so the re-probe finds a free name and the caller creates.
		const shim = makeShimDir({
			date: [
				"#!/usr/bin/env bash",
				'for arg in "$@"; do',
				'  if [ "$arg" = "+%s" ]; then',
				'    cat "$CLOCK"',
				"    exit 0",
				"  fi",
				"done",
				`exec ${realToolPath("date")} "$@"`,
			].join("\n"),
			sleep: [
				"#!/usr/bin/env bash",
				'rm -f -- "$VANISH_LOCK"',
				'now=$(cat "$CLOCK")',
				'printf "%s\\n" "$((now + 1))" >"$CLOCK"',
			].join("\n"),
		});

		const result = run(
			home,
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "1"],
			{ ...shimPath(shim), VANISH_LOCK: lock, CLOCK: clock },
			20000,
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(rows(result.stdout).length, 4, `one hold block: ${result.stdout}`);
		assert.equal(rowOf(result.stdout, "lock"), lock, result.stdout);
		assert.match(rowOf(result.stdout, "token"), new RegExp(`^${SESSION}-\\d+$`), result.stdout);
		assert.equal(recordOf(home).session, SESSION, "the caller owns the lock");
		assert.equal(fs.existsSync(prevPath(home)), false, "an absent record is not kept");
	});

	test("a refresh that loses the record to another breaker creates again", () => {
		const home = makeHome();
		plantLock(home, recordText(SESSION, `${SESSION}-1`, nowSeconds()));
		// The move fails after it removed the source, as a rename does when another
		// breaker took the name first.
		const shim = makeShimDir({
			mv: ["#!/usr/bin/env bash", 'args=("$@")', 'rm -f -- "${args[1]}"', "exit 1"].join("\n"),
		});

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION], shimPath(shim), 15000);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(rowOf(result.stdout, "token"), `${SESSION}-1`);
		assert.equal(recordOf(home).session, SESSION);
	});
});

describe("the documented surface", () => {
	test("the removed subcommands exit 1 with one error line", () => {
		const home = makeHome();
		for (const removed of ["append", "check", "replace"]) {
			const result = run(home, [removed, "--agent", AGENT]);
			assert.equal(result.status, 1, `${removed}: ${result.stderr}`);
			assert.equal(rows(result.stderr).length, 1, `${removed} prints one line: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, removed);
			assert.equal(result.stdout, "");
		}
	});

	test("the help text names the two subcommands and the five flags", () => {
		const home = makeHome();
		const result = runRaw(["--help"], home);
		assert.equal(result.status, 0, result.stderr);
		for (const word of ["hold", "release", "--agent", "--session", "--token", "--home", "--timeout"]) {
			assert.ok(result.stdout.includes(word), `the help text names ${word}`);
		}
		for (const gone of ["append", "check", "replace", "--file"]) {
			assert.equal(result.stdout.includes(gone), false, `the help text must not name ${gone}`);
		}
		for (const code of ["0", "1", "2", "3", "4", "5"]) {
			assert.match(result.stdout, new RegExp(`^  ${code} `, "m"), `the help text names exit ${code}`);
		}
	});

	test("a usage error exits 1", () => {
		const home = makeHome();
		const cases: string[][] = [
			["hold", "--agent", AGENT],
			["hold", "--session", SESSION],
			["hold", "--agent", AGENT, "--session", SESSION, "--nope", "x"],
			["hold", "--agent", AGENT, "--session", SESSION, "positional"],
			["hold", "--agent", AGENT, "--agent", AGENT, "--session", SESSION],
			["hold", "--agent", AGENT, "--session"],
			["hold", "--agent", AGENT, "--session", SESSION, "--token", "abc"],
			["release", "--agent", AGENT, "--session", SESSION],
		];
		for (const args of cases) {
			const result = run(home, args);
			assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, args.join(" "));
		}
	});

	test("a bad value exits 2", () => {
		const home = makeHome();
		const cases: string[][] = [
			["hold", "--agent", "Orchestrator", "--session", SESSION],
			["hold", "--agent", AGENT, "--session", "has space"],
			["hold", "--agent", AGENT, "--session", "x".repeat(65)],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "0"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "121"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "soon"],
			["hold", "--agent", AGENT, "--session", SESSION, "--timeout", "-1"],
			["hold", "--agent", AGENT, "--session", "-x"],
			["release", "--agent", AGENT, "--session", SESSION, "--token", "x".repeat(81)],
		];
		for (const args of cases) {
			const result = run(home, args);
			assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stderr, /^Error: /, args.join(" "));
		}
		const relative = runRaw(["hold", "--agent", AGENT, "--session", SESSION, "--home", "relative"], home);
		assert.equal(relative.status, 2, relative.stderr);
	});

	test("a journals path that cannot be a folder exits 3", () => {
		const home = makeHome();
		fs.mkdirSync(path.join(home, "agent-notes", AGENT), { recursive: true });
		fs.writeFileSync(journalsDir(home), "not a folder");

		const result = run(home, ["hold", "--agent", AGENT, "--session", SESSION]);
		assert.equal(result.status, 3, result.stderr);
		assert.match(result.stderr, /^Error: lock folder create failed: /);
	});
});
