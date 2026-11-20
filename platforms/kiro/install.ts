/**
 * The Kiro adapter installer.
 *
 *   node --experimental-strip-types install.ts --kiro-home=<dir>
 *        [--theme=<name>] [--dry-run] [--force] [--kiro-cli=<path>]
 *
 * It copies a self-contained payload into `<kiro home>/persona-agents/`
 * (content/, platforms/shared/, platforms/kiro/), installs the skills into
 * `<kiro home>/skills/`, and writes `pa-companion`, `pa-reviewer`, and
 * `pa-writer` into `<kiro home>/agents/`. The payload keeps the repository
 * layout, so the relative imports between the scripts still resolve.
 *
 * A skill folder is replaced only when it carries our marker
 * (`.persona-agents.json`). A folder owned by someone else stops the install
 * before any write; `--force` backs it up and replaces it.
 *
 * The owner's `chat.defaultAgent` is never changed. The installer warns when it
 * names an agent that does not exist.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRegistry, resolveTheme, type Registry } from "../shared/context/context.ts";
import { readTheme } from "./scripts/paths.ts";

/** The minimum Kiro CLI version with PermissionRequest and the compaction hooks. */
export const MIN_VERSION: [number, number, number] = [3, 4, 0];
/** The marker that says a skill folder belongs to this installer. */
export const SKILL_MARKER = ".persona-agents.json";
/** The agents Kiro ships; a default naming one of these needs no file. */
export const BUILTIN_AGENTS = new Set(["kiro_default", "kiro_help", "kiro_planner"]);
/** The three agents this installer writes. */
export const AGENT_NAMES = ["pa-companion", "pa-reviewer", "pa-writer"] as const;

export interface InstallOptions {
	/** The repository root that holds content/ and platforms/. */
	root: string;
	/** The Kiro global directory, usually ~/.kiro. */
	kiroHome: string;
	/** The theme to write; the existing config theme or the default when absent. */
	theme?: string;
	dryRun?: boolean;
	force?: boolean;
	/** The time stamped on a backup file name. */
	now?: Date;
}

/** One skill folder and its destination. */
export interface SkillPlan {
	name: string;
	src: string;
	dest: string;
	/** `none` when the destination is free, `ours` with the marker, `foreign` otherwise. */
	status: "none" | "ours" | "foreign";
}

/** The plan the installer prints and applies. */
export interface Plan {
	kiroHome: string;
	payload: string;
	theme: string;
	skills: SkillPlan[];
	skillNames: string[];
	warnings: string[];
}

export interface Preflight {
	plan: Plan | null;
	error: string;
}

/** The package version, from package.json. */
export function packageVersion(root: string): string {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** `x.y.z` from a `kiro-cli x.y.z` line, or null. */
export function parseVersion(text: string): [number, number, number] | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when a version is at least the minimum. */
export function versionAtLeast(version: [number, number, number], min: [number, number, number] = MIN_VERSION): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] > min[i]) return true;
		if (version[i] < min[i]) return false;
	}
	return true;
}

/** Check the installed kiro-cli. */
export function checkKiroVersion(command: string): { ok: boolean; version: string; error: string } {
	const run = spawnSync(command, ["--version"], { encoding: "utf8" });
	if (run.error) return { ok: false, version: "", error: `cannot run ${command}: ${run.error.message}` };
	if (run.status !== 0) return { ok: false, version: "", error: `${command} --version exited with code ${run.status}` };
	const parsed = parseVersion(run.stdout ?? "");
	if (!parsed) return { ok: false, version: "", error: `${command} --version did not print a version` };
	const text = parsed.join(".");
	return { ok: versionAtLeast(parsed), version: text, error: versionAtLeast(parsed) ? "" : `${text} is below the required ${MIN_VERSION.join(".")}` };
}

