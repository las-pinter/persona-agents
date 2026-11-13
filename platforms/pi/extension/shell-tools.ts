/**
 * The shell tool class: one owner for its names, its probe field, and the
 * prompt kind test.
 *
 * The gate, the prompt, and the renderer ask this file whether a tool carries a
 * shell command line. A new shell tool lands in the name list once. This module
 * exports the probe map and the class test only. So the gate cannot run a shell
 * command as a plain tool call and the prompt cannot paint it as a target.
 *
 * This module imports nothing from the gate.
 */

/** The tool names whose input is a shell command line. */
const SHELL_TOOL_NAMES = ["bash", "powershell"] as const;

/** The input field that holds the shell command line. */
const SHELL_PROBE_FIELD = "command";

/** The shell tool class, read-only by type. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(SHELL_TOOL_NAMES);

/** The input field that carries the shell text, keyed by tool name. */
export const SHELL_PROBES: ReadonlyMap<string, string> = new Map(
	SHELL_TOOL_NAMES.map((name): [string, string] => [name, SHELL_PROBE_FIELD]),
);

/** True when the tool's input is a shell command line, not one target. */
export function isShellTool(name: string): boolean {
	return SHELL_TOOLS.has(name);
}
