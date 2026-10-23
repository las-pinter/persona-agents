// Types for plugin-options.mjs, so the TypeScript tests can import it.

export function settingsOption(file: string, name: string): string;
export function managedOption(managedFile: string, name: string): string;
export function realHome(): string;
export function inProject(dir: string, env?: NodeJS.ProcessEnv, cwd?: string, home?: string): boolean;
export function userConfigDir(env?: NodeJS.ProcessEnv, cwd?: string, home?: string): string;
export function pluginOption(name: string, options?: { envFallback?: boolean }): string;
