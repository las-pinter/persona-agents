/**
 * Shared helpers for the journal write suite.
 *
 * Every case runs the real shipped script by absolute path with a throw-away
 * home under os.tmpdir(), so no case reads or writes the real home folder.
 */

import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
export const STAMP_TIME = "2026-10-28T21:40:12Z";

/** Stamp plus blank line use two of the 200 records, so a block holds 198 rows. */
export const BLOCK_MAX_ROWS = 198;

/** Trees made by the running case; each case must leave no tree behind. */
let caseTrees: string[] = [];
let blockSeq = 0;

/** Remove every tree the case made, so a failure leaves no litter. */
export function cleanup(): void {
	for (const tree of caseTrees) fs.rmSync(tree, { recursive: true, force: true });
	caseTrees = [];
	blockSeq = 0;
}

/** A fresh tree under the system temp folder, resolved to a real path. */
export function makeTree(): string {
	const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "journal-write-")));
	caseTrees.push(tree);
	return tree;
}

export function journalsDir(home: string, agent: string = AGENT): string {
	return path.join(home, "agent-notes", agent, "journals");
}

/** The lock path the script documents, one lock per agent folder. */
export function lockPath(home: string, agent: string = AGENT): string {
	return path.join(journalsDir(home, agent), ".journal-write.lock");
}

/** A home with agent-notes for the agent, journals, and the incoming folder. */
export function makeHome(agent: string = AGENT): string {
	const home = makeTree();
	fs.mkdirSync(path.join(journalsDir(home, agent), "incoming"), { recursive: true });
	return home;
}

export function todayName(): string {
	return (spawnSync("date", ["+%Y-%m-%d"], { encoding: "utf8" }).stdout ?? "").trim();
}

export function dailyPath(home: string, name: string = todayName()): string {
	return path.join(journalsDir(home), "daily", `${name}.md`);
}

export function weeklyPath(home: string, name: string): string {
	return path.join(journalsDir(home), "weekly", `${name}.md`);
}

/** Write one text to a target path, creating its folder. */
export function seedTarget(target: string, text: string): string {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
	return target;
}

/** One block file with a unique stamp, at a chosen name or the next default. */
function writeBlock(home: string, rows: string[], agent: string, name?: string): string {
	blockSeq += 1;
	const stamp = `<!-- session: ${STAMP_TIME} ${agent} block${blockSeq} -->`;
	const file = path.join(journalsDir(home), "incoming", name ?? `block-${blockSeq}.md`);
	fs.writeFileSync(file, `${stamp}\n\n${rows.join("\n")}\n`);
	return file;
}

/** A stamped block: the stamp line, one blank line, then the body rows. */
export function makeBlock(home: string, rows: string[], agent: string = AGENT): string {
	return writeBlock(home, rows, agent);
}

/** A block at a name the default cannot carry, such as one with a backslash. */
export function namedBlock(home: string, name: string, rows: string[], agent: string = AGENT): string {
	return writeBlock(home, rows, agent, name);
}

/** A block of raw bytes, for a stamp that must fail validation. */
export function rawBlock(home: string, text: string): string {
	blockSeq += 1;
	const file = path.join(journalsDir(home), "incoming", `raw-${blockSeq}.md`);
	fs.writeFileSync(file, text);
	return file;
}

export function stampOf(block: string): string {
	return (fs.readFileSync(block, "utf8").split("\n")[0] ?? "").replace(/[\r\n]+$/, "");
}

/** The body rows of a block file: everything after the stamp and the blank row. */
export function blockBody(block: string): string[] {
	return fileLines(fs.readFileSync(block, "utf8")).slice(2);
}

/** The rows of one text, without the empty row that follows the final newline. */
export function fileLines(text: string): string[] {
	const rows = text.split("\n");
	if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}

/** How often one whole row appears in a text. */
export function countRow(text: string, row: string): number {
	return fileLines(text).filter((entry) => entry === row).length;
}

