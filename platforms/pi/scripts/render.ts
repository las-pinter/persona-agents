/** Collapsed rows for the tool and message renderers. */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/** The plain text of a tool result or a message body. */
export function bodyText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && "type" in part)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** One line that never wraps, whatever the terminal width. */
class CollapsedRow implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.text, width)];
	}

	invalidate(): void {}
}

/** A collapsed row: the mark, then the one line the summarizer built. */
export function collapsedRow(theme: { fg(color: string, text: string): string }, line: string): Component {
	return new CollapsedRow(`${theme.fg("accent", "▸ ")}${line}`);
}
