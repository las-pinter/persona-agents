/**
 * The reviewer's system prompt.
 *
 * One home for the reviewer rules: `content/professions/reviewer.md`, read at
 * run time so Pi, Kiro, and Claude Code review under the same text.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentDir } from "./paths.ts";

/** The reviewer rules, verbatim. */
export function reviewerBody(): string {
	return readFileSync(join(contentDir(), "professions", "reviewer.md"), "utf8").trim();
}
