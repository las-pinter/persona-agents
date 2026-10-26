/**
 * Permission regression harness for the Rust toolchain doctrine.
 *
 * Covers the allow sets, the forbidden install and publish forms, the fmt and
 * build boundary, and the cargo redirect fences on every stack.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { type Decision } from "../platforms/pi/extension/command-segments.ts";
import {
	KIRO_SHELL_AGENTS,
	OTHER_AGENTS,
	hasKiroDeny,
	hasOpenCodeRule,
	kiroStoredPattern,
	kiroVerdict,
	loadAgentRules,
	loadKiroConfig,
	loadOpenCodeRules,
	opencodeVerdict,
	ruleSetMatches,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// Rust toolchain permission doctrine.
// Each stack and agent must carry the intended allow entries, must never allow
// install/publish/rustup/config overrides, and must hold the fmt/build boundary.
// The existence checks are load-bearing: a missing rule fails here instead of
// passing on an engine default.
// ---------------------------------------------------------------------------

const RUST_AGENTS = ["implementer", "tester", "reviewer", "researcher"] as const;
type RustAgent = (typeof RUST_AGENTS)[number];

// Commands that must never be allowed on any stack. The --config form uses the
// prefix position: the pi allow anchor requires a cargo subcommand directly.
const RUST_FORBIDDEN_NEVER_ALLOWED = [
	"cargo install cargo-edit",
	"cargo publish",
	"rustup install stable",
	"rustup update",
	"cargo --config net.offline=true check",
];

// opencode shell resources that must exist verbatim, per agent.
const OPENCODE_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt *",
		"cargo doc *",
		"cargo build *",
		"cargo test *",
		"cargo nextest *",
		"cargo bench *",
		"cargo run *",
	],
	tester: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt --check *",
		"cargo doc *",
		"cargo build *",
		"cargo test *",
		"cargo nextest *",
		"cargo bench *",
	],
	reviewer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt --check *",
		"cargo doc *",
		"cargo test *",
		"cargo nextest *",
		"cargo deny check *",
	],
	researcher: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
	],
};

// kiro allowedCommands strings that must exist verbatim, per agent.
const KIRO_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt",
		"cargo fmt *",
		"cargo doc",
		"cargo doc *",
		"cargo build",
		"cargo build *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"cargo bench",
		"cargo bench *",
		"cargo run",
		"cargo run *",
		"rustc --version",
		"rustup show",
	],
	tester: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt --check",
		"cargo fmt --check *",
		"cargo doc",
		"cargo doc *",
		"cargo build",
		"cargo build *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"cargo bench",
		"cargo bench *",
		"rustc --version",
		"rustup show",
	],
	reviewer: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt --check",
		"cargo fmt --check *",
		"cargo doc",
		"cargo doc *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"cargo deny check",
		"cargo deny check *",
		"rustc --version",
		"rustup show",
	],
	researcher: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"rustc --version",
		"rustup show",
	],
};

// pi commands that must return `allow`, per agent. The pi frontmatter is
// deny-by-default, so a missing rule yields `default`, not `allow`.
const PI_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo build",
		"cargo test",
		"cargo nextest",
		"cargo bench",
		"cargo run",
		"cd /repo && cargo test",
	],
	tester: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo build",
		"cargo test",
		"cargo nextest",
		"cargo bench",
	],
	reviewer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo test",
		"cargo nextest",
		"cargo deny check",
		"cargo deny check --all-features",
	],
	researcher: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
	],
};

// A cargo allow that takes a trailing argument can carry an output redirect
// into a file. The broad `*cargo *>*` deny fences the whole cargo class on kiro
// and opencode. pi denies every redirect by default.
const WIDE_CARGO_REDIRECTS = [
	"cargo check 2>/tmp/err",
	"cargo clippy 2>/tmp/err",
	"cargo build 2>/tmp/err",
	"cargo test 2>/tmp/err",
	"cargo nextest 2>/tmp/err",
	"cargo run 2>/tmp/err",
	"cargo metadata 2>/tmp/err",
	"cargo tree 2>/tmp/err",
	"cargo locate-project 2>/tmp/err",
	"cargo deny check 2>/tmp/err",
];
const WIDE_CARGO_KIRO_OPENCODE_AGENTS = ["implementer", "tester", "reviewer", "researcher", "orchestrator"];
const WIDE_CARGO_PI_AGENTS = ["implementer", "tester", "reviewer", "orchestrator"];

// Engine residual: pi normalizes quotes and backslash escapes in its deny
// probes, so an obfuscated `--config` is still caught there. opencode and kiro
// are external engines that match literal text only; they deny the literal
// `--config` form, but an obfuscated `--config` is an ACCEPTED RESIDUAL there.

describe("rust toolchain permission doctrine", () => {
	test("pi: each agent allows its Rust read/build/test set", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of PI_RUST_ALLOWS[agent]) {
				assert.equal(verdict(agent, command), "allow", `pi ${agent}: ${command}`);
			}
		}
	});

	test("pi: each agent never allows install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.notEqual(verdict(agent, command), "allow", `pi ${agent}: ${command}`);
			}
		}
	});

	test("pi implementer: cargo add/remove/update ask the user", () => {
		for (const command of ["cargo add serde", "cargo remove serde", "cargo update serde", "cargo upgrade serde"]) {
			assert.equal(verdict("implementer", command), "ask", command);
		}
	});

	// A prefix or a flag before the subcommand escapes the anchored allow rule.
	// The config override must hit the deny rule; the rest fall to deny-by-default.
	test("pi implementer: config overrides and unanchored cargo forms never allow", () => {
		const cases: Array<{ command: string; kind: Decision["kind"] }> = [
			{ command: "cargo check --config net.offline=true", kind: "deny" },
			{ command: "cargo --config net.offline=true check", kind: "deny" },
			{ command: "cargo build --config net.offline=false", kind: "deny" },
			{ command: "cargo +nightly build", kind: "default" },
			{ command: "/usr/bin/cargo build", kind: "default" },
			{ command: "FOO=1 cargo build", kind: "default" },
		];
		for (const { command, kind } of cases) {
			assert.equal(verdict("implementer", command), kind, `pi implementer: ${command}`);
		}
	});

	// FINDING 1 regression: a quote or a backslash escape must not smuggle a
	// config override past the deny bridge. `"a;b"` hides a separator;
	// `--co"nfig"` splits the flag token; `--co\nfig` escapes the `n`.
	test("pi: quoted, split, and backslash-escaped flags cannot allow a config override", () => {
		const commands = [
			'cargo build --features "a;b" --config net.offline=true',
			'cargo build --co"nfig" x',
			"cargo build --co\\nfig x",
		];
		for (const agent of RUST_AGENTS) {
			for (const command of commands) {
				assert.equal(verdict(agent, command), "deny", `pi ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent carries the explicit Rust allow entries", () => {
		for (const agent of RUST_AGENTS) {
			for (const resource of OPENCODE_RUST_ALLOWS[agent]) {
				assert.ok(
					hasOpenCodeRule(agent, resource, "allow"),
					`opencode ${agent}: missing {shell, ${resource}, allow}`,
				);
			}
		}
	});

	test("opencode: the implementer carries both Rust skill allows", () => {
		const rules = loadOpenCodeRules("implementer");
		for (const skill of ["rust-quality-gates", "rust-implementation"]) {
			assert.ok(
				rules.some((rule) => rule.action === "skill" && rule.resource === skill && rule.effect === "allow"),
				`missing {skill, ${skill}, allow}`,
			);
		}
	});

	test("opencode: each agent behaves with its Rust allow set", () => {
		for (const agent of RUST_AGENTS) {
			for (const resource of OPENCODE_RUST_ALLOWS[agent]) {
				const command = resource.replace(/ \*$/, "");
				assert.equal(opencodeVerdict(agent, command), "allow", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent denies install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.equal(opencodeVerdict(agent, command), "deny", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent denies CARGO_HOME overrides", () => {
		for (const agent of RUST_AGENTS) {
			assert.ok(
				hasOpenCodeRule(agent, "*CARGO_HOME*", "deny"),
				`opencode ${agent}: missing {shell, *CARGO_HOME*, deny}`,
			);
			assert.equal(opencodeVerdict(agent, "CARGO_HOME=/tmp cargo build"), "deny", `opencode ${agent}: CARGO_HOME`);
		}
	});

	test("opencode: rustup show stays allowed and the mutating forms deny", () => {
		for (const agent of RUST_AGENTS) {
			assert.equal(opencodeVerdict(agent, "rustup show"), "allow", `opencode ${agent}: rustup show`);
			for (const command of [
				"rustup run stable cargo build",
				"rustup target add wasm32-unknown-unknown",
				"rustup override set nightly",
				"rustup set profile minimal",
				"rustup which cargo",
			]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("kiro: each agent carries the explicit Rust allow strings", () => {
		for (const agent of RUST_AGENTS) {
			const allowed = loadKiroConfig(agent).toolsSettings?.shell?.allowedCommands ?? [];
			for (const command of KIRO_RUST_ALLOWS[agent]) {
				assert.ok(
					allowed.includes(kiroStoredPattern(command)),
					`kiro ${agent}: missing allowedCommands ${command}`,
				);
				// Existence alone is not enough: a deny entry must not shadow the allow.
				// A trailing " *" is the wildcard form, so the bare command is the probe.
				const probe = command.replace(/ \*$/, "");
				assert.equal(kiroVerdict(agent, probe), "allow", `kiro ${agent}: ${probe}`);
			}
		}
	});

	test("kiro: rustup show stays allowed and the mutating forms deny", () => {
		for (const agent of RUST_AGENTS) {
			assert.equal(kiroVerdict(agent, "rustup show"), "allow", `kiro ${agent}: rustup show`);
			for (const command of [
				"rustup",
				"rustup install stable",
				"rustup run stable cargo build",
				"rustup target add wasm32-unknown-unknown",
				"rustup override set nightly",
				"rustup set profile minimal",
				"rustup which cargo",
			]) {
				assert.equal(kiroVerdict(agent, command), "deny", `kiro ${agent}: ${command}`);
			}
		}
	});

	test("kiro: each agent denies install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.equal(kiroVerdict(agent, command), "deny", `kiro ${agent}: ${command}`);
			}
		}
	});

	test("boundary: reviewer allows cargo fmt --check but not cargo fmt", () => {
		assert.equal(verdict("reviewer", "cargo fmt --check"), "allow", "pi reviewer fmt --check");
		assert.notEqual(verdict("reviewer", "cargo fmt"), "allow", "pi reviewer fmt");
		assert.ok(hasOpenCodeRule("reviewer", "cargo fmt --check *", "allow"), "opencode reviewer fmt --check allow");
		assert.equal(opencodeVerdict("reviewer", "cargo fmt --check"), "allow", "opencode reviewer fmt --check");
		assert.notEqual(opencodeVerdict("reviewer", "cargo fmt"), "allow", "opencode reviewer fmt");
		assert.equal(kiroVerdict("reviewer", "cargo fmt --check"), "allow", "kiro reviewer fmt --check");
		assert.notEqual(kiroVerdict("reviewer", "cargo fmt"), "allow", "kiro reviewer fmt");
	});

	// A `cargo deny check` allow must stay narrow. `cargo deny init` writes a
	// config file, so a widened `cargo deny *` rule would leak a mutation.
	test("boundary: reviewer allows cargo deny check but not cargo deny init", () => {
		const mutating = "cargo deny init";
		const kiroAllowed = loadKiroConfig("reviewer").toolsSettings?.shell?.allowedCommands ?? [];
		assert.notEqual(verdict("reviewer", mutating), "allow", "pi reviewer cargo deny init");
		assert.notEqual(opencodeVerdict("reviewer", mutating), "allow", "opencode reviewer cargo deny init");
		assert.ok(!hasOpenCodeRule("reviewer", "cargo deny *", "allow"), "opencode reviewer must not allow cargo deny *");
		assert.ok(!kiroAllowed.includes(mutating), "kiro reviewer must not allow cargo deny init");
		assert.notEqual(kiroVerdict("reviewer", mutating), "allow", "kiro reviewer cargo deny init");
	});

	// The redirect deny must beat the `cargo deny check` allow on every pi role,
	// so a digit-prefixed write (`2>/tmp/err`) still denies.
	test("pi: the redirect deny beats the cargo deny check allow on every role", () => {
		for (const agent of ["orchestrator", "implementer", ...OTHER_AGENTS]) {
			assert.equal(verdict(agent, "cargo deny check 2>/tmp/err"), "deny", `pi ${agent} redirect`);
			assert.equal(verdict(agent, "echo hi 2>out.txt"), "deny", `pi ${agent} digit redirect`);
		}
	});

	// kiro and opencode grant `cargo deny check`, but a redirect write must not
	// ride that allow. Their glob deny cannot express the pi fd-dup exception,
	// so they also deny an fd dup. The extra strictness is accepted.
	test("kiro and opencode: the redirect deny beats the cargo deny check allow", () => {
		for (const agent of ["reviewer", "tester", "orchestrator"]) {
			assert.equal(
				kiroVerdict(agent, "cargo deny check 2>/tmp/err"),
				"deny",
				`kiro ${agent}: file redirect`,
			);
			assert.equal(
				kiroVerdict(agent, "cargo deny check 2>&1"),
				"deny",
				`kiro ${agent}: fd dup over-deny`,
			);
			assert.equal(kiroVerdict(agent, "cargo deny check"), "allow", `kiro ${agent}: deny check`);
			assert.equal(
				kiroVerdict(agent, "cargo deny check --all-features"),
				"allow",
				`kiro ${agent}: deny check args`,
			);
			assert.equal(
				opencodeVerdict(agent, "cargo deny check 2>/tmp/err"),
				"deny",
				`opencode ${agent}: file redirect`,
			);
			assert.equal(
				opencodeVerdict(agent, "cargo deny check 2>&1"),
				"deny",
				`opencode ${agent}: fd dup over-deny`,
			);
			assert.equal(
				opencodeVerdict(agent, "cargo deny check"),
				"allow",
				`opencode ${agent}: deny check`,
			);
			assert.equal(
				opencodeVerdict(agent, "cargo deny check --all-features"),
				"allow",
				`opencode ${agent}: deny check args`,
			);
		}
	});

	// The cargo nextest allow takes an arbitrary argument, so a redirect write
	// must deny. Every role here carries the allow and its guard fence. Removing
	// any fence drops the verdict to allow and fails this test.
	test("kiro and opencode: the redirect deny beats the cargo nextest allow", () => {
		const fileRedirect = "cargo nextest 2>/tmp/err";
		const kiroNextestRoles = ["implementer", "tester", "reviewer", "orchestrator"];
		for (const agent of kiroNextestRoles) {
			assert.ok(hasKiroDeny(agent, "cargo nextest *>*"), `kiro ${agent}: missing fence`);
			assert.equal(kiroVerdict(agent, fileRedirect), "deny", `kiro ${agent}: file redirect`);
			assert.equal(kiroVerdict(agent, "cargo nextest 2>&1"), "deny", `kiro ${agent}: fd dup`);
			assert.equal(kiroVerdict(agent, "cargo nextest"), "allow", `kiro ${agent}: nextest`);
			assert.equal(kiroVerdict(agent, "cargo nextest run"), "allow", `kiro ${agent}: nextest run`);
		}
		// A kiro role without the allow must not allow the redirect either.
		for (const agent of KIRO_SHELL_AGENTS) {
			assert.notEqual(kiroVerdict(agent, fileRedirect), "allow", `kiro ${agent}: redirect`);
		}
		const opencodeNextestRoles = ["implementer", "tester", "reviewer", "orchestrator"];
		for (const agent of opencodeNextestRoles) {
			assert.ok(
				hasOpenCodeRule(agent, "cargo nextest *>*", "deny"),
				`opencode ${agent}: missing fence`,
			);
			assert.equal(opencodeVerdict(agent, fileRedirect), "deny", `opencode ${agent}: file redirect`);
			assert.equal(
				opencodeVerdict(agent, "cargo nextest 2>&1"),
				"deny",
				`opencode ${agent}: fd dup`,
			);
			assert.equal(opencodeVerdict(agent, "cargo nextest"), "allow", `opencode ${agent}: nextest`);
			assert.equal(
				opencodeVerdict(agent, "cargo nextest run"),
				"allow",
				`opencode ${agent}: nextest run`,
			);
		}
	});

	// The whole cargo class carries a leading-star deny. Any cargo redirect
	// denies on kiro and opencode. The entry check fails when a fence is removed.
	test("kiro and opencode: the whole cargo class denies an output redirect", () => {
		for (const agent of WIDE_CARGO_KIRO_OPENCODE_AGENTS) {
			assert.ok(hasKiroDeny(agent, "*cargo *>*"), `kiro ${agent}: missing fence`);
			assert.ok(hasOpenCodeRule(agent, "*cargo *>*", "deny"), `opencode ${agent}: missing fence`);
			for (const command of WIDE_CARGO_REDIRECTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `kiro ${agent}: ${command}`);
				assert.equal(opencodeVerdict(agent, command), "deny", `opencode ${agent}: ${command}`);
			}
		}
	});

	// The four pi cargo roles carry a redirect deny. An output redirect on a
	// wide cargo verb denies instead of riding the allow.
	test("pi: the four cargo roles deny an output redirect", () => {
		for (const agent of WIDE_CARGO_PI_AGENTS) {
			for (const command of WIDE_CARGO_REDIRECTS) {
				assert.equal(verdict(agent, command), "deny", `pi ${agent}: ${command}`);
			}
		}
	});

	// The redirect deny must cover the stream-join ampersand form as well as the
	// plain file-create forms. The fd-dup form stays allowed.
	const PI_REDIRECT_AGENTS = [
		"orchestrator",
		"implementer",
		"tester",
		"reviewer",
		"researcher",
		"planner",
		"mascot",
	];
	// A target that starts with a digit is a write, not a file-descriptor copy.
	const PI_REDIRECT_DENY = [
		"cat notes.txt > out.txt",
		"cat notes.txt >> out.txt",
		"cat notes.txt >& out.txt",
		"cat notes.txt >&out.txt",
		"cat notes.txt >1file",
		"cat notes.txt >>1file",
	];
	test("pi: every redirect role denies the file-create and ampersand forms", () => {
		for (const agent of PI_REDIRECT_AGENTS) {
			for (const command of PI_REDIRECT_DENY) {
				assert.equal(verdict(agent, command), "deny", `pi ${agent}: ${command}`);
			}
		}
		// The shell roles carry the read allow, so the fd-dup form reaches allow.
		for (const agent of PI_REDIRECT_AGENTS.filter((name) => name !== "mascot")) {
			assert.equal(verdict(agent, "cat notes.txt 2>&1"), "allow", `pi ${agent}: fd dup must stay allowed`);
		}
		// Mascot has no bash tool, so the fd-dup form falls to deny-by-default.
		assert.equal(verdict("mascot", "cat notes.txt 2>&1"), "default", "pi mascot: fd dup");
	});

	// The opencode write path on cat, echo, and printf had no coverage. The last
	// matching rule is the redirect ask.
	test("opencode implementer: cat, echo, and printf redirects ask", () => {
		for (const command of [
			"cat notes.txt > out.txt",
			"echo hello > out.txt",
			"printf hi > out.txt",
		]) {
			assert.equal(opencodeVerdict("implementer", command), "ask", command);
		}
	});

	test("boundary: tester allows cargo build, reviewer denies it", () => {
		assert.equal(verdict("tester", "cargo build"), "allow", "pi tester build");
		assert.notEqual(verdict("reviewer", "cargo build"), "allow", "pi reviewer build");
		assert.equal(opencodeVerdict("tester", "cargo build"), "allow", "opencode tester build");
		assert.equal(opencodeVerdict("reviewer", "cargo build"), "deny", "opencode reviewer build");
		assert.equal(kiroVerdict("tester", "cargo build"), "allow", "kiro tester build");
		assert.equal(kiroVerdict("reviewer", "cargo build"), "deny", "kiro reviewer build");
	});

	test("boundary: tester allows cargo fmt --check but not cargo fmt", () => {
		const { ruleSets } = loadAgentRules("tester");
		const kiroAllowed = loadKiroConfig("tester").toolsSettings?.shell?.allowedCommands ?? [];
		assert.ok(
			ruleSetMatches(ruleSets.agentAllow, "cargo fmt --check"),
			"pi tester: missing allow entry for cargo fmt --check",
		);
		assert.ok(
			kiroAllowed.includes("cargo fmt --check"),
			"kiro tester: missing allowedCommands cargo fmt --check",
		);
		assert.equal(verdict("tester", "cargo fmt --check"), "allow", "pi tester fmt --check");
		assert.notEqual(verdict("tester", "cargo fmt"), "allow", "pi tester fmt");
		assert.ok(hasOpenCodeRule("tester", "cargo fmt --check *", "allow"), "opencode tester fmt --check allow");
		assert.equal(opencodeVerdict("tester", "cargo fmt --check"), "allow", "opencode tester fmt --check");
		assert.notEqual(opencodeVerdict("tester", "cargo fmt"), "allow", "opencode tester fmt");
		assert.equal(kiroVerdict("tester", "cargo fmt --check"), "allow", "kiro tester fmt --check");
		assert.notEqual(kiroVerdict("tester", "cargo fmt"), "allow", "kiro tester fmt");
	});

	// The implementer, the tester, the reviewer, and the orchestrator may run
	// cargo nextest and the read-only cargo deny check. Assert the rule entry
	// itself exists on each engine: on kiro and opencode an unmatched command
	// would otherwise fall to ask.
	test("pi orchestrator: cargo nextest and cargo deny check allow entries exist", () => {
		const { ruleSets } = loadAgentRules("orchestrator");
		assert.ok(
			ruleSetMatches(ruleSets.agentAllow, "cargo nextest run"),
			"pi orchestrator must allow cargo nextest",
		);
		assert.ok(
			ruleSetMatches(ruleSets.agentAllow, "cargo deny check"),
			"pi orchestrator must allow cargo deny check",
		);
		assert.equal(verdict("orchestrator", "cargo nextest run"), "allow", "pi orchestrator nextest");
		assert.equal(verdict("orchestrator", "cargo deny check"), "allow", "pi orchestrator deny check");
	});

	test("pi tester: cargo deny check allow entry exists", () => {
		const { ruleSets } = loadAgentRules("tester");
		assert.ok(
			ruleSetMatches(ruleSets.agentAllow, "cargo deny check --all-features"),
			"pi tester must allow cargo deny check",
		);
		assert.equal(verdict("tester", "cargo deny check"), "allow", "pi tester deny check");
	});

	test("kiro orchestrator: cargo nextest and cargo deny check allowedCommands exist", () => {
		const allowed = loadKiroConfig("orchestrator").toolsSettings?.shell?.allowedCommands ?? [];
		for (const entry of ["cargo nextest", "cargo nextest *", "cargo deny check", "cargo deny check *"]) {
			assert.ok(allowed.includes(kiroStoredPattern(entry)), `missing allowedCommands ${entry}`);
		}
		assert.equal(kiroVerdict("orchestrator", "cargo nextest run"), "allow", "kiro orchestrator nextest");
		assert.equal(kiroVerdict("orchestrator", "cargo deny check"), "allow", "kiro orchestrator deny check");
	});

	test("kiro tester: cargo deny check allowedCommands exist", () => {
		const allowed = loadKiroConfig("tester").toolsSettings?.shell?.allowedCommands ?? [];
		for (const entry of ["cargo deny check", "cargo deny check *"]) {
			assert.ok(allowed.includes(kiroStoredPattern(entry)), `missing allowedCommands ${entry}`);
		}
		assert.equal(kiroVerdict("tester", "cargo deny check"), "allow", "kiro tester deny check");
	});

	test("opencode orchestrator: cargo nextest and cargo deny check allow rules exist", () => {
		for (const resource of ["cargo nextest *", "cargo deny check *"]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "allow"), `missing {shell, ${resource}, allow}`);
		}
		assert.equal(opencodeVerdict("orchestrator", "cargo nextest run"), "allow", "opencode orchestrator nextest");
		assert.equal(opencodeVerdict("orchestrator", "cargo deny check"), "allow", "opencode orchestrator deny check");
	});

	test("opencode tester: cargo deny check allow rule exists", () => {
		assert.ok(
			hasOpenCodeRule("tester", "cargo deny check *", "allow"),
			"missing {shell, cargo deny check *, allow}",
		);
		assert.equal(opencodeVerdict("tester", "cargo deny check"), "allow", "opencode tester deny check");
	});

	// The orchestrator carries cargo nextest allows, so a config override must
	// still deny on every engine. Without this, a dropped orchestrator deny would
	// keep the suite green.
	test("orchestrator: a cargo nextest config override denies on every engine", () => {
		const command = "cargo nextest run --config net.offline=true";
		assert.equal(verdict("orchestrator", command), "deny", "pi orchestrator nextest config override");
		assert.equal(kiroVerdict("orchestrator", command), "deny", "kiro orchestrator nextest config override");
		assert.equal(opencodeVerdict("orchestrator", command), "deny", "opencode orchestrator nextest config override");
	});
});
