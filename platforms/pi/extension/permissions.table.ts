/**
 * The pi permission rule table: a typed view of the shipped default data file.
 *
 * The rows live in `platforms/pi/permissions.table.json`, the source of truth.
 * `permission-config.ts` loads them, validates them, and stamps each row with its
 * layer. This module re-exports the default layer only, and reads the two literal
 * lists the tests need from the rows that own them, so one row definition stays
 * in one file.
 */

import { loadDefaultRows } from "./permission-config.ts";
import type { RuleRow } from "./permission-table.ts";

/** The shipped default rows, each stamped with the `default` layer. */
export const RULE_ROWS: readonly RuleRow[] = loadDefaultRows();

/** The diff-family verbs, read from the fence row that carries them. */
export const GIT_DIFF_FAMILY: readonly string[] =
	RULE_ROWS.find((row) => row.id === "git.read.write-flag")?.sub ?? [];

/** The read-only git subcommands, read from the read row that carries them. */
export const GIT_READ: readonly string[] = RULE_ROWS.find((row) => row.id === "git.read")?.sub ?? [];