export function digestOf(bytes: string | Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** One block of `rows` rows, with a unique first and last row. */
export function blockRows(tag: string, rows: number): string[] {
	const body = Array.from({ length: rows - 2 }, (_unused, index) => `${tag}-row-${index + 1}`);
	return [`${tag}-first`, ...body, `${tag}-last`];
}

/** The row count both blocks must produce in one fresh daily target. */
export function expectedLines(blocks: string[]): number {
	const body = blocks.reduce((sum, file) => sum + blockBody(file).length, 0);
	return 2 + blocks.length + body + (blocks.length - 1);
}

export interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** The one synchronous spawn call: bash, the real script, and no --home. */
export function runRaw(home: string, args: string[]): RunResult {
	const result = spawnSync("bash", [writeScript, ...args], {
		env: { ...process.env, HOME: home },
		encoding: "utf8",
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

export function run(home: string, args: string[]): RunResult {
	return runRaw(home, [...args, "--home", home]);
}

/** The one concurrent spawn call, for a case that must overlap two runs. */
/** The one concurrent spawn call: bash, the real script, and a bound home. */
function startAsync(home: string, args: string[]): { pid: number; result: Promise<RunResult> } {
	const child = spawn("bash", [writeScript, ...args, "--home", home], {
		env: { ...process.env, HOME: home },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const result = new Promise<RunResult>((resolve) => {
		child.on("close", (status) => resolve({ stdout, stderr, status: status ?? 1 }));
	});
	return { pid: child.pid ?? -1, result };
}

export function runAsync(home: string, args: string[]): Promise<RunResult> {
	return startAsync(home, args).result;
}

/** The same call with the pid, so a case can wait on the script's own signal. */
export function runChild(home: string, args: string[]): { pid: number; result: Promise<RunResult> } {
	return startAsync(home, args);
}

/** True once one open descriptor of the child points at the lock path. */
function holdsLockFd(pid: number, lock: string): boolean {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(`/proc/${pid}/fd`);
	} catch {
		return false;
	}
	return entries.some((fd) => {
		try {
			return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === lock;
		} catch {
			return false;
		}
	});
}

/**
 * Resolves once the child holds the script's lock descriptor. The script opens
 * that descriptor after it validates the block, so the signal proves validation
 * finished and the writer is at or past the lock.
 */
export async function waitForLockOpen(pid: number, home: string): Promise<void> {
	const lock = lockPath(home);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (holdsLockFd(pid, lock)) return;
		await settle(10);
	}
	throw new Error(`the writer did not open the lock within 5 s (pid ${pid})`);
}

export function appendArgs(block: string, extra: string[] = []): string[] {
	return ["append", "--agent", AGENT, "--block", block, ...extra];
}

/** The digest value of a `check` report. */
export function reportDigest(stdout: string): string {
	const row = fileLines(stdout).find((line) => line.startsWith("digest "));
	assert.ok(row, `the report must hold a digest line: ${stdout}`);
	return row.slice("digest ".length);
}

export interface LockHolder {
	/** Resolves once the holder owns the lock, so no case has to guess. */
	ready: Promise<void>;
	release: () => void;
	exited: Promise<void>;
}

/** A lock holder on the documented lock path; it drops the lock on release. */
export function holdLock(home: string, seconds = 5): LockHolder {
	const lock = lockPath(home);
	const child = spawn("flock", ["-w", "5", lock, "sh", "-c", `printf ready; sleep ${seconds}`], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = new Promise<void>((resolve) => {
		child.on("close", () => resolve());
	});
	const ready = new Promise<void>((resolve) => {
		const done = (): void => resolve();
		child.stdout.setEncoding("utf8").on("data", done);
		child.on("close", done);
	});
	return { ready, release: () => child.kill(), exited };
}

export async function settle(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A checker that answers true once the promise has settled. */
export function didSettle<T>(promise: Promise<T>): () => boolean {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	return () => settled;
}
