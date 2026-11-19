/**
 * The Pi permission policy (platforms/pi/scripts/policy.ts).
 *
 * The gate is the whole permission system on Pi: Pi itself asks nothing before
 * a tool call. These tests pin the four layers in order — floor, policy-file
 * rule, session grant, doctrine — and the read-only contract of the reviewer.
 *
 * Run: node --experimental-strip-types --test tests/pi-policy.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addRule,
	appendDecision,
	decidePolicy,
	decisionRecord,
	describeRules,
	initPolicyFile,
	isGatePath,
	isInside,
	isSecretPath,
	loadPolicy,
	parsePolicy,
	piAgentDir,
	suggestGrant,
	type PolicyEnv,
	type PolicyFileRef,
	type PolicyState,
} from "../platforms/pi/scripts/policy.ts";
import { PROFILES } from "../platforms/pi/scripts/profile.ts";

const companion = PROFILES.companion;
const reviewer = PROFILES.reviewer;

/** A temp project + home + Pi agent dir, cleaned up by the caller. */
function sandbox(): { root: string; env: PolicyEnv; refs: PolicyFileRef[]; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-agents-pi-"));
	const env: PolicyEnv = {
		cwd: path.join(root, "project"),
		home: path.join(root, "home"),
		notesDir: path.join(root, "home", "agent-notes", "project-notes", "common"),
		piAgentDir: path.join(root, "pi-agent"),
	};
	fs.mkdirSync(env.cwd, { recursive: true });
	fs.mkdirSync(env.notesDir, { recursive: true });
	const refs: PolicyFileRef[] = [
		{ path: path.join(env.piAgentDir, "persona-agents", "policy.json"), scope: "user" },
		{ path: path.join(env.cwd, ".pi", "persona-agents", "policy.json"), scope: "project" },
	];
	env.policyFiles = refs.map((ref) => ref.path);
	return { root, env, refs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** The decision for one shell command. */
function bash(profile = companion, command: string, state?: PolicyState, env?: PolicyEnv): string {
	const box = env ? { env, cleanup: () => {} } : sandbox();
	try {
		const policy = state ?? { rules: [], errors: [], grants: [] };
		return decidePolicy(profile, "bash", { command }, policy, box.env).verdict;
	} finally {
		box.cleanup();
	}
}

/** A policy state from file bodies, written into the sandbox. */
function stateFrom(bodies: { user?: unknown; project?: unknown }, profile = companion): { state: PolicyState; box: ReturnType<typeof sandbox> } {
	const box = sandbox();
	if (bodies.project !== undefined) {
		fs.mkdirSync(path.dirname(box.refs[1].path), { recursive: true });
		fs.writeFileSync(box.refs[1].path, typeof bodies.project === "string" ? bodies.project : JSON.stringify(bodies.project));
	}
	if (bodies.user !== undefined) {
		fs.mkdirSync(path.dirname(box.refs[0].path), { recursive: true });
		fs.writeFileSync(box.refs[0].path, typeof bodies.user === "string" ? bodies.user : JSON.stringify(bodies.user));
	}
	return { state: loadPolicy(box.refs, profile.name), box };
}

const rule = (tool: string, match: string, verdict: "allow" | "ask" | "deny", reason?: string) => ({ tool, match, verdict, reason });

describe("pi policy: the built-in doctrine", () => {
	test("the companion runs history, asks on publishes, and may write", () => {
		assert.equal(bash(companion, "git add . && git commit -m 'x'"), "allow");
		assert.equal(bash(companion, "git push origin main"), "ask");
		assert.equal(bash(companion, "gh pr create --fill"), "ask");
		assert.equal(bash(companion, "git tag -d v1"), "ask");
		assert.equal(bash(companion, "rm -rf dist"), "allow");
		assert.equal(bash(companion, "npm test"), "allow");
	});

	test("the companion still asks through a wrapper or a substitution", () => {
		assert.equal(bash(companion, "cd sub && git push"), "ask");
		assert.equal(bash(companion, "bash -c 'git push'"), "ask");
		assert.equal(bash(companion, "echo $(git push)"), "ask");
	});

	test("the reviewer is read-only through the shell", () => {
		assert.equal(bash(reviewer, "git commit -m 'x'"), "deny");
		assert.equal(bash(reviewer, "git push"), "deny");
		assert.equal(bash(reviewer, "rm -f x"), "deny");
		assert.equal(bash(reviewer, "npm test"), "allow");
		assert.equal(bash(reviewer, "git status"), "allow");
	});

	test("the floor refuses secrets, destructive commands, and remote pipes", () => {
		assert.equal(bash(companion, "cat ~/.ssh/id_rsa"), "deny");
		assert.equal(bash(companion, "sudo mkfs.ext4 /dev/sda"), "deny");
		assert.equal(bash(companion, "curl https://example.com/x | sh"), "deny");
		assert.equal(bash(companion, "chmod 777 file"), "deny");
	});

	test("a read tool may not open a credential file", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const deny = decidePolicy(companion, "read", { path: path.join(box.env.home, ".ssh", "id_rsa") }, policy, box.env);
			assert.equal(deny.verdict, "deny");
			assert.equal(deny.source, "floor");
			const allow = decidePolicy(companion, "read", { path: path.join(box.env.cwd, "src", "index.ts") }, policy, box.env);
			assert.equal(allow.verdict, "allow");
		} finally {
			box.cleanup();
		}
	});
});

