/**
 * The review panel: one line above the editor, unfolded by a click.
 *
 * The panel is display only. The line is built by `scripts/summary.ts`, and the
 * text behind it is the review the owner already has. It holds no state about
 * the session beyond what it was last told.
 */

import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/** The part of Pi's theme this module uses. */
export interface PanelTheme {
	fg(color: string, text: string): string;
}

/** What the panel shows. */
export interface PanelModel {
	/** The one-line status, already formatted. */
	line: string;
	/** The review text behind the line, unfolded on a click. */
	text: string;
}

/** The most lines an unfolded panel shows, header included. */
export const PANEL_LINES = 12;

/** The folded and unfolded marks, so a reader knows which state it is in. */
const FOLDED = "▸ ";
const UNFOLDED = "▾ ";

/**
 * The panel component.
 *
 * A click anywhere on it toggles, and the widget asks for a render after the
 * change. The panel never handles a key: `/review-panel` is the keyboard path,
 * because regular-mode terminals keep mouse input to themselves.
 */
export class ReviewPanel implements Component {
	private expanded = false;
	private model: PanelModel;
	private readonly theme: PanelTheme;
	private readonly requestRender: () => void;

	// Plain fields, not parameter properties: Pi loads extensions with
	// `--experimental-strip-types`, which cannot erase a parameter property.
	constructor(model: PanelModel, theme: PanelTheme, requestRender: () => void) {
		this.model = model;
		this.theme = theme;
		this.requestRender = requestRender;
	}

	/** Replace what the panel shows, folded again. */
	set(model: PanelModel): void {
		this.model = model;
		this.expanded = false;
		this.requestRender();
	}

	/** Fold or unfold without a mouse. Returns true when unfolded. */
	toggle(): boolean {
		this.expanded = !this.expanded;
		this.requestRender();
		return this.expanded;
	}

	get isExpanded(): boolean {
		return this.expanded;
	}

	render(width: number): string[] {
		const head = this.theme.fg("accent", this.expanded ? UNFOLDED : FOLDED) + this.model.line;
		const lines = [truncateToWidth(head, width)];
		if (!this.expanded) return lines;
		const all = this.model.text.split("\n");
		const shown = all.slice(0, PANEL_LINES - lines.length);
		for (const line of shown) lines.push(truncateToWidth(line === "" ? " " : line, width));
		// The cap is not a silent cut: the last row says what is left.
		const remaining = all.length - shown.length;
		if (remaining > 0 && lines.length > 1) {
			lines[lines.length - 1] = truncateToWidth(
				this.theme.fg("dim", `… ${remaining} more line${remaining === 1 ? "" : "s"} (ctrl+o on the transcript row)`),
				width,
			);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.toggle();
		return { handled: true };
	}

	invalidate(): void {}
}
