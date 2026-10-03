/**
 * Agent and persona discovery for the persona-agents pi package.
 *
 * Sources (all optional, merged by name):
 *   - user:    ~/.pi/agent/agents,     ~/.pi/agent/personas
 *   - project: nearest .pi/agents,     nearest .pi/personas
 *   - package: <this package>/agents,  <this package>/personas
 *
 * Agent files: markdown with YAML frontmatter. Legacy profession files (no
 * frontmatter) are NOT recognized as pi agents — the package ships converted
 * copies in `agents/`. Persona files are format-tolerant: legacy persona
 * files (plain markdown starting with a `# heading`, as shipped in
 * `personas/<theme>/`) work as-is; an optional frontmatter block adds
 * name/description metadata.
 */

import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "package";

export interface PermissionRule {
	tool?: string;
	match: string;
	reason?: string;
}

export interface PermissionConfig {
	mode?: "allow-unless-matched" | "deny-by-default";
	allow?: PermissionRule[];
	ask?: PermissionRule[];
	deny?: PermissionRule[];
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Default persona reference: "theme/name", "name", or a theme ("goblin"). */
	persona?: string;
	/** Regex-bound skills this agent may load (glob style, resolves in a later phase). */
	skills?: string[];
	/** Skills guaranteed injected into the system prompt at startup (glob style). */
	alwaysLoad?: string[];
	/** Regex-bound file resources attached to this agent's context (later phase). */
	resources?: string[];
	/** Per-agent permission rules from frontmatter. */
	permissions?: PermissionConfig;
	/**
	 * Whether this agent may be spawned as a subagent via the subagent tool.
	 * Defaults to true when frontmatter omits `spawnable`. The orchestrator and
	 * overseer templates ship `spawnable: false` — they run as the main session
	 * only, so a dispatcher cannot escalate by spawning a commit-capable agent.
	 */
	spawnable?: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface PersonaConfig {
	name: string;
	theme?: string;
	description?: string;
	/** The persona's full markdown body (prompt content). Legacy files are used verbatim. */
	body: string;
	filePath: string;
	/** Filename stem (without .md) — used to match agents.json personaFile references. */
	fileNameStem: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	personas: PersonaConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	persona?: unknown;
	skills?: unknown;
	alwaysLoad?: unknown;
	resources?: unknown;
	permissions?: unknown;
	spawnable?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Like parseToolList but for glob-style string resources (skills/resources). */
function parseStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const items = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function parsePermissionConfig(value: unknown): PermissionConfig | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const cfg = value as Record<string, unknown>;
	const rules = (v: unknown): PermissionRule[] | undefined => {
		if (!Array.isArray(v)) return undefined;
		const out: PermissionRule[] = [];
		for (const item of v) {
			if (typeof item !== "object" || item === null) continue;
			const r = item as Record<string, unknown>;
			if (typeof r.match !== "string" || !r.match) continue;
			out.push({
				tool: typeof r.tool === "string" ? r.tool : undefined,
				match: r.match,
				reason: typeof r.reason === "string" ? r.reason : undefined,
			});
		}
		return out.length > 0 ? out : undefined;
	};
	const mode = cfg.mode === "deny-by-default" ? "deny-by-default" : undefined;
	const allow = rules(cfg.allow);
	const ask = rules(cfg.ask);
	const deny = rules(cfg.deny);
	if (!mode && !allow && !ask && !deny) return undefined;
	return { mode: mode ?? "allow-unless-matched", allow, ask, deny };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			persona: typeof frontmatter.persona === "string" ? frontmatter.persona : undefined,
			skills: parseStringList(frontmatter.skills),
			alwaysLoad: parseStringList(frontmatter.alwaysLoad),
			resources: parseStringList(frontmatter.resources),
			permissions: parsePermissionConfig(frontmatter.permissions),
			// `spawnable` must be a boolean `false` to disable spawning; the FAQ-level
			// typo of a quoted "false" string is treated as disabled too rather than
			// silently re-enabling spawning. Absent/undefined/any other value keeps
			// the agent spawnable (legacy and third-party files carry no field).
			spawnable: !(frontmatter.spawnable === false || frontmatter.spawnable === "false"),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

/** First `# heading` line if present (used as description fallback for legacy personas). */
function headingFromBody(body: string): string | undefined {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			return trimmed.replace(/^#+\s*/, "").trim();
		}
		if (trimmed && !trimmed.startsWith("#")) return undefined;
	}
	return undefined;
}

function loadPersonasFromDir(dir: string): PersonaConfig[] {
	const personas: PersonaConfig[] = [];
	if (!fs.existsSync(dir)) return personas;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return personas;
	}

