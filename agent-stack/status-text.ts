/** Wrap footer status text in the dim token in TUI mode, with a plain-text fallback. */

/** The theme surface needed to dim text. */
export interface StatusUi {
	theme?: { fg: (token: "dim", text: string) => string };
}

/** Wrap text in the dim token in TUI mode only; otherwise return it unchanged. */
export function dimText(ui: StatusUi | undefined, text: string | undefined, mode?: string): string | undefined {
	if (text === undefined) return undefined;
	if (mode !== "tui") return text;
	const theme = ui?.theme;
	return theme ? theme.fg("dim", text) : text;
}
