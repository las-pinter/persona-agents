/**
 * The permission policy files: parse, load, describe, and add a rule, plus
 * the decision log and the Pi agent folder. The decisions live in policy.ts.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PolicyError, type LoadedRule, type PolicyFile, type PolicyFileRef, type PolicyState, type Rule } from "./policy.ts";

/** Parse one policy file body. Throws PolicyError naming the file and the entry. */
export function parsePolicy(text: string, file: string): PolicyFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new PolicyError(`${file}: invalid JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PolicyError(`${file}: must hold an object`);
	const profiles = (parsed as PolicyFile).profiles;
	if (profiles === undefined) return {};
	if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new PolicyError(`${file}: "profiles" must hold an object`);
	for (const [name, entry] of Object.entries(profiles)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new PolicyError(`${file}: profiles.${name} must hold an object`);
		const rules = entry.rules;
		if (rules === undefined) continue;
		if (!Array.isArray(rules)) throw new PolicyError(`${file}: profiles.${name}.rules must hold an array`);
		rules.forEach((rule, index) => {
			const where = `${file}: profiles.${name}.rules[${index}]`;
			if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new PolicyError(`${where} must hold an object`);
			if (typeof rule.tool !== "string" || rule.tool === "") throw new PolicyError(`${where}.tool must be a tool name`);
			if (typeof rule.match !== "string" || rule.match === "") throw new PolicyError(`${where}.match must be a regular expression`);
			if (rule.verdict !== "allow" && rule.verdict !== "ask" && rule.verdict !== "deny") {
				throw new PolicyError(`${where}.verdict must be "allow", "ask", or "deny"`);
			}
			if (rule.reason !== undefined && typeof rule.reason !== "string") throw new PolicyError(`${where}.reason must be a string`);
			try {
				new RegExp(rule.match);
			} catch (error) {
				throw new PolicyError(`${where}.match is not a valid regular expression: ${(error as Error).message}`);
			}
		});
	}
	return parsed as PolicyFile;
}

/** The rules of one profile in a file, compiled. */
export function compiledRules(file: PolicyFile, profileName: string, ref: PolicyFileRef): LoadedRule[] {
	const rules = file.profiles?.[profileName]?.rules ?? [];
	return rules.map((rule, index) => ({
		rule,
		scope: ref.scope,
		file: ref.path,
		line: index + 1,
		regex: new RegExp(rule.match),
	}));
}

/**
 * Load every policy file, project first then user. A missing file is normal; a
 * malformed one is kept as an error and the gate fails closed while it exists.
 */
export function loadPolicy(refs: PolicyFileRef[], profileName: string): PolicyState {
	const ordered = [...refs].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1));
	const state: PolicyState = { rules: [], errors: [], grants: [] };
	for (const ref of ordered) {
		if (!existsSync(ref.path)) continue;
		try {
			const file = parsePolicy(readFileSync(ref.path, "utf8"), ref.path);
			state.rules.push(...compiledRules(file, profileName, ref));
		} catch (error) {
			state.errors.push({ file: ref.path, message: (error as Error).message });
		}
	}
	return state;
}

/** Append one record to the decisions log; a log write failure never blocks a tool call. */
export function appendDecision(logFile: string, line: string): void {
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, `${line}\n`);
	} catch {
		// The audit trail is best effort: a read-only home must not stop the work.
	}
}

/** The effective rules of a profile, for `/permissions list`. */
export function describeRules(state: PolicyState): string[] {
	if (state.rules.length === 0) return ["- none: the built-in doctrine decides every call"];
	return state.rules.map((loaded, index) => {
		const rule = loaded.rule;
		const reason = rule.reason ? ` — ${rule.reason}` : "";
		return `- ${index + 1}. ${rule.verdict} ${rule.tool} /${rule.match}/${reason}  [${loaded.scope}, line ${loaded.line}]`;
	});
}

/**
 * The policy file a `/permissions` rule goes to. A project rule needs the
 * project file, which exists only in a trusted project; it never falls back to
 * the user file, where it would apply everywhere.
 */
export function ruleTarget(refs: PolicyFileRef[], project: boolean): PolicyFileRef | undefined {
	return refs.find((ref) => ref.scope === (project ? "project" : "user"));
}

/** Add a rule to one policy file, creating it when needed. Returns the new rule count. */
export function addRule(ref: PolicyFileRef, profileName: string, rule: Rule): number {
	// A rule that does not compile would make the whole policy fail to load,
	// and the gate then denies every tool call.
	new RegExp(rule.match);
	const existing = existsSync(ref.path) ? parsePolicy(readFileSync(ref.path, "utf8"), ref.path) : {};
	const profiles = existing.profiles ?? {};
	const entry = profiles[profileName] ?? {};
	const rules = [...(entry.rules ?? []), rule];
	profiles[profileName] = { ...entry, rules };
	const next: PolicyFile = { ...existing, profiles };
	mkdirSync(dirname(ref.path), { recursive: true });
	writeFileSync(ref.path, `${JSON.stringify(next, null, 2)}\n`);
	return rules.length;
}

/** Write a fresh policy file skeleton, for a first `/permissions` edit. */
export function initPolicyFile(ref: PolicyFileRef): void {
	if (existsSync(ref.path)) return;
	mkdirSync(dirname(ref.path), { recursive: true });
	const skeleton: PolicyFile = { profiles: { companion: { rules: [] } } };
	writeFileSync(ref.path, `${JSON.stringify(skeleton, null, 2)}\n`);
}

/**
 * The Pi agent dir, where settings, extensions, and this package's log live.
 *
 * `PI_CODING_AGENT` is a marker pi sets to `"true"`, not a path; reading it
 * put the log and the user policy under `<cwd>/true/`. The path variable is
 * `PI_CODING_AGENT_DIR`.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, fallback: string = homedir()): string {
	return env.PI_CODING_AGENT_DIR || join(fallback, ".pi", "agent");
}