	// Immediate files -> theme-less personas; subdirs -> <theme>/<name>.md
	for (const entry of entries) {
		if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
			const filePath = path.join(dir, entry.name);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
				const name =
					(typeof frontmatter.name === "string" && frontmatter.name) || entry.name.replace(/\.md$/, "");
				personas.push({
					name,
					description: typeof frontmatter.description === "string" ? frontmatter.description : headingFromBody(body),
					body,
					filePath,
					fileNameStem: entry.name.replace(/\.md$/, ""),
				});
			} catch {
				/* skip */
			}
		} else if (entry.isDirectory()) {
			const theme = entry.name;
			let themeEntries: fs.Dirent[];
			try {
				themeEntries = fs.readdirSync(path.join(dir, theme), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const themeEntry of themeEntries) {
				if (!themeEntry.name.endsWith(".md")) continue;
				if (!themeEntry.isFile() && !themeEntry.isSymbolicLink()) continue;
				const filePath = path.join(dir, theme, themeEntry.name);
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
					const name =
						(typeof frontmatter.name === "string" && frontmatter.name) ||
						themeEntry.name.replace(/\.md$/, "");
					personas.push({
						name,
						theme,
						description:
							typeof frontmatter.description === "string" ? frontmatter.description : headingFromBody(body),
						body,
						filePath,
						fileNameStem: themeEntry.name.replace(/\.md$/, ""),
					});
				} catch {
					/* skip */
				}
			}
		}
	}

	return personas;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestConfigDir(cwd: string, subdir: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, subdir);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Load "modular" package agents: frontmatter from
 * `agent-templates/pi/frontmatters/<name>.yaml` (pi schema), body verbatim
 * from `professions/<name>.md` (shared with the kiro/opencode generation).
 * Keeps professions as the single source of truth, personas separate, and
 * requires no generated agent files.
 */
function loadTemplateAgents(): AgentConfig[] {
	const root = getPackageRoot();
	if (!root) return [];
	const tplDir = path.join(root, "agent-templates", "pi", "frontmatters");
	if (!isDirectory(tplDir)) return [];

	const out: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(tplDir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
		const name = entry.name.replace(/\.yaml$/, "");
		const profPath = path.join(root, "professions", `${name}.md`);
		if (!fs.existsSync(profPath)) continue;

		let yamlText: string;
		let body: string;
		try {
			yamlText = fs.readFileSync(path.join(tplDir, entry.name), "utf-8");
			body = fs.readFileSync(profPath, "utf-8");
		} catch {
			continue;
		}

		// parseFrontmatter is a real YAML parser; wrapping the bare YAML in
		// frontmatter delimiters lets us reuse it without a new dependency.
		// The \n before the closing delimiter guards against files without a
		// trailing newline gluing the last rule onto the `---` line.
		const { frontmatter } = parseFrontmatter<AgentFrontmatter>(`---\n${yamlText}\n---\n`);
		if (typeof frontmatter.description !== "string") continue;

		out.push({
			name: (typeof frontmatter.name === "string" && frontmatter.name) || name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			persona: typeof frontmatter.persona === "string" ? frontmatter.persona : undefined,
			skills: parseStringList(frontmatter.skills),
			alwaysLoad: parseStringList(frontmatter.alwaysLoad),
			resources: parseStringList(frontmatter.resources),
			permissions: parsePermissionConfig(frontmatter.permissions),
			// Same semantics as loadAgentsFromDir: only boolean `false` (or the
			// quoted "false" string) disables spawning; absent/anything else keeps
			// the agent spawnable.
			spawnable: !(frontmatter.spawnable === false || frontmatter.spawnable === "false"),
			systemPrompt: body,
			source: "package",
			filePath: path.join(tplDir, entry.name),
		});
	}
	return out;
}

function mergeByName(list: AgentConfig[]): AgentConfig[] {
	const m = new Map<string, AgentConfig>();
	for (const a of list) m.set(a.name, a);
	return Array.from(m.values());
}

