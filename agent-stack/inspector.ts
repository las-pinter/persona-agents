/**
 * Subagent run archive + full-screen inspector.
 *
 * Every completed subagent tool run is archived here (bounded). `/runs` lists
 * them; `/inspect [last|N]` opens a full-screen overlay (like opencode's
 * dedicated agent views) with the run's tasks, tool calls, final output,
 * usage, and errors. Keys: up/down + PgUp/PgDn scroll, Tab / left-right switch
 * task, q / Esc close.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";

export interface InspectTask {
	agent: string;
	status: "done" | "failed";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	errorMessage?: string;
}

export interface InspectRun {
	at: string;
	mode: "single" | "parallel" | "chain";
	agentScope: string;
	results: InspectTask[];
}

const MAX_RUNS = 12;
const runs: InspectRun[] = [];

export function archiveRun(run: InspectRun): void {
	runs.push(run);
	if (runs.length > MAX_RUNS) runs.shift();
}

export function getRuns(): InspectRun[] {
	return runs;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			for (const part of m.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function toolCalls(messages: Message[]): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const part of m.content) {
			if (part.type === "toolCall") out.push(`${part.name} ${JSON.stringify(part.arguments)}`);
		}
	}
	return out;
}

function formatUsage(u: InspectTask["usage"]): string {
	if (!u) return "";
	const parts: string[] = [];
	if (u.input) parts.push(`↑${u.input}`);
	if (u.output) parts.push(`↓${u.output}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatAt(iso: string): string {
	return iso.replace("T", " ").slice(0, 19);
}

const MAX_VIEW_LINES = 55;

class InspectorComponent {
	wantsKeyRelease = false;
	private taskIndex = 0;
	private offset = 0;
	private readonly tui: TUI;
	private readonly run: InspectRun;
	private readonly done: () => void;

	constructor(tui: TUI, run: InspectRun, done: () => void) {
		this.tui = tui;
		this.run = run;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(data, Key.down)) {
			this.offset++;
		} else if (matchesKey(data, Key.pageUp)) {
			this.offset = Math.max(0, this.offset - 15);
		} else if (matchesKey(data, Key.pageDown)) {
			this.offset += 15;
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.taskIndex = (this.taskIndex + 1) % this.run.results.length;
			this.offset = 0;
		} else if (matchesKey(data, Key.left)) {
			this.taskIndex = (this.taskIndex - 1 + this.run.results.length) % this.run.results.length;
			this.offset = 0;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const head: string[] = [];
		const push = (s: string) => head.push(s.length > width ? s.slice(0, width) : s);
		push(` SUBAGENT INSPECTOR — ${this.run.mode} · ${formatAt(this.run.at)} · scope ${this.run.agentScope}`);
		push(` ${"─".repeat(Math.min(width - 1, 96))}`);
		this.run.results.forEach((t, i) => {
			const icon = t.status === "failed" ? "✗" : "✓";
			const sel = i === this.taskIndex ? "▶" : " ";
			push(` ${sel} ${i + 1}. ${icon} ${t.agent} — ${t.task.replace(/\n/g, " ").slice(0, Math.max(10, width - 16))}`);
		});
		push(` ${"─".repeat(Math.min(width - 1, 96))}`);

		const t = this.run.results[this.taskIndex];
		const detail: string[] = [];
		detail.push(`${t.agent} [${t.status}] exit=${t.exitCode}${t.errorMessage ? " ERR " + t.errorMessage : ""}`);
		for (const c of toolCalls(t.messages)) {
			detail.push(`→ ${c.length > width - 4 ? c.slice(0, width - 4) : c}`);
		}
		const out = getFinalOutput(t.messages);
		if (out) detail.push(...out.split("\n").map((l) => ` ${l}`.slice(0, width)));
		else detail.push("(no output)");
		const usage = formatUsage(t.usage);
		if (usage) detail.push(`${usage}`);
		if (t.stderr) detail.push(`stderr: ${t.stderr.slice(0, Math.max(10, width - 10))}`);

		if (this.offset >= detail.length && detail.length > 0) {
			this.offset = Math.max(0, detail.length - MAX_VIEW_LINES);
		}
		const shown = detail.slice(this.offset, this.offset + MAX_VIEW_LINES);

		const lines = [...head, ...shown, ""];
		const nav = `${this.run.results.length > 1 ? "Tab/←/→ task · " : ""}↑/↓/PgUp/PgDn scroll · q/Esc close (line ${this.offset + 1}/${Math.max(1, detail.length)})`;
		lines.push(nav.length > width ? nav.slice(0, width) : nav);
		return lines;
	}
}

export function registerInspectorCommands(pi: ExtensionAPI): void {
	pi.registerCommand("runs", {
		description: "List archived subagent runs",
		handler: async (_args: string, ctx) => {
			const all = getRuns();
			if (all.length === 0) {
				ctx.ui?.notify?.("No subagent runs archived yet.", "info");
				return;
			}
			const lines = all
				.map((r, i) => {
					const isLast = i === all.length - 1;
					const marks = r.results.map((t) => (t.status === "failed" ? "✗" : "✓")).join("");
					return `${isLast ? "last" : "#" + (i + 1)}  ${formatAt(r.at)} ${r.mode} ${marks} ${r.results.map((t) => t.agent).join(", ")}`;
				})
				.join("\n");
			ctx.ui?.notify?.(`Archived runs:\n${lines}\n\nUse /inspect [last|N] to open.`, "info");
		},
	});

	pi.registerCommand("inspect", {
		description: "Open a subagent run in full-screen view (usage: /inspect [last|N])",
		handler: async (args: string, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui?.notify?.("Inspect requires interactive mode.", "error");
				return;
			}
			const all = getRuns();
			if (all.length === 0) {
				ctx.ui?.notify?.("No subagent runs archived yet.", "info");
				return;
			}
			const arg = args.trim();
			let idx = all.length - 1;
			if (arg && arg !== "last") {
				const n = parseInt(arg, 10);
				if (!Number.isNaN(n)) idx = Math.min(Math.max(n - 1, 0), all.length - 1);
			}
			const run = all[idx];
			await ctx.ui.custom(
				// The overlay component is duck-typed (wantsKeyRelease/handleInput/render);
				// pi's Component interface is stricter than the runtime contract here.
				(_tui, _theme, _keybindings, done) =>
					new InspectorComponent(_tui as TUI, run, () => done(undefined)) as unknown as Component,
				{
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: { top: 0 } },
				},
			);
		},
	});
}