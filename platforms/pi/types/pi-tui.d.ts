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
	/** A renderable component. */
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
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

	/** Visible terminal columns, ignoring ANSI escapes and wide characters. */
	export function visibleWidth(text: string): number;

	/** Cut text to a maximum terminal width. */
	export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
}