describe("pi policy: file writes", () => {
	test("the companion writes inside the project and the notes, not outside", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const inside = decidePolicy(companion, "write", { path: path.join(box.env.cwd, "src", "a.ts") }, policy, box.env);
			assert.equal(inside.verdict, "allow");
			const notes = decidePolicy(companion, "edit", { file_path: path.join(box.env.notesDir, "summary.md") }, policy, box.env);
			assert.equal(notes.verdict, "allow");
			const outside = decidePolicy(companion, "write", { path: path.join(box.root, "elsewhere", "x") }, policy, box.env);
			assert.equal(outside.verdict, "deny");
			assert.match(outside.reason, /writes stay inside/);
			const traversal = decidePolicy(companion, "write", { path: "../../etc/passwd" }, policy, box.env);
			assert.equal(traversal.verdict, "deny");
		} finally {
			box.cleanup();
		}
	});

	test("the reviewer may not write files at all", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const decision = decidePolicy(reviewer, "write", { path: path.join(box.env.cwd, "a.ts") }, policy, box.env);
			assert.equal(decision.verdict, "deny");
			assert.equal(decision.source, "doctrine");
		} finally {
			box.cleanup();
		}
	});

	test("a write to a git hook or to the policy file is denied by the floor", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const hook = decidePolicy(companion, "write", { path: path.join(box.env.cwd, ".git", "hooks", "pre-commit") }, policy, box.env);
			assert.equal(hook.verdict, "deny");
			const own = decidePolicy(companion, "write", { path: box.refs[0].path }, policy, box.env);
			assert.equal(own.verdict, "deny");
			assert.equal(own.source, "floor");
		} finally {
			box.cleanup();
		}
	});
});

