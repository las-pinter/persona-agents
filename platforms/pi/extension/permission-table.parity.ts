/**
 * Parity ledger: every legacy pi permission entry and where it went.
 *
 * Sources, 327 entries in total:
 *   - the `permissions:` block of the 7 pi frontmatters, 310 entries, keyed
 *     `<role>/<allow|ask|deny>/<ordinal>` in file order, ordinal from 1. The
 *     counts below record that shape, so this file needs no frontmatter read;
 *   - the live global file `~/.pi/agent/permissions.json`, 17 entries,
 *     keyed `global/<deny|ask>/<ordinal>` in file order, ordinal from 1.
 *
 * Every entry resolves to exactly one row id or exactly one named deletion.
 * An entry that appears twice fails the test, and so does an entry with no
 * record. A row with no source entry carries a `ROW_RATIONALE` sentence.
 *
 * A deny entry must resolve to a deny row, or to a named deletion that keeps
 * the form closed. An entry that named two verbs of two different rows records
 * the second row in `split`.
 *
 * `NARROWED` lists a form the table now blocks. `FENCED` lists a form that a
 * shared allow row once let through and a deny row now fences. The test proves
 * both against the compiled rows, so a fail-open gap cannot drop out of this
 * file. A gap that blocks only some classes names them in `classes`.
 */

import type { RoleClass } from "./permission-table.ts";

export interface LegacyRecord {
	/** `<role>/<section>/<ordinal>` or `global/<section>/<ordinal>`. */
	entry: string;
	/** The row that now carries the rule. */
	row?: string;
	/** The named deletion, when no row carries the rule. */
	del?: string;
	/** Other rows the same legacy entry also fed, split by a row change. */
	split?: string[];
	/** The recorded change class when the row verdict equals the section. */
	why?: string;
	/** A one-line note when the row keeps less than the entry covered. */
	note?: string;
}

/** The recorded shape of the 310 frontmatter entries, per role and section. */
export const LEGACY_COUNTS: Record<string, Record<"allow" | "ask" | "deny", number>> = {
	orchestrator: { allow: 38, ask: 39, deny: 11 },
	planner: { allow: 10, ask: 2, deny: 21 },
	implementer: { allow: 21, ask: 9, deny: 20 },
	tester: { allow: 20, ask: 2, deny: 19 },
	reviewer: { allow: 17, ask: 2, deny: 29 },
	researcher: { allow: 16, ask: 2, deny: 28 },
	mascot: { allow: 1, ask: 0, deny: 3 },
};

/** The one-line reason of each named deletion. */
export const DELETIONS: Record<string, string> = {
	"del-narrowed-allow":
		"The table names no row for this command, so a form the role could run now falls to deny-by-default.",
	"del-unreachable-fence":
		"The command this fence guards has no allow row, so deny-by-default blocks the form without the fence.",
	"del-mascot-tool": "The mascot loadout carries no bash tool, so its bash fences are unreachable.",
};

/**
 * The recorded global file, entry for entry. The live file is unversioned, so
 * the differential test reads this copy and the live file is only a cross-check
 * under the opt-in variable.
 */
export interface GlobalLegacyRule {
	section: "deny" | "ask";
	tool: string;
	match: string;
}

export const LEGACY_GLOBAL: readonly GlobalLegacyRule[] = [
	{ section: "deny", tool: "read", match: "(^|/)[.][^/]*env[^/]*$|\\.envrc$" },
	{ section: "deny", tool: "read", match: "id_rsa|id_ed25519|\\.pem$|(^|/)credentials$|\\.aws(/|$)|(^|/)\\.ssh(/|$)" },
	{ section: "deny", tool: "bash", match: "\\bfind\\b.*\\s-exec\\b" },
	{
		section: "deny",
		tool: "bash",
		match:
			"\\bmkfs(?:\\.\\w+)?\\b|\\bdd\\b.*\\bof=/dev/|: \\(\\)\\s*\\{|\\b(?:shutdown|reboot|halt|poweroff)\\b",
	},
	{ section: "deny", tool: "bash", match: "\\b(chmod|chown)\\b.*\\b777\\b" },
	{ section: "deny", tool: "bash", match: "curl\\b.*\\|\\s*(ba)?sh\\b|wget\\b.*\\|\\s*(ba)?sh\\b" },
	{ section: "ask", tool: "bash", match: "\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f\\b|-rf\\b|--recursive)" },
	{ section: "ask", tool: "bash", match: "\\bsudo\\b" },
	{ section: "ask", tool: "bash", match: "\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]+|checkout\\s+--\\s+\\.)" },
	{ section: "ask", tool: "bash", match: "\\b(npm|pnpm|yarn|bun)\\s+publish\\b" },
	{ section: "ask", tool: "bash", match: "\\b(docker|podman)\\s+(rm|rmi|volume\\s+rm|system\\s+prune|network\\s+rm)\\b" },
	{ section: "ask", tool: "bash", match: "\\b(pip|pip3|uv)\\s+install\\b|\\b(apt-get|apt|pacman|dnf|yum|brew|apk)\\s+install\\b" },
	{ section: "ask", tool: "bash", match: "\\bnpx\\b" },
	{ section: "ask", tool: "bash", match: "\\bsed\\s+-i\\b" },
	{ section: "ask", tool: "bash", match: "\\bkill\\s+-9\\b" },
	{
		section: "ask",
		tool: "bash",
		match: "(?:^|[;&|(\\n])\\s*git(?:\\s+(?:-C\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)|--no-pager|-p))*\\s+push\\b",
	},
	{ section: "ask", tool: "bash", match: "(?:^|[;&|(\\n])\\s*gh\\s+pr\\b" },
];

