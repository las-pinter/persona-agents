// Types for session-log-end.mjs, so the TypeScript tests can import it.

export { writerPrompt } from "../../shared/notes/session-log-net.ts";
export function writtenTaskNotes(entries: Record<string, unknown>[], notesDir: string): string[];
export function conversationTail(entries: Record<string, unknown>[]): string;
