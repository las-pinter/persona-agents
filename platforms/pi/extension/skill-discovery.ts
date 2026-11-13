/**
 * Skill discovery for the persona-agents pi package.
 *
 * Sources (all optional, merged by name):
 *   - package: content/skills/<group>/<name>/SKILL.md, or content/skills/<name>/SKILL.md
 *   - user:    ~/.pi/agent/skills/<name>/SKILL.md
 *   - project: nearest .pi/skills/<name>/SKILL.md
 *
 * Skill files: markdown with YAML frontmatter. `disable-model-invocation: true`
 * marks a skill the user starts through its command only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { findNearestConfigDir, globToRegExp } from "./path-glob.ts";
import { getPackageRoot, PACKAGE_LAYOUT } from "./package-layout.ts";

export interface SkillRef {
	name: string;
	/** Group/owner folder, when the skill lives at skills/<group>/<name>/SKILL.md. */
	group?: string;
	path: string;
	body: string;
	description?: string;
	/** `disable-model-invocation: true`: only the user starts the skill, through its command. */
	userInvokedOnly?: boolean;
}

function readSkillFile(filePath: string, group: string | undefined, name: string): SkillRef | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<{
			name?: unknown;
			description?: unknown;
			"disable-model-invocation"?: unknown;
		}>(content);
		return {
			name: (typeof frontmatter.name === "string" && frontmatter.name) || name,
			group,
			path: filePath,
			body,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
			userInvokedOnly: frontmatter["disable-model-invocation"] === true,
		};
	} catch {
		return null;
	}
}

/**
 * Discover skills from the package (content/skills/<group>/<name>/SKILL.md or
 * content/skills/<name>/SKILL.md), the agent dir (~/.pi/agent/skills/<name>/SKILL.md),
 * and the nearest project (.pi/skills/<name>/SKILL.md).
 */
export function discoverSkills(cwd?: string): SkillRef[] {
	const found = new Map<string, SkillRef>();
	const add = (s: SkillRef | null) => {
		if (s) found.set(s.group ? `${s.group}/${s.name}` : s.name, s);
	};

	const packageRoot = getPackageRoot();
	if (packageRoot) {
		const skillsRoot = path.join(packageRoot, PACKAGE_LAYOUT.skills);
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

/**
 * Absolute real path to a skill's `scripts/` directory, or null when the skill
 * ships none. The realpath defeats a symlinked `scripts/` escaping the skill.
 */
export function skillScriptsDir(skill: SkillRef): string | null {
	const dir = path.join(path.dirname(skill.path), "scripts");
	try {
		if (!fs.statSync(dir).isDirectory()) return null;
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

/**
 * Real `scripts/` directories for the given skills, deduped. This is the
 * allow-list the gate uses: a script may run only when it lives inside one of
 * these directories.
 */
export function skillScriptsDirs(skills: SkillRef[]): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	for (const skill of skills) {
		const dir = skillScriptsDir(skill);
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		dirs.push(dir);
	}
	return dirs;
}