/**
 * The owner ruling for each class of intended disagreement. The differential
 * test allows a disagreement only when the table is stricter, because a table
 * that is looser than a legacy rule is the one regression no ruling may waive.
 */
export const CHANGE_RULINGS: Record<string, { reason: string; ruling: string }> = {
	"del-narrowed-allow": {
		reason: "The table names a narrower row set, so a legacy allow form reaches deny-by-default.",
		ruling: "The table is the single rule store, and a narrowed form is fail-safe.",
	},
	"del-unreachable-fence": {
		reason: "The form has no allow row, so deny-by-default closes it without the fence.",
		ruling: "Deny-by-default is the mode for every class.",
	},
	"del-mascot-tool": {
		reason: "The mascot loadout carries no bash tool.",
		ruling: "The differential skips a probe whose tool is absent from the loadout.",
	},
	note: {
		reason: "The row keeps less than the legacy entry covered.",
		ruling: "The row is the single source; the note states the narrowed part.",
	},
	strengthened: {
		reason: "The mapped row carries a stricter verdict than the legacy section.",
		ruling: "A stricter verdict is fail-safe and the row is the single source.",
	},
	"substituted-deny": {
		reason: "A substituted history command is denied rather than asked, because the parser checks the inner command as its own segment and that segment matches no allow row.",
		ruling: "The table is stricter than the legacy ask, which is fail-safe, and the substitution stays blocked.",
	},
	"class-consolidation": {
		reason: "Roles of one class share one row set, so a role can gain a row a sibling role carried.",
		ruling: "The three-class model is the doctrine, and a shared read row is the unit.",
	},
	"role-scope": {
		reason: "A row is narrowed from a class to named professions, so an unnamed profession falls to deny-by-default.",
		ruling: "The profession rule wins over the class rule, and a fall-through deny is fail-safe.",
	},
};

/** A row with no legacy entry of its own still needs a stated reason. */
export const ROW_RATIONALE: Record<string, string> = {
	"tool.analysis":
		"A new capability: the ten read-only analysis tools had no legacy entry, so one tool-name allow row covers every class.",
	"system.power":
		"Split from the global deny entry that also covers mkfs and dd, so the prompt names one action.",
	"write.escape.deny":
		"A reader writes only its own notes zone, so a write outside that zone is an explicit deny row instead of a fall-through.",
};

/** A form the table blocks, with the reason and the sample the test checks. */
export interface GapRecord {
	form: string;
	sample: string;
	row: string;
	/** The classes the gap holds for. Absent means every class. */
	classes?: RoleClass[];
	reason: string;
}