describe("pi policy: your rules override the doctrine", () => {
	test("a project allow beats the doctrine ask", () => {
		const { state, box } = stateFrom({ project: { profiles: { companion: { rules: [rule("bash", "^git push", "allow")] } } } });
		try {
			assert.equal(bash(companion, "git push origin main", state, box.env), "allow");
			assert.equal(bash(companion, "git push --force", state, box.env), "allow");
			assert.equal(bash(companion, "gh pr create", state, box.env), "ask");
		} finally {
			box.cleanup();
		}
	});

	test("a user ask beats the doctrine allow", () => {
		const { state, box } = stateFrom({ user: { profiles: { companion: { rules: [rule("bash", "git commit", "ask", "you review each commit")] } } } });
		try {
			const decision = decidePolicy(companion, "bash", { command: "git commit -m x" }, state, box.env);
			assert.equal(decision.verdict, "ask");
			assert.equal(decision.source, "user");
			assert.match(decision.reason, /you review each commit/);
		} finally {
			box.cleanup();
		}
	});

	test("project rules are evaluated before user rules", () => {
		const { state, box } = stateFrom({
			project: { profiles: { companion: { rules: [rule("bash", "^npm", "deny")] } } },
			user: { profiles: { companion: { rules: [rule("bash", "^npm", "allow")] } } },
		});
		try {
			assert.equal(bash(companion, "npm test", state, box.env), "deny");
		} finally {
			box.cleanup();
		}
	});

	test("a rule sees the unwrapped segments, and a wildcard tool matches every tool", () => {
		const { state, box } = stateFrom({ user: { profiles: { companion: { rules: [rule("bash", "^git push", "allow"), rule("*", "README", "deny")] } } } });
		try {
			assert.equal(bash(companion, "cd packages/api && git push", state, box.env), "allow");
			const readme = decidePolicy(companion, "write", { path: path.join(box.env.cwd, "README.md") }, state, box.env);
			assert.equal(readme.verdict, "deny");
		} finally {
			box.cleanup();
		}
	});

	test("a session grant is the narrowest layer", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [{ tool: "bash", match: "^git\\s+push\\b" }] };
			assert.equal(bash(companion, "git push origin main", policy, box.env), "allow");
			const decision = decidePolicy(companion, "bash", { command: "git push" }, policy, box.env);
			assert.equal(decision.source, "session");
		} finally {
			box.cleanup();
		}
	});

	test("a deny rule stops a write the doctrine would allow", () => {
		const { state, box } = stateFrom({ user: { profiles: { companion: { rules: [rule("*", "secrets", "deny", "never touch the secrets folder")] } } } });
		try {
			const decision = decidePolicy(companion, "write", { path: path.join(box.env.cwd, "secrets", "a.txt") }, state, box.env);
			assert.equal(decision.verdict, "deny");
			assert.match(decision.reason, /never touch the secrets folder/);
		} finally {
			box.cleanup();
		}
	});
});

describe("pi policy: the floor fires on commands, not on words", () => {
	test("a commit message may say shutdown", () => {
		assert.equal(bash(companion, "git commit -m 'shutdown handler'"), "allow");
		assert.equal(bash(companion, "git commit -m 'fix reboot loop'"), "allow");
		assert.equal(bash(companion, "grep shutdown src/"), "allow");
	});

	test("a command floor still fires after a wrapper or an assignment", () => {
		assert.equal(bash(companion, "sudo mkfs.ext4 /dev/sda"), "deny");
		assert.equal(bash(companion, "env FOO=1 shutdown -h now"), "deny");
		assert.equal(bash(companion, "cd /tmp && chmod -R 777 ."), "deny");
	});

	test("a .env template is not a secret, a real .env is", () => {
		assert.equal(isSecretPath("/repo/.env.example"), false);
		assert.equal(isSecretPath("/repo/.env.sample"), false);
		assert.equal(isSecretPath("/repo/.env.template"), false);
		assert.equal(isSecretPath("/repo/.env"), true);
		assert.equal(isSecretPath("/repo/.env.local"), true);
		assert.equal(isSecretPath("/home/me/.ssh/id_rsa"), true);
		assert.equal(bash(companion, "git add .env.example"), "allow");
		assert.equal(bash(companion, "cat .env"), "deny");
	});
});

