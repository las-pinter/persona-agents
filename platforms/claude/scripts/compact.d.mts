// Types for compact.mjs, so the TypeScript tests can import it.

export interface Manifest {
	sessionNotes: string;
	skills: string[];
	docs: string[];
}
export function stateDir(env?: NodeJS.ProcessEnv): string;
export function readTranscript(path: string): Record<string, unknown>[];
export function pinnedDocs(text: string): string[];
export function studyPath(text: string): string;
export function buildManifest(entries: Record<string, unknown>[], notesDir: string): Manifest;
export function summaryInstructions(manifest: Manifest): string;
export function reloadContext(manifest: Manifest): string;
export function lastBoundary(entries: Record<string, unknown>[]): { preTokens?: number; postTokens?: number };
export function appendLog(path: string, line: string): boolean;
export function homeArg(argv?: string[]): string | undefined;
