/**
 * Shared fakes for the sidebar and tree-overlay test harnesses.
 *
 * The terminal and the tui imitate the pi surfaces that `sidebar.ts` touches.
 * Each counter increments before its wrapped call runs, so a paint that is
 * attempted and then throws still counts.
 */

import type { SidebarTerminal } from "./sidebar.ts";

/** A terminal that records every write. */
export interface FakeTerminal extends SidebarTerminal {
	writes: string[];
}

/** A fake pi tui: a fake terminal plus both paint entry points. */
export interface FakeTui {
	terminal: FakeTerminal;
	/** Counts the `doRender` paint path alone. */
	doRenderCalls: number;
	/** Counts the `requestRender` paint path alone. */
	requestRenderCalls: number;
	doRender(...args: unknown[]): void;
	requestRender(): void;
}

/** The sum of both paint paths; use it when any paint satisfies the check. */
export function paintCalls(tui: FakeTui): number {
	return tui.doRenderCalls + tui.requestRenderCalls;
}

/** Set both paint counters to zero before one action. */
export function resetPaints(tui: FakeTui): void {
	tui.doRenderCalls = 0;
	tui.requestRenderCalls = 0;
}

/** A terminal whose raw column count can change, like a real resize. */
export interface ResizableTerminal extends FakeTerminal {
	resize(columns: number): void;
}

/** Build a fake terminal with a fixed size. */
export function makeTerminal(columns = 100, rows = 30): FakeTerminal {
	const writes: string[] = [];
	return {
		columns,
		rows,
		writes,
		write(data: string): void {
			writes.push(data);
		},
	};
}

/** Build a fake terminal whose raw column count can change. */
export function makeResizableTerminal(columns: number, rows = 30): ResizableTerminal {
	let raw = columns;
	const writes: string[] = [];
	return {
		rows,
		writes,
		get columns(): number {
			return raw;
		},
		set columns(value: number) {
			raw = value;
		},
		write(data: string): void {
			writes.push(data);
		},
		resize(next: number): void {
			raw = next;
		},
	};
}

/**
 * Build a fake tui.
 *
 * `doRender` and `requestRender` are own properties of the returned object,
 * because the sidebar disposer restores `doRender` with an own-property
 * descriptor and `delete`. `render` is the body pi would run inside the frame.
 */
export function makeTui(terminal: FakeTerminal, render?: (...args: unknown[]) => void): FakeTui {
	const tui: FakeTui = {
		terminal,
		doRenderCalls: 0,
		requestRenderCalls: 0,
		doRender(...args: unknown[]): void {
			tui.doRenderCalls += 1;
			if (render) render(...args);
		},
		requestRender(): void {
			tui.requestRenderCalls += 1;
		},
	};
	return tui;
}
