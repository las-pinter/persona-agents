/**
 * Live subagent status panel.
 *
 * The subagent tool reports every task start / update / completion here, and
 * the panel renders a persistent widget below the editor (the closest
 * "sidebar" the extension API offers without patching pi's core layout):
 *
 *   ┌ subagents ─────────────────────────────────────────────┐
 *   │ ⏳ orchestrator·scout   [parallel] "grep for the config"│
 *   │ ✓ orchestrator·worker   [parallel] "implement the hook"│  ↑1.2k ↓8.4k $0.01
 *   │ ✗ orchestrator·reviewer [parallel] "review diff"        │
 *   └───────────────────────── 2 running · 1 done · 1 failed ┘
 *
 * A compact summary also goes to the footer via setStatus, so progress is
 * visible even when the widget is collapsed by the user's layout.
 */

export interface PanelTask {
	key: string;
	agent: string;
	mode: string;
	status: "running" | "done" | "failed";
	preview: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
	error?: string;
}

/** Minimal structural type: matches the ui surface we use. */
export interface PanelUi {
	setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	setStatus(key: string, text: string | undefined): void;
}

const WIDGET_KEY = "agent-stack-panel";
const STATUS_KEY = "agent-stack-panel";

let uiHandle: PanelUi | undefined;
let tasks = new Map<string, PanelTask>();
let taskOrder: string[] = [];
let lastRenderAt = 0;

export function bindPanelUi(ui: PanelUi | undefined): void {
	uiHandle = ui;
	render();
}

export function panelStart(task: PanelTask): void {
	if (!tasks.has(task.key)) taskOrder.push(task.key);
	tasks.set(task.key, task);
	render();
}

export function panelUpdate(key: string, partial: Partial<PanelTask>): void {
	const t = tasks.get(key);
	if (!t) return;
	Object.assign(t, partial);
	render();
}

export function panelFinish(key: string, status: "done" | "failed", partial: Partial<PanelTask> = {}): void {
	panelUpdate(key, { ...partial, status });
}

/** Remove finished entries shown for a previous run; keep this run's summary. */
export function panelResetRunning(): void {
	for (const key of taskOrder) {
		const t = tasks.get(key);
		if (t?.status === "running") tasks.delete(key);
	}
	render();
}

export function panelClear(): void {
	tasks.clear();
	taskOrder = [];
	uiHandle?.setWidget(WIDGET_KEY, undefined);
	uiHandle?.setStatus(STATUS_KEY, undefined);
}

export function panelDescribe(): string {
	if (tasks.size === 0) return "No subagent activity recorded.";
	const lines: string[] = [];
	for (const key of taskOrder) {
		const t = tasks.get(key);
		if (t) lines.push(formatTaskLine(t));
	}
	const counts = { running: 0, done: 0, failed: 0 };
	for (const t of tasks.values()) counts[t.status]++;
	lines.push(`— ${counts.running} running · ${counts.done} done · ${counts.failed} failed`);
	return lines.join("\n");
}

function formatTokens(n: number | undefined): string {
	if (!n || n <= 0) return "";
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatTaskLine(t: PanelTask): string {
	const icon = t.status === "running" ? "⏳" : t.status === "done" ? "✓" : "✗";
	const preview = t.preview.length > 48 ? `${t.preview.slice(0, 48)}…` : t.preview;
	const usage: string[] = [];
	if (t.inputTokens) usage.push(`↑${formatTokens(t.inputTokens)}`);
	if (t.outputTokens) usage.push(`↓${formatTokens(t.outputTokens)}`);
	if (t.cost) usage.push(`$${t.cost.toFixed(4)}`);
	const usageStr = usage.length > 0 ? `  ${usage.join(" ")}` : "";
	const err = t.status === "failed" && t.error ? ` — ${t.error.slice(0, 60)}` : "";
	return `${icon} ${t.agent}  [${t.mode}] ${preview}${err}${usageStr}`;
}

function render(): void {
	const now = Date.now();
	if (now - lastRenderAt < 80) return; // throttle live updates
	lastRenderAt = now;
	if (!uiHandle) return;

	if (tasks.size === 0) {
		uiHandle.setWidget(WIDGET_KEY, undefined);
		uiHandle.setStatus(STATUS_KEY, undefined);
		return;
	}

	const lines: string[] = [];
	for (const key of taskOrder) {
		const t = tasks.get(key);
		if (t) lines.push(formatTaskLine(t));
	}
	lines.push(""); // bottom border feel
	const counts = { running: 0, done: 0, failed: 0 };
	for (const t of tasks.values()) counts[t.status]++;
	const summary =
		counts.running > 0
			? `${counts.running} running · ${counts.done} done · ${counts.failed} failed`
			: `last run: ${counts.done} done · ${counts.failed} failed`;

	uiHandle.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
	uiHandle.setStatus(STATUS_KEY, `subagents: ${summary}`);
}