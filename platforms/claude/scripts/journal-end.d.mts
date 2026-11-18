// Types for journal-end.mjs, so the TypeScript tests can import it.

export function writtenSessionNotes(entries: Record<string, unknown>[], notesDir: string): string[];
export function conversationTail(entries: Record<string, unknown>[]): string;
export function writerPrompt(
	payload: { session: string; day: string; time: string },
	sources: { notes: { path: string; text: string }[]; summaries: string; tail: string },
): string;
