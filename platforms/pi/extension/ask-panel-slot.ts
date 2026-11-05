/**
 * One exclusive slot for the permission ask panel.
 *
 * The root ask and the queued child ask each push their own overlay, and the
 * child queue serialises child against child only. Without this slot a root ask
 * and a child ask can mount together, and one panel covers the other. An ask
 * waits here before it mounts, so only one ask panel is live on the terminal.
 *
 * The slot holds no timer. A waiter keeps its own deadline, so a wait can never
 * outlast the ask that waits.
 */

/** Hands the slot to the next ask. Safe to call more than once. */
export type AskPanelRelease = () => void;

/** A first-in-first-out queue of asks behind one held slot. */
export class AskPanelSlot {
	private held = false;
	private generation = 0;
	private readonly waiters: Array<() => void> = [];

	/** True while one ask holds the slot, so no second panel can mount. */
	get busy(): boolean {
		return this.held;
	}

	/** How many asks wait for the slot. */
	get pending(): number {
		return this.waiters.length;
	}

	/**
	 * Wait for the free slot, then take it. Waits resolve in arrival order.
	 * Resolves with the release, which is idempotent: call it in a finally block
	 * so a throw, a deny, a cancel, or a timeout still frees the slot.
	 */
	async acquire(): Promise<AskPanelRelease> {
		const generation = this.generation;
		const release = this.lease(generation);
		if (!this.held) {
			this.held = true;
			return release;
		}
		await new Promise<void>((wake) => {
			this.waiters.push(wake);
		});
		// The releaser handed the slot to this waiter, so it stays held here.
		return release;
	}

	/**
	 * Drop the held slot and wake the waiters. Test teardown only: a live panel
	 * is the one holder that can never be waited for in a test. The wake lets a
	 * parked mount unwind through its own finally instead of hanging forever.
	 * That unwind holds only when the waited head is already settled; after a
	 * reset a woken waiter can mount without the slot.
	 */
	reset(): void {
		// A new generation makes every lease from before the reset stale, so a
		// late release cannot free a slot that a later ask holds.
		this.generation += 1;
		this.held = false;
		const waiters = this.waiters.splice(0);
		for (const wake of waiters) wake();
	}

	/** One release, guarded so a second call cannot free a later ask. */
	private lease(generation: number): AskPanelRelease {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.handOver(generation);
		};
	}

	/** Give the slot to the oldest waiter, or free it when none waits. */
	private handOver(generation: number): void {
		// A lease stamped before a reset must not touch the current holder.
		if (generation !== this.generation) return;
		const wake = this.waiters.shift();
		if (wake) {
			wake();
			return;
		}
		this.held = false;
	}
}

/** The one slot both ask paths share: one terminal, one panel. */
export const askPanelSlot = new AskPanelSlot();
