// Types for session-log.mjs, so the TypeScript tests can import it.

export const SESSION_LOGS: string;
export const LEGACY_SESSION_LOGS: string;
export function dayOf(date: Date): string;
export function safeSession(id: string): string;
export function sessionLogsDir(notesDir: string): string;
export function findEntry(notesDir: string, session: string, days: string[], dirs?: string[]): string;
export function entryPath(notesDir: string, session: string, now?: Date): string;
export function recentEntries(notesDir: string, days?: number): string[];
