// Types for notes-paths.mjs, so the TypeScript tests and hooks can import it.

export const COMMON_PROJECT: string;
export function gitCommonDir(cwd: string): string;
export function projectFromCommonDir(commonDir: string): string;
export function projectName(cwd: string): string;
export function notesRoot(home?: string): string;
export function projectDir(cwd: string, home?: string): string;
