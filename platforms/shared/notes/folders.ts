/**
 * The project notes folders named for their scope.
 *
 *   tasks/         one working file per task (the task-notes skill)
 *   session-logs/  one record per agent session (the wrap-up skill)
 *
 * Earlier releases named them `sessions/` and `journal/`. For one release the
 * readers still look in the old folders; every write goes to the new ones.
 * Notes are never moved by code: README.md ("Notes folders after an update")
 * gives the owner the commands, and the fallback keeps unmoved notes visible
 * until then.
 */

import { join, sep } from "node:path";

export const TASKS = "tasks";
export const SESSION_LOGS = "session-logs";
/** Read-only fallback for one release. */
export const LEGACY_TASKS = "sessions";
/** Read-only fallback for one release. */
export const LEGACY_SESSION_LOGS = "journal";

/** Where task notes are written. */
export const tasksDir = (notesDir: string): string => join(notesDir, TASKS);
/** Where session logs are written. */
export const sessionLogsDir = (notesDir: string): string => join(notesDir, SESSION_LOGS);

/** Every folder task notes are read from, the current one first. */
export const taskDirs = (notesDir: string): string[] => [tasksDir(notesDir), join(notesDir, LEGACY_TASKS)];
/** Every folder session logs are read from, the current one first. */
export const sessionLogDirs = (notesDir: string): string[] => [sessionLogsDir(notesDir), join(notesDir, LEGACY_SESSION_LOGS)];

/** True when the path is a file inside one of the folders. */
export const isInside = (dirs: string[], path: string): boolean => dirs.some((dir) => path.startsWith(dir + sep));