/** Package root when this extension is loaded from a pi package (git/local install). */
export function getPackageRoot(): string | null {
	const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	if (!isDirectory(candidate)) return null;
	// Only treat it as a package root when it contains agents/ or personas/,
	// so plain copies under ~/.pi/agent/extensions fall back to user dirs.
	if (isDirectory(path.join(candidate, "agents")) || isDirectory(path.join(candidate, "personas"))) {
		return candidate;
	}
	return null;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestConfigDir(cwd, "agents");
	const packageRoot = getPackageRoot();

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	// A pi package installed at user level is user-scoped: visible in "user" and "both".
	// Modular compose: template + profession beats no source; a monolithic
	// override in `agents/<name>.md` wins over the composed template.
	const packageAgents =
		packageRoot && scope !== "project"
			? mergeByName([
					...loadTemplateAgents(),
					...loadAgentsFromDir(path.join(packageRoot, "agents"), "package"),
				])
			: [];

	const userPersonas = loadPersonasFromDir(path.join(getAgentDir(), "personas"));
	const projectPersonasDir = findNearestConfigDir(cwd, "personas");
	const projectPersonas = projectPersonasDir ? loadPersonasFromDir(projectPersonasDir) : [];
	const packagePersonas = packageRoot ? loadPersonasFromDir(path.join(packageRoot, "personas")) : [];

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const agent of [...packageAgents, ...userAgents]) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent); // project wins
	} else if (scope === "user") {
		for (const agent of [...packageAgents, ...userAgents]) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	const personaMap = new Map<string, PersonaConfig>();
	for (const p of [...userPersonas, ...projectPersonas, ...packagePersonas]) {
		personaMap.set(personaId(p), p);
	}

	return {
		agents: Array.from(agentMap.values()),
		personas: Array.from(personaMap.values()),
		projectAgentsDir,
	};
}

export function personaId(p: PersonaConfig): string {
	return p.theme ? `${p.theme}/${p.name}` : p.name;
}

export function formatPersonaId(p: PersonaConfig): string {
	return p.theme ? `${p.theme}/${p.name}` : p.name;
}


// ---------------------------------------------------------------------------
// agents.json theme ↔ profession ↔ persona mapping
//   {"goblin": {"orchestrator": {"personaFile": "bossnik-chief.md", ...}, ...}}
// ---------------------------------------------------------------------------

interface AgentsJsonShape {
	[theme: string]: {
		[profession: string]: { personaFile?: unknown } | undefined;
	} | undefined;
}

let agentsJsonMap: Map<string, Map<string, string>> | null | undefined;

function loadAgentsJson(): Map<string, Map<string, string>> | null {
	if (agentsJsonMap !== undefined) return agentsJsonMap;
	agentsJsonMap = null;
	const root = getPackageRoot();
	if (!root) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf-8")) as AgentsJsonShape;
		const outer = new Map<string, Map<string, string>>();
		for (const [theme, professions] of Object.entries(raw)) {
			const inner = new Map<string, string>();
			for (const [profession, info] of Object.entries(professions ?? {})) {
				if (typeof info?.personaFile === "string") {
					inner.set(profession, info.personaFile.replace(/\.md$/, ""));
				}
			}
			if (inner.size > 0) outer.set(theme, inner);
		}
		agentsJsonMap = outer;
	} catch {
		agentsJsonMap = null;
	}
	return agentsJsonMap;
}

/** The persona agents.json assigns to a (theme, profession) pair, if it exists. */
export function personaForThemeProfession(
	theme: string,
	profession: string,
	personas: PersonaConfig[],
): PersonaConfig | null {
	const stem = loadAgentsJson()?.get(theme)?.get(profession);
	if (!stem) return null;
	return (
		personas.find((p) => p.theme === theme && (p.name === stem || p.fileNameStem === stem)) ??
		personas.find((p) => p.theme === theme && p.fileNameStem === stem) ??
		null
	);
}

/**
 * Resolve an agent reference that may be a "theme-profession" alias from the
 * kiro/opencode ecosystem (e.g. "goblin-mascot" -> mascot agent + goblin theme).
 */
