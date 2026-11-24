/**
 * The project notes folders named for their scope.
 *
 *   tasks/         one working file per task (the task-notes skill)
 *   session-logs/  one record per agent session (the wrap-up skill)
 *
 * Earlier releases named them `sessions/` and `journal/`; nothing reads those
 * any more. Notes are never moved by code: README.md ("Notes folders after an
 * update") gives the owner the commands.
 */

import { join, sep } from "node:path";

export const TASKS = "tasks";
export const SESSION_LOGS = "session-logs";

/** Where task notes live. */
export const tasksDir = (notesDir: string): string => join(notesDir, TASKS);
/** Where session logs live. */
export const sessionLogsDir = (notesDir: string): string => join(notesDir, SESSION_LOGS);

/** True when the path is a file inside the folder. */
export const isInside = (dir: string, path: string): boolean => path.startsWith(dir + sep);
