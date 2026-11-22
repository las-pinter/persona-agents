// Types for compact.mjs, so the TypeScript tests can import it.

export interface Scan {
	/** Parsed transcript entries, good and bad lines alike. */
	entries: number;
	/** Main-chain tool calls the scan found. */
	toolUses: number;
}

export interface Manifest {
	sessionNotes: string;
	skills: string[];
	docs: string[];
	/** The scan counts recorded before the compaction, for the canary and metrics. */
	scan: Scan;
}
export function stateDir(env?: NodeJS.ProcessEnv): string;
export function readTranscript(path: string): Record<string, unknown>[];
export function buildManifest(entries: Record<string, unknown>[], notesDir: string, sessionId?: string): Manifest;
export function summaryInstructions(manifest: Manifest): string;
export function reloadContext(manifest: Manifest): string;
export function lastBoundary(entries: Record<string, unknown>[]): { preTokens?: number; postTokens?: number };
export function appendLog(path: string, line: string): boolean;
export function homeArg(argv?: string[]): string | undefined;