export const NARROWED: readonly GapRecord[] = [
	{
		form: ".venv/bin wrapper",
		sample: ".venv/bin/python -m pytest",
		row: "shell.build",
		reason: "The worker build row names plain verbs, so a path-shaped verb falls to deny-by-default.",
	},
	{
		form: "mkdir",
		sample: "mkdir -p out",
		row: "shell.read",
		classes: ["reader", "worker"],
		reason: "The shared read row omits the verb, so a read-only or worker role falls to deny-by-default.",
	},
	{
		form: "sort -o",
		sample: "sort -o out in.txt",
		row: "shell.read",
		classes: ["reader", "worker"],
		reason: "sort writes a file under -o, so the shared read row omits it.",
	},
	{
		form: "uniq out",
		sample: "uniq in.txt out.txt",
		row: "shell.read",
		classes: ["reader", "worker"],
		reason: "uniq writes a file under a second argument, so the shared read row omits it.",
	},
	{
		form: "xxd out",
		sample: "xxd in.bin out.hex",
		row: "shell.read",
		reason: "xxd writes a file under a second argument, so the shared read row omits it.",
	},
	{
		form: "mktemp",
		sample: "mktemp",
		row: "shell.read",
		reason: "mktemp creates a file, so the shared read row omits it.",
	},
	{
		form: "printf",
		sample: "printf x",
		row: "shell.read",
		reason: "printf can write a file under a redirect, so the shared read row omits it.",
	},
	{
		form: "sha256sum",
		sample: "sha256sum f",
		row: "shell.read",
		reason: "sha256sum is a worker tool, and the shared read row names no worker tool.",
	},
	{
		form: "test",
		sample: "test -f x",
		row: "shell.read",
		reason: "test is a shell builtin with a process-status result, so the read row omits it.",
	},
	{
		form: "mdl",
		sample: "mdl README.md",
		row: "shell.read",
		reason: "mdl is a markdown linter a worker carried; it is not a read-only probe.",
	},
	{
		form: "npx runner",
		sample: "npx jest",
		row: "shell.build",
		reason: "The global npx ask matches first, so a worker allow for the verb can never win.",
	},
	{
		form: "git remote",
		sample: "git remote -v",
		row: "git.read",
		reason: "A bare remote subcommand can also change the config, so the read row omits it.",
	},
	{
		form: "branch write",
		sample: "git branch new",
		row: "git.branch",
		reason: "The branch row matches the listing tail only, so a bare name falls to deny-by-default.",
	},
	{
		form: "git reflog",
		sample: "git reflog",
		row: "git.read",
		reason: "A bare reflog subcommand can also expire it, so the read row omits it.",
	},
	{
		form: "git config",
		sample: "git config --get core.editor",
		row: "git.read",
		reason: "A config read and a config write share one verb, so the read row omits it.",
	},
	{
		form: "git ls-remote",
		sample: "git ls-remote origin",
		row: "git.read",
		reason: "ls-remote can run an upload program, so the read row omits it.",
	},
	{
		form: "git cat-file",
		sample: "git cat-file -p HEAD",
		row: "git.read",
		reason: "The read row is one list for every class, and the reader entry did not carry it.",
	},
	{
		form: "git grep",
		sample: "git grep pattern",
		row: "git.read",
		reason: "grep runs a filter or a pager under an option, so the shared read row omits the verb.",
	},
	{
		form: "git hash-object",
		sample: "git hash-object file",
		row: "git.read",
		reason: "hash-object writes an object under -w, and no row fences that flag.",
	},
	{
		form: "git fsck",
		sample: "git fsck",
		row: "git.read",
		reason: "fsck writes dangling objects under --lost-found, and no row fences that flag.",
	},
	{
		form: "git inspection verbs",
		sample: "git check-ref-format main",
		row: "git.read",
		reason: "The shared read row names the common inspection verbs only, so a rarer one falls to deny-by-default.",
	},
	{
		form: "gh read",
		sample: "gh --version",
		row: "release.ask",
		reason: "No row names a read-only gh verb, so the default blocks the gh version and auth probes.",
	},
];

export const FENCED: readonly GapRecord[] = [
	{
		form: "redirect",
		sample: "cat notes.txt > /fixture/escape.txt",
		row: "shell.redirect.deny",
		reason: "A stream write leaves the write zone, so a deny row fences it above the read allow.",
	},
	{
		form: "rg --pre",
		sample: "rg --pre 'sh -c id' pattern",
		row: "shell.read.exec-flag",
		reason: "rg --pre runs a program, so a deny row fences the option.",
	},
	{
		form: "rg -z",
		sample: "rg -z pattern.gz",
		row: "shell.read.exec-flag",
		reason: "rg -z runs a decompressor, so the same deny row fences it.",
	},
	{
		form: "date -s",
		sample: "date -s 2020-01-01",
		row: "shell.read.clock-flag",
		reason: "date -s sets the clock, so a deny row fences the option.",
	},
	{
		form: "git --output",
		sample: "git log --output=/fixture/escape.txt",
		row: "git.read.write-flag",
		reason: "The diff family writes a file under --output, so a deny row fences the option.",
	},
	{
		form: "git --out",
		sample: "git log --out=/fixture/escape.txt",
		row: "git.read.write-flag",
		reason: "Git accepts a unique abbreviation of the option, so the fence names every prefix.",
	},
	{
		form: "git --ext-diff",
		sample: "git diff --ext-diff HEAD",
		row: "git.read.write-flag",
		reason: "--ext-diff runs a configured driver, so the same deny row fences it.",
	},
	{
		form: "git --ext",
		sample: "git diff --ext HEAD",
		row: "git.read.write-flag",
		reason: "The abbreviation of --ext-diff runs the same driver, so the fence names every prefix.",
	},
	{
		form: "git --textconv",
		sample: "git show --textconv HEAD:file",
		row: "git.read.write-flag",
		reason: "--textconv runs a configured filter, so the same deny row fences it.",
	},
	{
		form: "git --textc",
		sample: "git show --textc HEAD:file",
		row: "git.read.write-flag",
		reason: "The abbreviation of --textconv runs the same filter, so the fence names every prefix.",
	},
	{
		form: "git --textc on annotate",
		sample: "git annotate --textc f",
		row: "git.read.write-flag",
		reason: "The read row allows annotate, so the fence must name the verb at every abbreviation.",
	},
	{
		form: "git --filters",
		sample: "git diff --filters HEAD",
		row: "git.read.write-flag",
		reason: "--filters runs a configured filter, so the same deny row fences it.",
	},
	{
		form: "git --fil",
		sample: "git diff --fil HEAD",
		row: "git.read.write-flag",
		reason: "The abbreviation of --filters runs the same filter, so the fence names every prefix.",
	},
];

