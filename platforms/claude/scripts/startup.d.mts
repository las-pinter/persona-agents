// Types for startup.mjs, so the TypeScript tests can import it.

export function openSessionNotes(dir: string): string[];
export function unfinishedStudies(dir: string): string[];
export function recentJournal(dir: string, days?: number): string[];
export function startupContext(cwd: string, home?: string): string;
