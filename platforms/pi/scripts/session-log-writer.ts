#!/usr/bin/env node
/**
 * The detached session-log writer.
 *
 * Started by the extension on `session_shutdown` (quit), as its own process so
 * the exiting session is never held open. It runs one headless Pi request with
 * no tools, and writes the entry only when the session still has none, and only
 * when the model returned something that looks like an entry.
 *
 * Usage: node --experimental-strip-types session-log-writer.ts <payload.json> [--pi=<path>]
 *
 * A failure here is silent by design: a session log is a convenience, and a
 * shutdown must never surface an error to the owner.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { entryPath } from "../../shared/notes/session-log.ts";
import { hasMaterial, writerPrompt, type Payload } from "../../shared/notes/session-log-net.ts";

const WRITER_TIMEOUT_MS = 180_000;

/** The command that starts another Pi process, from the payload or the flag. */
function piInvocation(payload: Payload, argv: string[]): { command: string; args: string[] } {
	const flag = argv.find((value) => value.startsWith("--pi="));
	if (flag) return { command: flag.slice("--pi=".length), args: [] };
	return payload.pi ?? { command: "pi", args: [] };
}

function main(): void {
	const payloadFile = process.argv[2];
	if (!payloadFile || !existsSync(payloadFile)) return;
	try {
		writeEntry(JSON.parse(readFileSync(payloadFile, "utf8")) as Payload);
	} catch {
		// A malformed or half-written payload leaves no entry and no noise.
	} finally {
		rmSync(payloadFile, { force: true });
	}
}

function writeEntry(payload: Payload): void {
	{
		if (!hasMaterial(payload.sources)) return;
		const at = new Date(payload.at);
		const path = entryPath(payload.notesDir, payload.session, at);
		if (existsSync(path)) return;
		const invocation = piInvocation(payload, process.argv.slice(2));
		const run = spawnSync(invocation.command, [...invocation.args, "-p", "-nt", "--no-session"], {
			input: writerPrompt(payload, payload.sources),
			encoding: "utf8",
			timeout: WRITER_TIMEOUT_MS,
			cwd: tmpdir(),
		});
		const entry = (run.stdout ?? "").trim();
		if (run.status !== 0 || !entry.startsWith("#")) return;
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) writeFileSync(path, `${entry}\n`);
	}
}

main();