describe("pi policy: shell writes obey the place rule", () => {
	test("a redirect outside the project is denied, one inside is allowed", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const home = decidePolicy(companion, "bash", { command: "echo x > ~/.bashrc" }, policy, box.env);
			assert.equal(home.verdict, "deny");
			assert.match(home.reason, /shell writes stay inside/);
			const inside = decidePolicy(companion, "bash", { command: "npm test > out.log" }, policy, box.env);
			assert.equal(inside.verdict, "allow");
			const notes = decidePolicy(companion, "bash", { command: `echo x > ${path.join(box.env.notesDir, "log.txt")}` }, policy, box.env);
			assert.equal(notes.verdict, "allow");
			const devNull = decidePolicy(companion, "bash", { command: "npm test > /dev/null 2>&1" }, policy, box.env);
			assert.equal(devNull.verdict, "allow");
		} finally {
			box.cleanup();
		}
	});

	test("a redirect into the gate's own files is denied by the floor", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const ownPolicy = decidePolicy(companion, "bash", { command: `echo '{}' > ${box.refs[0].path}` }, policy, box.env);
			assert.equal(ownPolicy.verdict, "deny");
			assert.equal(ownPolicy.source, "floor");
			const extension = decidePolicy(
				companion,
				"bash",
				{ command: `echo x > ${path.join(box.env.piAgentDir, "extensions", "evil.ts")}` },
				policy,
				box.env,
			);
			assert.equal(extension.verdict, "deny");
			assert.equal(extension.source, "floor");
			const hook = decidePolicy(companion, "bash", { command: `echo x > ${path.join(box.env.cwd, ".git", "hooks", "pre-commit")}` }, policy, box.env);
			assert.equal(hook.verdict, "deny");
		} finally {
			box.cleanup();
		}
	});

	test("the gate path test covers the policy, the extensions, and the settings", () => {
		const box = sandbox();
		try {
			assert.equal(isGatePath(box.refs[0].path, box.env), true);
			assert.equal(isGatePath(path.join(box.env.piAgentDir, "extensions", "x.ts"), box.env), true);
			assert.equal(isGatePath(path.join(box.env.piAgentDir, "settings.json"), box.env), true);
			assert.equal(isGatePath(path.join(box.env.cwd, "src", "a.ts"), box.env), false);
		} finally {
			box.cleanup();
		}
	});
});

describe("pi policy: fail closed", () => {
	test("a malformed policy file denies rather than widening", () => {
		const { state, box } = stateFrom({ user: "{ not json" });
		try {
			assert.equal(state.errors.length, 1);
			for (const command of ["git status", "npm test", "git push"]) {
				const decision = decidePolicy(companion, "bash", { command }, state, box.env);
				assert.equal(decision.verdict, "deny");
				assert.match(decision.reason, /fails closed/);
			}
			assert.equal(decidePolicy(companion, "read", { path: "a.ts" }, state, box.env).verdict, "deny");
		} finally {
			box.cleanup();
		}
	});

	test("an invalid regular expression refuses the file", () => {
		const { state, box } = stateFrom({ user: { profiles: { companion: { rules: [rule("bash", "(" , "allow")] } } } });
		try {
			assert.equal(state.errors.length, 1);
			assert.match(state.errors[0].message, /not a valid regular expression/);
		} finally {
			box.cleanup();
		}
	});

	test("bad shapes are rejected with the file and the entry named", () => {
		const file = "policy.json";
		const cases: [string, RegExp][] = [
			["[]", /must hold an object/],
			['{"profiles": []}', /"profiles" must hold an object/],
			['{"profiles": {"companion": {"rules": {}}}}', /rules must hold an array/],
			['{"profiles": {"companion": {"rules": [{"match": "x"}]}}}', /tool must be a tool name/],
			['{"profiles": {"companion": {"rules": [{"tool": "bash"}]}}}', /match must be a regular expression/],
			['{"profiles": {"companion": {"rules": [{"tool": "bash", "match": "x", "verdict": "maybe"}]}}}', /verdict must be/],
			['{"profiles": {"companion": {"rules": [{"tool": "bash", "match": "x", "verdict": "allow", "reason": 7}]}}}', /reason must be a string/],
		];
		for (const [body, expected] of cases) {
			assert.throws(() => parsePolicy(body, file), expected);
		}
	});
});