/** The skill folders of content/skills, sorted. */
export function skillFolders(contentDir: string): string[] {
	const root = join(contentDir, "skills");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

/** The status of a skill destination. */
function skillStatus(dest: string): SkillPlan["status"] {
	if (!existsSync(dest)) return "none";
	return existsSync(join(dest, SKILL_MARKER)) ? "ours" : "foreign";
}

/** The warning for a default agent that no file and no built-in names. */
export function defaultAgentWarning(kiroHome: string, installing: readonly string[] = AGENT_NAMES): string {
	try {
		const cli = JSON.parse(readFileSync(join(kiroHome, "settings", "cli.json"), "utf8")) as { "chat.defaultAgent"?: unknown };
		const name = typeof cli["chat.defaultAgent"] === "string" ? cli["chat.defaultAgent"] : "";
		if (!name || installing.includes(name) || BUILTIN_AGENTS.has(name) || existsSync(join(kiroHome, "agents", `${name}.json`))) return "";
		return `chat.defaultAgent is set to "${name}", which no agent file or built-in provides; Kiro will warn at launch`;
	} catch {
		return "";
	}
}

/** The plan, or the reason the install cannot run. */
export function preflight(options: InstallOptions): Preflight {
	const contentDir = join(options.root, "content");
	let registry: Registry;
	try {
		registry = loadRegistry(contentDir);
	} catch (error) {
		return { plan: null, error: (error as Error).message };
	}
	const wanted = options.theme ?? readTheme(options.kiroHome);
	let theme: string;
	try {
		theme = resolveTheme(registry, wanted);
	} catch (error) {
		return { plan: null, error: (error as Error).message };
	}
	const payload = join(options.kiroHome, "persona-agents");
	const skillsRoot = join(options.kiroHome, "skills");
	const skills = skillFolders(contentDir).map((name) => {
		const dest = join(skillsRoot, name);
		return { name, src: join(contentDir, "skills", name), dest, status: skillStatus(dest) };
	});
	const foreign = skills.filter((skill) => skill.status === "foreign").map((skill) => skill.dest);
	if (foreign.length > 0 && !options.force) {
		return {
			plan: null,
			error: `these skill folders are not owned by persona-agents:\n  ${foreign.join("\n  ")}\nMove them, or rerun with --force to back them up and replace them.`,
		};
	}
	const warnings = [defaultAgentWarning(options.kiroHome)].filter((warning) => warning !== "");
	return {
		plan: { kiroHome: options.kiroHome, payload, theme, skills, skillNames: skills.map((skill) => skill.name), warnings },
		error: "",
	};
}

/** A shell-safe single-quoted argument. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A node command for one adapter script. */
function nodeCommand(payload: string, script: string, args: string[]): string {
	return ["node", "--experimental-strip-types", "--no-warnings", shellQuote(join(payload, "platforms", "kiro", "scripts", script)), ...args.map(shellQuote)].join(" ");
}

/** The secret paths no adapter tool may read. */
export const SECRET_PATHS = ["**/.env", "**/.env.*", "**/.ssh/**", "**/.aws/**", "**/*.pem", "**/id_rsa*", "**/.netrc"];
/** The read-only commands both agents may run silently. */
export const READ_COMMANDS = ["git status", "git diff*", "git log*", "git show*", "git rev-parse*", "git ls-files*", "ls *", "pwd"];
/** The test commands both agents may run silently. */
export const TEST_COMMANDS = [
	"npm test",
	"npm test *",
	"npm run *",
	"node --test*",
	"node --experimental-strip-types --test *",
	"npx tsc *",
	"npx shellcheck *",
];
/**
 * The companion runs the adapter scripts (`review.ts`, `retro.ts`, `journal.ts`)
 * through node, and a project script is the same trust as the write access it
 * already has. The reviewer keeps the narrower test commands.
 */
export const SCRIPT_COMMANDS = ["node *"];

/** The companion's capability rules. */
export function companionRules(payload: string, kiroHome: string): unknown[] {
	const agents = join(kiroHome, "agents");
	const skills = join(kiroHome, "skills");
	return [
		{ capability: "fs_read", match: ["./**", "~/agent-notes/**", `${payload}/**`], effect: "allow" },
		{ capability: "fs_read", match: SECRET_PATHS, effect: "deny" },
		{ capability: "fs_write", match: ["./**", "~/agent-notes/**"], effect: "allow" },
		{ capability: "fs_write", match: [`${payload}/**`, `${agents}/pa-*`, `${skills}/**`, `${kiroHome}/settings/**`], effect: "deny" },
		{ capability: "skill", match: ["*"], effect: "allow" },
		{ capability: "subagent", match: ["pa-reviewer"], effect: "allow" },
		{ capability: "shell", match: [...READ_COMMANDS, ...TEST_COMMANDS, ...SCRIPT_COMMANDS], effect: "allow" },
	];
}

/** The reviewer's capability rules: reads and the test suite, no writes. */
export function reviewerRules(payload: string): unknown[] {
	return [
		{ capability: "fs_read", match: ["./**", "~/agent-notes/**", `${payload}/**`], effect: "allow" },
		{ capability: "fs_read", match: SECRET_PATHS, effect: "deny" },
		{ capability: "fs_write", match: ["**"], effect: "deny" },
		{ capability: "skill", match: ["*"], effect: "allow" },
		{ capability: "shell", match: [...READ_COMMANDS, ...TEST_COMMANDS], effect: "allow" },
	];
}

/** The companion's inline hooks. */
export function companionHooks(payload: string, kiroHome: string, kiroCli: string): unknown[] {
	const kiro = `--kiro-home=${kiroHome}`;
	return [
		{
			name: "persona-agents-context",
			trigger: "SessionStart",
			action: { type: "command", command: nodeCommand(payload, "context.ts", ["session", kiro]) },
			timeout: 10,
		},
		{
			name: "persona-agents-startup",
			trigger: "SessionStart",
			action: { type: "command", command: nodeCommand(payload, "context.ts", ["startup", kiro]) },
			timeout: 10,
		},
		{
			name: "persona-agents-commit-gate",
			trigger: "PermissionRequest",
			action: { type: "command", command: nodeCommand(payload, "gate.ts", ["permission", "companion", kiro]) },
			timeout: 10,
		},
		{
			name: "persona-agents-review-record",
			trigger: "Stop",
			action: { type: "command", command: nodeCommand(payload, "review-record.ts", [kiro]) },
			timeout: 10,
		},
		{
			name: "persona-agents-precompact",
			trigger: "PreCompact",
			action: { type: "command", command: nodeCommand(payload, "compact.ts", ["pre", kiro]) },
			timeout: 30,
		},
		{
			name: "persona-agents-postcompact",
			trigger: "PostCompact",
			action: { type: "command", command: nodeCommand(payload, "compact.ts", ["post", kiro]) },
			timeout: 30,
		},
		{
			name: "persona-agents-journal-end",
			trigger: "SessionEnd",
			action: { type: "command", command: nodeCommand(payload, "journal-end.ts", ["hook", kiro, `--kiro-cli=${kiroCli}`]) },
			timeout: 10,
		},
	];
}

/** The reviewer's inline hooks: the read-only shell gate. */
export function reviewerHooks(payload: string, kiroHome: string): unknown[] {
	return [
		{
			name: "persona-agents-reviewer-gate",
			trigger: "PreToolUse",
			action: { type: "command", command: nodeCommand(payload, "gate.ts", ["pretool", "reviewer", `--kiro-home=${kiroHome}`]) },
			timeout: 10,
		},
	];
}

/** The companion agent config. */
export function companionAgent(plan: Plan, registry: Registry, kiroCli: string): Record<string, unknown> {
	const entry = registry[plan.theme]?.companion;
	return {
		name: "pa-companion",
		description: entry?.description ?? "The persona-agents companion: one agent that plans, builds, tests, and commits with the owner, in a persona voice.",
		// Kiro rejects an absolute `file://` prompt, so the body is inlined.
		prompt: readFileSync(join(plan.payload, "content", "professions", "companion.md"), "utf8"),
		...(entry?.welcomeMessage ? { welcomeMessage: entry.welcomeMessage } : {}),
		tools: ["read", "write", "shell", "web", "subagent/pa-reviewer"],
		resources: plan.skillNames.map((name) => `skill://${join(plan.kiroHome, "skills", name, "SKILL.md")}`),
		permissions: { rules: companionRules(plan.payload, plan.kiroHome) },
		hooks: companionHooks(plan.payload, plan.kiroHome, kiroCli),
	};
}

/** The reviewer agent config: read-only, own context, the checklist skill. */
export function reviewerAgent(plan: Plan): Record<string, unknown> {
	return {
		name: "pa-reviewer",
		description: "Independent, read-only review of a change, in a separate context. Returns findings with severity and location and a verdict. Started by the companion's review skill.",
		prompt: readFileSync(join(plan.payload, "platforms", "kiro", "agents", "reviewer-prompt.md"), "utf8"),
		tools: ["read", "web", "shell"],
		resources: plan.skillNames.map((name) => `skill://${join(plan.kiroHome, "skills", name, "SKILL.md")}`),
		permissions: { rules: reviewerRules(plan.payload) },
		hooks: reviewerHooks(plan.payload, plan.kiroHome),
	};
}

/** The tool-less journal writer agent. */
export function writerAgent(): Record<string, unknown> {
	return {
		name: "pa-writer",
		description: "Writes one journal entry from the material the session-end safety net provides. No tools.",
		prompt:
			"You write one journal entry from the material you are given. Output only the entry, in markdown, at most 30 lines, plain and factual, no persona voice, never a persona's voice. Do not use tools.",
		tools: [],
		permissions: { rules: [] },
	};
}

/** Every markdown file under a folder. */
function markdownFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
		else if (name.endsWith(".md")) files.push(path);
	}
	return files;
}