export function resolveAgentAlias(
	alias: string,
	agents: AgentConfig[],
	personas: PersonaConfig[],
): { agent: AgentConfig; theme?: string } | null {
	const direct = agents.find((a) => a.name === alias);
	if (direct) return { agent: direct };

	const dash = alias.indexOf("-");
	if (dash > 0 && dash < alias.length - 1) {
		const theme = alias.slice(0, dash);
		const profession = alias.slice(dash + 1);
		const isTheme = personas.some((p) => p.theme === theme) || loadAgentsJson()?.has(theme);
		if (isTheme) {
			const agent = agents.find((a) => a.name === profession);
			if (agent) return { agent, theme };
		}
	}
	return null;
}

/**
 * Match a persona reference against a persona list, theme-aware.
 *
 * Priority:
 *   1. explicit "theme/name" (name or filename stem)
 *   2. bare persona name
 *   3. type personas.json mapping for (ref=theme, agentName=profession)
 *   4. fallback: first persona in the theme
 */
export function resolvePersonaForAgent(
	personas: PersonaConfig[],
	ref: string | undefined,
	agentName?: string,
): PersonaConfig | null {
	if (!ref || ref === "none" || ref === "off") return null;

	if (ref.includes("/")) {
		const [theme, name] = ref.split("/", 2);
		for (const p of personas) {
			if (p.theme === theme && (p.name === name || p.fileNameStem === name)) return p;
		}
		return null;
	}

	for (const p of personas) {
		if (p.name === ref) return p;
	}

	if (agentName) {
		const mapped = personaForThemeProfession(ref, agentName, personas);
		if (mapped) return mapped;
	}

	for (const p of personas) {
		if (p.theme === ref) return p;
	}
	return null;
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillRef {
	name: string;
	/** Group/owner folder, when the skill lives at skills/<group>/<name>/SKILL.md. */
	group?: string;
	path: string;
	body: string;
	description?: string;
}

function readSkillFile(filePath: string, group: string | undefined, name: string): SkillRef | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
		return {
			name: (typeof frontmatter.name === "string" && frontmatter.name) || name,
			group,
			path: filePath,
			body,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Discover skills from the package (skills/<group>/<name>/SKILL.md or
 * skills/<name>/SKILL.md), the agent dir (~/.pi/agent/skills/<name>/SKILL.md),
 * and the nearest project (.pi/skills/<name>/SKILL.md).
 */
export function discoverSkills(cwd?: string): SkillRef[] {
	const found = new Map<string, SkillRef>();
	const add = (s: SkillRef | null) => {
		if (s) found.set(s.group ? `${s.group}/${s.name}` : s.name, s);
	};

	const packageRoot = getPackageRoot();
	if (packageRoot) {
		const skillsRoot = path.join(packageRoot, "skills");
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const groupDir = path.join(skillsRoot, entry.name);
				// Two-level: skills/<group>/<skill>/SKILL.md (repo layout)
				let children: fs.Dirent[] = [];
				try {
					children = fs.readdirSync(groupDir, { withFileTypes: true });
				} catch {
					children = [];
				}
				if (children.some((c) => c.isFile() && c.name === "SKILL.md")) {
					// One-level: skills/<skill>/SKILL.md
					add(readSkillFile(path.join(groupDir, "SKILL.md"), undefined, entry.name));
				} else {
					for (const child of children) {
						if (child.isDirectory())
							add(readSkillFile(path.join(groupDir, child.name, "SKILL.md"), entry.name, child.name));
					}
				}
			}
		}
	}

	const userSkills = path.join(getAgentDir(), "skills");
	try {
		for (const entry of fs.readdirSync(userSkills, { withFileTypes: true })) {
			if (entry.isDirectory())
				add(readSkillFile(path.join(userSkills, entry.name, "SKILL.md"), undefined, entry.name));
		}
	} catch {
		/* no user skills */
	}

	const projectSkills = cwd ? findNearestConfigDir(cwd, "skills") : null;
	if (projectSkills) {
		try {
			for (const entry of fs.readdirSync(projectSkills, { withFileTypes: true })) {
				if (entry.isDirectory())
					add(readSkillFile(path.join(projectSkills, entry.name, "SKILL.md"), undefined, entry.name));
			}
		} catch {
			/* no project skills */
		}
	}

	return Array.from(found.values());
}