describe("pi policy: editing and reporting", () => {
	test("addRule round-trips through loadPolicy and keeps other rules", () => {
		const box = sandbox();
		try {
			const ref = box.refs[0];
			initPolicyFile(ref);
			addRule(ref, "companion", rule("bash", "^npm publish", "ask", "releases are the owner's call"));
			addRule(ref, "companion", rule("bash", "^npm test", "allow"));
			const state = loadPolicy(box.refs, "companion");
			assert.equal(state.errors.length, 0);
			assert.equal(state.rules.length, 2);
			assert.equal(bash(companion, "npm publish", state, box.env), "ask");
			assert.equal(bash(companion, "npm test", state, box.env), "allow");
		} finally {
			box.cleanup();
		}
	});

	test("the report names each rule, its verdict, and where it lives", () => {
		const { state, box } = stateFrom({ user: { profiles: { companion: { rules: [rule("bash", "^git push", "ask", "pushes need a look")] } } } });
		try {
			const lines = describeRules(state).join("\n");
			assert.match(lines, /ask bash \/\^git push\/ — pushes need a look/);
			assert.match(lines, new RegExp(`\\[user, line 1\\]`));
			assert.match(describeRules({ rules: [], errors: [], grants: [] }).join("\n"), /built-in doctrine decides/);
		} finally {
			box.cleanup();
		}
	});

	test("a suggested grant narrows a publish to its verb and anchors anything else", () => {
		const box = sandbox();
		try {
			const push = suggestGrant("bash", { command: "cd api && git push --force origin main" }, box.env);
			assert.equal(push.match, "^git\\s+push\\b");
			assert.equal(push.matched, "git push --force origin main");
			const rm = suggestGrant("bash", { command: "rm -f x" }, box.env);
			assert.equal(rm.match, "^rm -f x$");
			const write = suggestGrant("write", { path: path.join(box.env.cwd, "a.ts") }, box.env);
			assert.ok(write.matched.endsWith("a.ts"), write.matched);
			assert.equal(write.match, `^${write.matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
		} finally {
			box.cleanup();
		}
	});

	test("a decision record is one JSON line that names the source", () => {
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			const decision = decidePolicy(companion, "bash", { command: "git push" }, policy, box.env);
			const record = JSON.parse(decisionRecord(companion, "bash", { command: "git push" }, decision, { session: "s1" }));
			assert.equal(record.agent, "persona-agents:companion");
			assert.equal(record.verdict, "ask");
			assert.equal(record.source, "doctrine");
			assert.equal(record.session, "s1");
			const log = path.join(box.env.piAgentDir, "persona-agents", "decisions.ndjson");
			appendDecision(log, decisionRecord(companion, "bash", { command: "git push" }, decision));
			assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
		} finally {
			box.cleanup();
		}
	});

	test("paths are compared after resolving, so a sibling prefix is not inside", () => {
		const box = sandbox();
		try {
			assert.equal(isInside(path.join(box.env.cwd, "a", "b"), box.env.cwd), true);
			assert.equal(isInside(`${box.env.cwd}-other`, box.env.cwd), false);
		} finally {
			box.cleanup();
		}
	});

	test("the pi agent dir comes from PI_CODING_AGENT_DIR, else the home folder", () => {
		assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/x"), "/tmp/agent");
		assert.equal(piAgentDir({}, "/home/x"), "/home/x/.pi/agent");
	});

	test("the PI_CODING_AGENT marker is not a path", () => {
		// Pi sets PI_CODING_AGENT to the literal "true"; reading it as a path put
		// the log and the user policy under <cwd>/true/.
		assert.equal(piAgentDir({ PI_CODING_AGENT: "true" }, "/home/x"), "/home/x/.pi/agent");
		assert.equal(piAgentDir({ PI_CODING_AGENT: "true", PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/x"), "/tmp/agent");
	});
});

describe("pi policy: one gate for both platforms", () => {
	test("the shared parser is the one the Claude hook uses", () => {
		// A command that the doctrine matrix in claude-doctrine.test.ts pins down:
		// if the shared parser regresses, both suites fail together.
		const box = sandbox();
		try {
			const policy: PolicyState = { rules: [], errors: [], grants: [] };
			assert.equal(decidePolicy(companion, "bash", { command: "git commit -F - < msg.txt" }, policy, box.env).verdict, "allow");
			assert.equal(decidePolicy(companion, "bash", { command: "git -c core.pager=evil commit" }, policy, box.env).verdict, "ask");
		} finally {
			box.cleanup();
		}
	});

	test("the repository itself is a git worktree", () => {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
		assert.ok(root.length > 0);
	});
});