/** Replace the two installer tokens in a skill tree. */
export function substituteSkillTokens(dir: string, skillDir: string, root: string): number {
	let changed = 0;
	for (const file of markdownFiles(dir)) {
		const text = readFileSync(file, "utf8");
		const next = text
			.replaceAll("{{PERSONA_AGENTS_KIRO_SKILL_DIR}}", skillDir)
			.replaceAll("{{PERSONA_AGENTS_KIRO_ROOT}}", root);
		if (next !== text) {
			writeFileSync(file, next);
			changed++;
		}
	}
	return changed;
}

/** Write a file only when its text differs; back up the old file first. */
function writeIfChanged(file: string, text: string, stamp: string): boolean {
	if (existsSync(file)) {
		try {
			if (readFileSync(file, "utf8") === text) return false;
		} catch {
			// An unreadable file is replaced, with a backup.
		}
		mkdirSync(dirname(file), { recursive: true });
		renameSync(file, `${file}.bak-${stamp}`);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return true;
}

/** A timestamp for backup names. */
function stampOf(now: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** The dry-run and real-run action list. */
export function install(options: InstallOptions & { kiroCli?: string }): { ok: boolean; error: string; plan: Plan | null; actions: string[] } {
	const checked = preflight(options);
	if (!checked.plan) return { ok: false, error: checked.error, plan: null, actions: [] };
	const plan = checked.plan;
	const stamp = stampOf(options.now ?? new Date());
	const version = packageVersion(options.root);
	const registry = loadRegistry(join(options.root, "content"));
	const actions: string[] = [];
	actions.push(`payload: ${plan.payload}`);
	actions.push(`theme: ${plan.theme}`);
	actions.push(`skills: ${plan.skills.length}`);
	if (options.dryRun) {
		for (const skill of plan.skills) actions.push(`  skill ${skill.name}: ${skill.status === "foreign" ? "back up and replace (--force)" : "install"}`);
		actions.push(`agents: ${AGENT_NAMES.join(", ")}`);
		return { ok: true, error: "", plan, actions };
	}

	// 1. Payload: replace only our three folders; state/ and config.json stay.
	const payload = plan.payload;
	for (const child of ["content", "platforms"]) rmSync(join(payload, child), { recursive: true, force: true });
	mkdirSync(join(payload, "platforms"), { recursive: true });
	cpSync(join(options.root, "content"), join(payload, "content"), { recursive: true });
	cpSync(join(options.root, "platforms", "shared"), join(payload, "platforms", "shared"), { recursive: true });
	cpSync(join(options.root, "platforms", "kiro"), join(payload, "platforms", "kiro"), { recursive: true });
	writeIfChanged(join(payload, "config.json"), `${JSON.stringify({ theme: plan.theme }, null, 2)}\n`, stamp);

	// 2. Skills.
	mkdirSync(join(plan.kiroHome, "skills"), { recursive: true });
	for (const skill of plan.skills) {
		if (skill.status === "foreign") renameSync(skill.dest, `${skill.dest}.bak-${stamp}`);
		else if (existsSync(skill.dest)) rmSync(skill.dest, { recursive: true, force: true });
		cpSync(skill.src, skill.dest, { recursive: true });
		substituteSkillTokens(skill.dest, skill.dest, payload);
		writeFileSync(join(skill.dest, SKILL_MARKER), `${JSON.stringify({ name: "persona-agents", version }, null, 2)}\n`);
	}

	// 3. Agents.
	const agents = {
		"pa-companion": companionAgent(plan, registry, options.kiroCli ?? "kiro-cli"),
		"pa-reviewer": reviewerAgent(plan),
		"pa-writer": writerAgent(),
	};
	for (const [name, config] of Object.entries(agents)) {
		writeIfChanged(join(plan.kiroHome, "agents", `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, stamp);
	}
	return { ok: true, error: "", plan, actions };
}

/** The CLI's option seam. */
function option(name: string, argv: string[]): string | undefined {
	const arg = argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const named = option("kiro-home", process.argv);
	const envHome = process.env.HOME ?? "";
	const kiroHome = named ?? (envHome.startsWith("/") ? join(envHome, ".kiro") : "");
	if (!kiroHome || !kiroHome.startsWith("/")) {
		process.stderr.write("Kiro install: cannot determine the Kiro home; pass --kiro-home=<absolute path>\n");
		process.exit(1);
	}
	const kiroCli = option("kiro-cli", process.argv) ?? "kiro-cli";
	const check = checkKiroVersion(kiroCli);
	if (!check.ok) {
		process.stderr.write(`Kiro install: ${check.error}\n`);
		process.exit(1);
	}
	const result = install({
		root,
		kiroHome,
		theme: option("theme", process.argv),
		dryRun: process.argv.includes("--dry-run"),
		force: process.argv.includes("--force"),
		kiroCli,
	});
	if (!result.ok) {
		process.stderr.write(`Kiro install: ${result.error}\n`);
		process.exit(1);
	}
	for (const warning of result.plan?.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);
	const prefix = result.actions.length && process.argv.includes("--dry-run") ? "Dry run: " : "";
	for (const action of result.actions) process.stdout.write(`${prefix}${action}\n`);
	if (!process.argv.includes("--dry-run")) {
		process.stdout.write(`Kiro installed for ${basename(kiroHome)} (kiro-cli ${check.version}).\n`);
		process.stdout.write("Start the companion: kiro-cli --agent pa-companion\n");
		process.stdout.write("Update: git pull, then rerun ./install.sh\n");
	}
}
