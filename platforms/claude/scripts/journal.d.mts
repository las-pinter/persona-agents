// Types for journal.mjs, so the TypeScript tests can import it.

export function dayOf(date: Date): string;
export function safeSession(id: string): string;
export function journalDir(notesDir: string): string;
export function findEntry(notesDir: string, session: string, days: string[]): string;
export function entryPath(notesDir: string, session: string, now?: Date): string;
export function recentEntries(notesDir: string, days?: number): string[];