/** Convert a frontmatter glob to RegExp. A double-star slash means any depth (incl. none); a single star is one path segment; a question mark is one char. */
function globToRegExp(pattern: string): RegExp {
	const parts: string[] = [];
	for (let i = 0; i < pattern.length; ) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*" && pattern[i + 2] === "/") {
				parts.push("(?:.*/)?");
				i += 3;
			} else if (pattern[i + 1] === "*") {
				parts.push(".*");
				i += 2;
			} else {
				parts.push("[^/]*");
				i += 1;
			}
		} else if (ch === "?") {
			parts.push("[^/]");
			i += 1;
		} else if ("\\^$.*+()[]{}|".includes(ch)) {
			parts.push("\\" + ch);
			i += 1;
		} else {
			parts.push(ch);
			i += 1;
		}
	}
	return new RegExp(`^${parts.join("")}$`);
}

/**
 * Match frontmatter `skills:` patterns against discovered skills.
 * A pattern like "orchestrator/*" matches every skill under the orchestrator
 * group; a bare name or glob matches any skill with that name/group either way.
 */
export function matchSkills(patterns: string[] | undefined, skills: SkillRef[]): SkillRef[] {
	if (!patterns || patterns.length === 0) return [];
	const out: SkillRef[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		const re = globToRegExp(pattern.trim());
		for (const s of skills) {
			const ids = [s.name, s.group ? `${s.group}/${s.name}` : s.name];
			const key = s.group ? `${s.group}/${s.name}` : s.name;
			if (!seen.has(key) && ids.some((id) => re.test(id))) {
				seen.add(key);
				out.push(s);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Resources (file globs attached to the agent context)
// ---------------------------------------------------------------------------

export interface ResourcesResult {
	/** File contents inlined into the prompt (small files). */
	inlined: { path: string; content: string }[];
	/** Larger matched files; only paths are listed so the agent can read them. */
	paths: string[];
}

const RESOURCE_SKIP_DIRS = new Set([".git", "node_modules", ".pi", ".venv", "dist", "build", ".cache"]);

// Tunable resource budgets, not yet settings-backed.
const MAX_INLINE_BYTES_PER_FILE = 4096;
const MAX_TOTAL_RESOURCE_BYTES = 32768;
const MAX_RESOURCE_DIR_DEPTH = 8;

function walkFiles(dir: string, relPrefix: string, depth: number, out: string[]): void {
	if (depth > MAX_RESOURCE_DIR_DEPTH) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (RESOURCE_SKIP_DIRS.has(entry.name)) continue;
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(abs, rel, depth + 1, out);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			out.push(rel);
		}
	}
}

/** Expand "!exclusion" patterns (same convention as pi package manifests). */
function expandsTo(patterns: string[]): { include: RegExp[]; exclude: RegExp[] } {
	const include: RegExp[] = [];
	const exclude: RegExp[] = [];
	for (const raw of patterns) {
		const p = raw.trim();
		if (!p) continue;
		if (p.startsWith("!")) {
			exclude.push(globToRegExp(p.slice(1)));
		} else {
			include.push(globToRegExp(p));
		}
	}
	return { include, exclude };
}

/**
 * Resolve frontmatter `resources:` globs relative to cwd. Matched files are
 * inlined when under maxInlineBytesPerFile; larger files are listed as paths.
 */
export function resolveResources(
	patterns: string[] | undefined,
	cwd: string,
	maxInlineBytesPerFile = MAX_INLINE_BYTES_PER_FILE,
	maxTotalBytes = MAX_TOTAL_RESOURCE_BYTES,
): ResourcesResult {
	const result: ResourcesResult = { inlined: [], paths: [] };
	if (!patterns || patterns.length === 0 || !isDirectory(cwd)) return result;

	const all: string[] = [];
	walkFiles(cwd, "", 0, all);
	const { include, exclude } = expandsTo(patterns);

	let total = 0;
	for (const rel of all) {
		const posix = rel.split(path.sep).join("/");
		if (exclude.some((re) => re.test(posix))) continue;
		if (!include.some((re) => re.test(posix))) continue;

		if (total >= maxTotalBytes) {
			result.paths.push(rel);
			continue;
		}
		try {
			const stat = fs.statSync(path.join(cwd, rel));
			if (stat.size <= maxInlineBytesPerFile) {
				const content = fs.readFileSync(path.join(cwd, rel), "utf-8");
				if (total + content.length <= maxTotalBytes) {
					total += content.length;
					result.inlined.push({ path: rel, content });
				} else {
					result.paths.push(rel);
				}
			} else {
				result.paths.push(rel);
			}
		} catch {
			result.paths.push(rel);
		}
	}
	return result;
}