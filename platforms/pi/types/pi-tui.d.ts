/**
 * The `@earendil-works/pi-tui` surface this package uses, mirrored for type
 * checking.
 *
 * Pi supplies the real module at runtime; this declaration covers only the
 * members the wiring and the panel call, so a renamed component or a changed
 * signature fails `npm run typecheck` on a clean install, not in a session.
 * Keep it in step with the Pi release the package targets, alongside
 * `pi-api.d.ts`.
 */

declare module "@earendil-works/pi-tui" {
	/** A normalized mouse event a component may receive. */
	export interface TuiMouseEvent {
		type: "press" | "release" | "move" | "drag" | "click" | "wheel";
		button: "left" | "middle" | "right" | "none";
		/** Coordinates local to the receiving component. */
		x: number;
		y: number;
		/** Absolute terminal coordinates. */
		screenX: number;
		screenY: number;
		/** Current component bounds. */
		width: number;
		height: number;
		shift: boolean;
		alt: boolean;
		ctrl: boolean;
		/** Logical lines. Negative values scroll up. */
		wheelDelta?: number;
		/** Consecutive click count when type is click. */
		clickCount?: number;
	}

	/** What a component returns for a mouse event. */
	export interface TuiMouseEventResult {
		handled?: boolean;
		capture?: boolean;
		focus?: boolean;
		/** True requests a render, false suppresses one. */
		render?: boolean;
	}

	/** What dispatchMouseEvent returns from a nested component. */
	export interface TuiMouseDispatchResult extends TuiMouseEventResult {
		target?: unknown;
	}

	/** A renderable component. */
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
		handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
		handleInput?(data: string): void;
		wantsKeyRelease?: boolean;
		capturesViewportInput?: boolean;
	}

	/** Plain text, wrapped to the given width. */
	export class Text implements Component {
		constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
		setText(text: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	/** Adds mouse handling to an existing component without changing its render. */
	export class MouseRegion implements Component {
		constructor(child: Component, onMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined);
		render(width: number): string[];
		invalidate(): void;
	}

	/** Visible terminal columns, ignoring ANSI escapes and wide characters. */
	export function visibleWidth(text: string): number;

	/** Cut text to a maximum terminal width. */
	export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
}