export const GLOBAL_ENTRY_COUNT = 17;
export const FRONTMATTER_ENTRY_COUNT = 310;

export const LEGACY: readonly LegacyRecord[] = [
	// --- global deny: 6 -----------------------------------------------------
	{ entry: "global/deny/1", row: "secret.env" },
	{ entry: "global/deny/2", row: "secret.key" },
	{ entry: "global/deny/3", row: "find.exec" },
	{ entry: "global/deny/4", row: "disk.destroy", split: ["disk.raw-write", "system.power", "shell.fork-bomb"] },
	{ entry: "global/deny/5", row: "perm.world-write" },
	{ entry: "global/deny/6", row: "remote.pipe-shell" },

	// --- global ask: 11 -----------------------------------------------------
	{ entry: "global/ask/1", row: "shell.rm.recursive" },
	{ entry: "global/ask/2", row: "shell.sudo" },
	{ entry: "global/ask/3", row: "git.irreversible" },
	{ entry: "global/ask/4", row: "pkg.publish" },
	{ entry: "global/ask/5", row: "container.remove" },
	{ entry: "global/ask/6", row: "pkg.install" },
	{ entry: "global/ask/7", row: "npx.run" },
	{ entry: "global/ask/8", row: "sed.inplace" },
	{ entry: "global/ask/9", row: "kill.force" },
	{ entry: "global/ask/10", row: "release.ask", note: "The release ask covers push for the orchestrator, and the release deny covers every other role." },
	{ entry: "global/ask/11", row: "release.ask", note: "The release ask covers gh pr for the orchestrator, and the release deny covers every other role." },

	// --- orchestrator allow: 38 ---------------------------------------------
	{ entry: "orchestrator/allow/1", row: "todo" },
	{ entry: "orchestrator/allow/2", row: "read.any" },
	{ entry: "orchestrator/allow/3", row: "read.any" },
	{ entry: "orchestrator/allow/4", row: "read.any" },
	{ entry: "orchestrator/allow/5", row: "read.any" },
	{ entry: "orchestrator/allow/6", row: "read.any" },
	{ entry: "orchestrator/allow/7", row: "read.any" },
	{ entry: "orchestrator/allow/8", row: "write.repo" },
	{ entry: "orchestrator/allow/9", row: "write.repo" },
	{ entry: "orchestrator/allow/10", row: "write.all-notes" },
	{ entry: "orchestrator/allow/11", row: "write.all-notes" },
	{ entry: "orchestrator/allow/12", row: "write.tmp" },
	{ entry: "orchestrator/allow/13", row: "write.tmp" },
	{ entry: "orchestrator/allow/14", row: "todo" },
	{ entry: "orchestrator/allow/15", row: "ask" },
	{ entry: "orchestrator/allow/16", row: "git.read" },
	{ entry: "orchestrator/allow/17", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/18", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/19", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/20", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/21", row: "git.branch" },
	{ entry: "orchestrator/allow/22", row: "git.read" },
	{ entry: "orchestrator/allow/23", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/24", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/25", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/26", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/27", row: "git.read" },
	{ entry: "orchestrator/allow/28", row: "git.read" },
	{ entry: "orchestrator/allow/29", row: "git.read" },
	{ entry: "orchestrator/allow/30", row: "git.read" },
	{ entry: "orchestrator/allow/31", row: "git.read" },
	{ entry: "orchestrator/allow/32", row: "git.history.plain" },
	{ entry: "orchestrator/allow/33", del: "del-narrowed-allow" },
	{ entry: "orchestrator/allow/34", row: "shell.read", split: ["shell.journal.tools"], note: "The shared read row keeps the plain read verbs; the orchestrator row adds mkdir, sort, and uniq." },
	{ entry: "orchestrator/allow/35", row: "shell.find" },
	{ entry: "orchestrator/allow/36", row: "shell.verify.cargo" },
	{ entry: "orchestrator/allow/37", row: "shell.verify.cargo" },
	{ entry: "orchestrator/allow/38", row: "shell.verify" },

	// --- orchestrator ask: 39 -----------------------------------------------
	{ entry: "orchestrator/ask/1", row: "path.ask" },
	{ entry: "orchestrator/ask/2", row: "path.ask" },
	{ entry: "orchestrator/ask/3", row: "path.ask" },
	{ entry: "orchestrator/ask/4", row: "path.ask" },
	{ entry: "orchestrator/ask/5", row: "path.ask" },
	{ entry: "orchestrator/ask/6", row: "path.ask" },
	{ entry: "orchestrator/ask/7", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/8", row: "git.read.write-flag" },
	{ entry: "orchestrator/ask/9", row: "git.process-substitution" },
	{ entry: "orchestrator/ask/10", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/11", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/12", row: "shell.rm.recursive" },
	{ entry: "orchestrator/ask/13", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/14", row: "file.move.ask" },
	{ entry: "orchestrator/ask/15", row: "file.move.ask" },
	{ entry: "orchestrator/ask/16", row: "file.move.ask" },
	{ entry: "orchestrator/ask/17", row: "git.history.reset-soft" },
	{ entry: "orchestrator/ask/18", row: "git.history.exception" },
	{ entry: "orchestrator/ask/19", row: "shell.sudo" },
	{ entry: "orchestrator/ask/20", row: "git.history.exception" },
	{ entry: "orchestrator/ask/21", row: "git.history.exception" },
	{ entry: "orchestrator/ask/22", row: "git.history.exception" },
	{ entry: "orchestrator/ask/23", row: "git.history.exception" },
	{ entry: "orchestrator/ask/24", row: "git.history.exception" },
	{ entry: "orchestrator/ask/25", row: "git.history.exception" },
	{ entry: "orchestrator/ask/26", row: "git.history.prefixed" },
	{ entry: "orchestrator/ask/27", row: "git.history.prefixed" },
	{ entry: "orchestrator/ask/28", row: "git.history.subshell", why: "substituted-deny" },
	{ entry: "orchestrator/ask/29", row: "git.history.exception" },
	{ entry: "orchestrator/ask/30", row: "git.history.exception" },
	{ entry: "orchestrator/ask/31", row: "release.ask" },
	{ entry: "orchestrator/ask/32", row: "release.ask" },
	{ entry: "orchestrator/ask/33", row: "release.ask" },
	{ entry: "orchestrator/ask/34", row: "release.ask" },
	{ entry: "orchestrator/ask/35", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/36", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/37", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/38", del: "del-unreachable-fence" },
	{ entry: "orchestrator/ask/39", del: "del-unreachable-fence" },

	// --- orchestrator deny: 11 ----------------------------------------------
	{ entry: "orchestrator/deny/1", del: "del-unreachable-fence" },
	{ entry: "orchestrator/deny/2", del: "del-unreachable-fence" },
	{ entry: "orchestrator/deny/3", del: "del-unreachable-fence" },
	{ entry: "orchestrator/deny/4", row: "find.exec" },
	{ entry: "orchestrator/deny/5", row: "find.exec" },
	{ entry: "orchestrator/deny/6", del: "del-unreachable-fence" },
	{ entry: "orchestrator/deny/7", row: "remote.pipe-shell" },
	{ entry: "orchestrator/deny/8", row: "shell.redirect.deny" },
	{ entry: "orchestrator/deny/9", row: "disk.destroy", split: ["disk.raw-write"] },
	{ entry: "orchestrator/deny/10", row: "shell.rm.recursive" },
	{ entry: "orchestrator/deny/11", row: "git.tag.delete" },

	// --- planner allow: 10 --------------------------------------------------
	{ entry: "planner/allow/1", row: "todo" },
	{ entry: "planner/allow/2", row: "todo" },
	{ entry: "planner/allow/3", row: "read.any" },
	{ entry: "planner/allow/4", row: "read.any" },
	{ entry: "planner/allow/5", row: "read.any" },
	{ entry: "planner/allow/6", row: "read.any" },
	{ entry: "planner/allow/7", row: "write.own-notes" },
	{ entry: "planner/allow/8", row: "write.own-notes" },
	{ entry: "planner/allow/9", row: "shell.read" },
	{ entry: "planner/allow/10", row: "shell.find" },

	// --- planner ask: 2 -----------------------------------------------------
	{ entry: "planner/ask/1", row: "shell.rm.recursive" },
	{ entry: "planner/ask/2", row: "shell.sudo" },

	// --- planner deny: 21 ---------------------------------------------------
	{ entry: "planner/deny/1", del: "del-unreachable-fence" },
	{ entry: "planner/deny/2", row: "shell.sudo.deny" },
	{ entry: "planner/deny/3", row: "history.deny" },
	{ entry: "planner/deny/4", row: "history.deny" },
	{ entry: "planner/deny/5", row: "release.deny" },
	{ entry: "planner/deny/6", row: "release.deny" },
	{ entry: "planner/deny/7", del: "del-unreachable-fence" },
	{ entry: "planner/deny/8", del: "del-unreachable-fence" },
	{ entry: "planner/deny/9", row: "git.fetch.deny" },
	{ entry: "planner/deny/10", del: "del-unreachable-fence" },
	{ entry: "planner/deny/11", del: "del-unreachable-fence" },
	{ entry: "planner/deny/12", row: "find.exec" },
	{ entry: "planner/deny/13", row: "find.exec" },
	{ entry: "planner/deny/14", del: "del-unreachable-fence" },
	{ entry: "planner/deny/15", row: "remote.pipe-shell" },
	{ entry: "planner/deny/16", row: "shell.redirect.deny" },
	{ entry: "planner/deny/17", del: "del-unreachable-fence" },
	{ entry: "planner/deny/18", del: "del-unreachable-fence" },
	{ entry: "planner/deny/19", del: "del-unreachable-fence" },
	{ entry: "planner/deny/20", row: "shell.read.exec-flag" },
	{ entry: "planner/deny/21", row: "shell.read.clock-flag" },

	// --- implementer allow: 21 ----------------------------------------------
	{ entry: "implementer/allow/1", row: "todo" },
	{ entry: "implementer/allow/2", row: "read.any" },
	{ entry: "implementer/allow/3", row: "read.any" },
	{ entry: "implementer/allow/4", row: "read.any" },
	{ entry: "implementer/allow/5", row: "read.any" },
	{ entry: "implementer/allow/6", row: "write.repo" },
	{ entry: "implementer/allow/7", row: "write.repo" },
	{ entry: "implementer/allow/8", row: "todo" },
	{ entry: "implementer/allow/9", row: "shell.read" },
	{ entry: "implementer/allow/10", row: "shell.find" },
	{ entry: "implementer/allow/11", row: "git.read" },
	{ entry: "implementer/allow/12", row: "git.read" },
	{ entry: "implementer/allow/13", row: "shell.build" },
	{ entry: "implementer/allow/14", row: "shell.build" },
	{ entry: "implementer/allow/15", row: "shell.build" },
	{ entry: "implementer/allow/16", row: "shell.build" },
	{ entry: "implementer/allow/17", row: "shell.build", note: "The row names plain verbs, so a path-shaped verb is no longer allowed." },
	{ entry: "implementer/allow/18", row: "shell.build" },
	{ entry: "implementer/allow/19", row: "shell.build" },
	{ entry: "implementer/allow/20", row: "shell.build" },
	{ entry: "implementer/allow/21", row: "shell.build" },

	// --- implementer ask: 9 -------------------------------------------------
	{ entry: "implementer/ask/1", row: "sed.inplace" },
	{ entry: "implementer/ask/2", del: "del-unreachable-fence" },
	{ entry: "implementer/ask/3", del: "del-unreachable-fence" },
	{ entry: "implementer/ask/4", del: "del-unreachable-fence" },
	{ entry: "implementer/ask/5", del: "del-unreachable-fence" },
	{ entry: "implementer/ask/6", row: "file.move.ask" },
	{ entry: "implementer/ask/7", row: "file.move.ask" },
	{ entry: "implementer/ask/8", row: "file.move.ask" },
	{ entry: "implementer/ask/9", row: "git.fetch.ask", note: "The row names a plain fetch with the three listed global options; a wrapper prefix falls to deny-by-default." },

	// --- implementer deny: 20 -----------------------------------------------
	{ entry: "implementer/deny/1", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/2", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/3", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/4", row: "release.deny", split: ["history.deny"] },
	{ entry: "implementer/deny/5", row: "history.deny" },
	{ entry: "implementer/deny/6", row: "release.deny" },
	{ entry: "implementer/deny/7", row: "release.deny" },
	{ entry: "implementer/deny/8", row: "release.deny" },
	{ entry: "implementer/deny/9", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/10", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/11", row: "git.fetch.deny" },
	{ entry: "implementer/deny/12", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/13", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/14", row: "find.exec" },
	{ entry: "implementer/deny/15", row: "find.exec" },
	{ entry: "implementer/deny/16", del: "del-unreachable-fence" },
	{ entry: "implementer/deny/17", row: "remote.pipe-shell" },
	{ entry: "implementer/deny/18", row: "shell.redirect.deny" },
	{ entry: "implementer/deny/19", row: "disk.destroy", split: ["disk.raw-write", "shell.sudo.deny"] },
	{ entry: "implementer/deny/20", row: "shell.rm.recursive" },

	// --- tester allow: 20 ---------------------------------------------------
	{ entry: "tester/allow/1", row: "todo" },
	{ entry: "tester/allow/2", row: "read.any" },
	{ entry: "tester/allow/3", row: "read.any" },
	{ entry: "tester/allow/4", row: "read.any" },
	{ entry: "tester/allow/5", row: "read.any" },
	{ entry: "tester/allow/6", row: "write.repo" },
	{ entry: "tester/allow/7", row: "write.repo" },
	{ entry: "tester/allow/8", row: "todo" },
	{ entry: "tester/allow/9", row: "shell.read" },
	{ entry: "tester/allow/10", row: "shell.find" },
	{ entry: "tester/allow/11", row: "git.read" },
	{ entry: "tester/allow/12", row: "shell.build" },
	{ entry: "tester/allow/13", row: "shell.build" },
	{ entry: "tester/allow/14", row: "shell.build", note: "The row names plain verbs, so a path-shaped verb is no longer allowed." },
	{ entry: "tester/allow/15", row: "shell.build" },
	{ entry: "tester/allow/16", row: "shell.build" },
	{ entry: "tester/allow/17", row: "shell.build" },
	{ entry: "tester/allow/18", row: "shell.build" },
	{ entry: "tester/allow/19", row: "shell.build" },
	{ entry: "tester/allow/20", row: "shell.build" },

	// --- tester ask: 2 ------------------------------------------------------
	{ entry: "tester/ask/1", row: "sed.inplace" },
	{ entry: "tester/ask/2", row: "git.fetch.ask", note: "The row names a plain fetch with the three listed global options; a wrapper prefix falls to deny-by-default." },

	// --- tester deny: 19 ----------------------------------------------------
	{ entry: "tester/deny/1", del: "del-unreachable-fence" },
	{ entry: "tester/deny/2", del: "del-unreachable-fence" },
	{ entry: "tester/deny/3", del: "del-unreachable-fence" },
	{ entry: "tester/deny/4", row: "release.deny", split: ["history.deny"] },
	{ entry: "tester/deny/5", row: "history.deny" },
	{ entry: "tester/deny/6", row: "release.deny" },
	{ entry: "tester/deny/7", row: "release.deny" },
	{ entry: "tester/deny/8", del: "del-unreachable-fence" },
	{ entry: "tester/deny/9", del: "del-unreachable-fence" },
	{ entry: "tester/deny/10", row: "git.fetch.deny" },
	{ entry: "tester/deny/11", del: "del-unreachable-fence" },
	{ entry: "tester/deny/12", del: "del-unreachable-fence" },
	{ entry: "tester/deny/13", row: "find.exec" },
	{ entry: "tester/deny/14", row: "find.exec" },
	{ entry: "tester/deny/15", del: "del-unreachable-fence" },
	{ entry: "tester/deny/16", row: "remote.pipe-shell" },
	{ entry: "tester/deny/17", row: "shell.redirect.deny" },
	{ entry: "tester/deny/18", row: "disk.destroy", split: ["disk.raw-write", "shell.sudo.deny"] },
	{ entry: "tester/deny/19", row: "shell.rm.recursive" },

	// --- reviewer allow: 17 -------------------------------------------------
	{ entry: "reviewer/allow/1", row: "todo" },
	{ entry: "reviewer/allow/2", row: "read.any" },
	{ entry: "reviewer/allow/3", row: "read.any" },
	{ entry: "reviewer/allow/4", row: "read.any" },
	{ entry: "reviewer/allow/5", row: "read.any" },
	{ entry: "reviewer/allow/6", row: "shell.read" },
	{ entry: "reviewer/allow/7", row: "shell.find" },
	{ entry: "reviewer/allow/8", row: "git.read" },
	{ entry: "reviewer/allow/9", row: "toolchain.read", note: "The shared probe row omits the build and test runners." },
	{ entry: "reviewer/allow/10", row: "toolchain.read", note: "The shared probe row omits the container reads." },
	{ entry: "reviewer/allow/11", row: "toolchain.read", note: "The shared probe row omits the type check." },
	{ entry: "reviewer/allow/12", row: "toolchain.read" },
	{ entry: "reviewer/allow/13", row: "toolchain.read" },
	{ entry: "reviewer/allow/14", row: "toolchain.read" },
	{ entry: "reviewer/allow/15", row: "toolchain.read", note: "The shared probe row omits the build and test runners." },
	{ entry: "reviewer/allow/16", row: "toolchain.read", note: "The shared probe row omits the dependency policy gate." },
	{ entry: "reviewer/allow/17", row: "toolchain.read", note: "The shared probe row omits the format check." },

	// --- reviewer ask: 2 ----------------------------------------------------
	{ entry: "reviewer/ask/1", row: "sed.inplace" },
	{ entry: "reviewer/ask/2", row: "git.fetch.ask", why: "role-scope" },

	// --- reviewer deny: 29 --------------------------------------------------
	{ entry: "reviewer/deny/1", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/2", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/3", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/4", row: "release.deny", split: ["history.deny"] },
	{ entry: "reviewer/deny/5", row: "history.deny" },
	{ entry: "reviewer/deny/6", row: "release.deny" },
	{ entry: "reviewer/deny/7", row: "release.deny" },
	{ entry: "reviewer/deny/8", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/9", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/10", row: "git.fetch.deny" },
	{ entry: "reviewer/deny/11", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/12", row: "find.exec" },
	{ entry: "reviewer/deny/13", row: "find.exec" },
	{ entry: "reviewer/deny/14", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/15", row: "remote.pipe-shell" },
	{ entry: "reviewer/deny/16", row: "shell.redirect.deny" },
	{ entry: "reviewer/deny/17", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/18", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/19", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/20", row: "shell.read.exec-flag" },
	{ entry: "reviewer/deny/21", row: "shell.read.clock-flag" },
	{ entry: "reviewer/deny/22", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/23", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/24", row: "git.read.write-flag" },
	{ entry: "reviewer/deny/25", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/26", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/27", del: "del-unreachable-fence" },
	{ entry: "reviewer/deny/28", row: "disk.destroy", split: ["disk.raw-write", "shell.sudo.deny"] },
	{ entry: "reviewer/deny/29", row: "shell.rm.recursive" },

	// --- researcher allow: 16 -----------------------------------------------
	{ entry: "researcher/allow/1", row: "todo" },
	{ entry: "researcher/allow/2", row: "read.any" },
	{ entry: "researcher/allow/3", row: "read.any" },
	{ entry: "researcher/allow/4", row: "read.any" },
	{ entry: "researcher/allow/5", row: "read.any" },
	{ entry: "researcher/allow/6", row: "write.own-notes" },
	{ entry: "researcher/allow/7", row: "write.own-notes" },
	{ entry: "researcher/allow/8", row: "shell.read" },
	{ entry: "researcher/allow/9", row: "shell.find" },
	{ entry: "researcher/allow/10", row: "git.read" },
	{ entry: "researcher/allow/11", row: "git.read" },
	{ entry: "researcher/allow/12", row: "toolchain.read" },
	{ entry: "researcher/allow/13", row: "toolchain.read" },
	{ entry: "researcher/allow/14", row: "toolchain.read" },
	{ entry: "researcher/allow/15", row: "toolchain.read" },
	{ entry: "researcher/allow/16", row: "toolchain.read" },

	// --- researcher ask: 2 --------------------------------------------------
	{ entry: "researcher/ask/1", row: "sed.inplace" },
	{ entry: "researcher/ask/2", row: "git.fetch.ask", why: "role-scope" },

	// --- researcher deny: 28 ------------------------------------------------
	{ entry: "researcher/deny/1", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/2", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/3", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/4", row: "release.deny", split: ["history.deny"] },
	{ entry: "researcher/deny/5", row: "history.deny" },
	{ entry: "researcher/deny/6", row: "release.deny" },
	{ entry: "researcher/deny/7", row: "release.deny" },
	{ entry: "researcher/deny/8", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/9", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/10", row: "git.fetch.deny" },
	{ entry: "researcher/deny/11", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/12", row: "find.exec" },
	{ entry: "researcher/deny/13", row: "find.exec" },
	{ entry: "researcher/deny/14", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/15", row: "remote.pipe-shell" },
	{ entry: "researcher/deny/16", row: "shell.redirect.deny" },
	{ entry: "researcher/deny/17", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/18", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/19", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/20", row: "shell.read.exec-flag" },
	{ entry: "researcher/deny/21", row: "shell.read.clock-flag" },
	{ entry: "researcher/deny/22", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/23", row: "git.read.write-flag" },
	{ entry: "researcher/deny/24", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/25", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/26", del: "del-unreachable-fence" },
	{ entry: "researcher/deny/27", row: "disk.destroy", split: ["disk.raw-write", "shell.sudo.deny"] },
	{ entry: "researcher/deny/28", row: "shell.rm.recursive" },

	// --- mascot allow: 1 ----------------------------------------------------
	{ entry: "mascot/allow/1", row: "read.any" },

	// --- mascot deny: 3 -----------------------------------------------------
	{ entry: "mascot/deny/1", del: "del-mascot-tool" },
	{ entry: "mascot/deny/2", del: "del-mascot-tool" },
	{ entry: "mascot/deny/3", del: "del-mascot-tool" },
];
