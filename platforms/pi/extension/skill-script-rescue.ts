/**
 * The skill-script rescue for the pi permission gate.
 *
 * One duty: the structural allow check that lets a deny-by-default segment run a
 * loaded skill's real `.sh` script. It is a path check, not a regex rule: a
 * forged `/tmp/skills/...` path never resolves inside a real skill dir. Deny and
 * ask rules still win. `permissions.ts` hands this rescue to `gate-call.ts`,
 * which calls it after the allow rules and before the mode default.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	unallowedSegments,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";

/** The shell interpreters whose first argument is the script to run. */
const SCRIPT_INTERPRETERS = new Set(["bash", "sh", "dash", "zsh"]);

/**
 * Real interpreter paths allowed when the interpreter token carries a slash.
 * The token is resolved through symlinks first, so symlinked `/bin/*` entries
 * still match their real `/usr/bin/*` target.
 */
const TRUSTED_INTERPRETER_PATHS = new Set([
	"/bin/bash",
	"/usr/bin/bash",
	"/bin/sh",
	"/usr/bin/sh",
	"/bin/dash",
	"/usr/bin/dash",
	"/bin/zsh",
	"/usr/bin/zsh",
]);

/** First-token class: trusted interpreter, forged look-alike, or the script path. */
type InterpreterKind = "trusted" | "untrusted" | "not-interpreter";

/**
 * A token is an interpreter look-alike only when its basename is one of the four
 * interpreter names. A bare name is trusted only when it is exactly one of those
 * names. A slash form is trusted only when it resolves through symlinks to a real
 * whitelisted interpreter path; a slash form that does not resolve, or resolves
 * elsewhere, is "untrusted", so `/tmp/x/bash` can never hide the script.
 */
function classifyInterpreterToken(token: string): InterpreterKind {
	if (!SCRIPT_INTERPRETERS.has(path.basename(token))) return "not-interpreter";
	if (!token.includes("/")) return "trusted"; // basename equals token here
	let real: string;
	try {
		real = fs.realpathSync(token);
	} catch {
		return "untrusted";
	}
	return TRUSTED_INTERPRETER_PATHS.has(real) ? "trusted" : "untrusted";
}

/**
 * A plain path token. It allows only path characters, so a backslash, `$`,
 * quote, space, or any other shell metacharacter denies the segment. Bash
 * strips those before it opens the file, so a token that keeps them is forged.
 */
const PLAIN_PATH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * True only when `candidate` resolves (through symlinks) to a regular file
 * inside one of the allow-listed script dirs. A path that does not resolve, or
 * that resolves to a directory or a FIFO, is denied: fail closed. Anything
 * placed inside a trusted scripts dir is trusted, so keep those dirs clean.
 */
function resolvesInsideScriptDir(candidate: string, dirs: string[]): boolean {
	let real: string;
	try {
		real = fs.realpathSync(candidate);
		if (!fs.statSync(real).isFile()) return false;
	} catch {
		return false;
	}
	return dirs.some((dir) => real === dir || real.startsWith(dir + path.sep));
}

/**
 * True when a shell segment runs a `.sh` script that lives inside one of the
 * loaded skills' real `scripts/` dirs. This is a STRUCTURAL check, not a pattern
 * match: a forged `/tmp/skills/...` path never resolves inside a real skill dir.
 *
 * A leading `cd <dir> &&` guard sets the resolution base; a relative target
 * resolves against `cwd`, so the checked path matches the executed path. The
 * first token is an interpreter only when it is a bare `bash`/`sh`/`dash`/`zsh`
 * or a slash form that resolves to a whitelisted real interpreter; any other
 * interpreter look-alike (`/tmp/x/bash`) denies the segment. Interpreter flags
 * are NOT skipped, so `bash -c ...` and `bash -x ...` stay denied. The script
 * token must be a plain path, contain a `/`, and end in `.sh`; `rm script.sh`
 * has first token `rm`, so it never passes. A redirect (`<` or `>`) anywhere
 * after the script denies the segment: the exception covers running the
 * script, never a file write or read the redirect adds.
 */
export function isAllowedSkillScript(segment: string, skillScriptsDirs: string[], cwd: string): boolean {
	let base = cwd;
	let rest = segment.trim();
	const cd = /^cd\s+(\S+)\s*&&\s*/.exec(rest);
	if (cd) {
		base = path.resolve(cwd, cd[1]);
		rest = rest.slice(cd[0].length).trim();
	}
	const tokens = rest.split(/\s+/);
	let scriptIndex = 0;
	const interpreter = classifyInterpreterToken(tokens[0] ?? "");
	if (interpreter === "untrusted") return false;
	if (interpreter === "trusted") scriptIndex = 1;
	const token = tokens[scriptIndex] ?? "";
	if (tokens.slice(scriptIndex + 1).some((arg) => /[<>]/.test(arg))) return false;
	if (!PLAIN_PATH_RE.test(token)) return false;
	if (!token.includes("/") || !token.endsWith(".sh")) return false;
	return resolvesInsideScriptDir(path.resolve(base, token), skillScriptsDirs);
}

/**
 * True when every segment that falls through to deny-by-default is a loaded
 * skill's real script. A segment with an unresolved expansion is in the list,
 * so the rescue can never launder one. This rescues a deny-by-default
 * fall-through, so deny and ask rules always win; segments the caller approved,
 * a session-allowed segment, or an allow rule already matched are skipped, so a
 * command may mix regex-allowed parts with skill scripts. An empty command
 * returns false.
 */
export function allSegmentsAreSkillScripts(
	command: string,
	approvedSegmentIndices: ReadonlySet<number>,
	skillScriptsDirs: string[],
	cwd: string,
	ruleSets: RuleSets,
	toolName: string,
	isSessionAllowed?: (rule: RawRule) => boolean,
): boolean {
	const { segments, indices } = unallowedSegments(
		command,
		true,
		ruleSets,
		toolName,
		approvedSegmentIndices,
		isSessionAllowed,
	);
	if (segments.length === 0) return false;
	return indices.every((idx) => isAllowedSkillScript(segments[idx], skillScriptsDirs, cwd));
}
