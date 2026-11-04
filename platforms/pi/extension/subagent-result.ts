/**
 * Subagent run results.
 *
 * Result types plus the output, usage, and truncation helpers shared by the
 * child runner and the tool renderer.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { InspectTask } from "./inspector.ts";
import type { AgentScope } from "./resolver.ts";
import { formatTokens } from "./duration.ts";
import type { ThinkingState } from "./subagent-thinking.ts";
import { cappedTurnText } from "./turn-cap.ts";

/** Tunable budget for the chain `{previous}` substitution, not yet settings-backed. */
const CHAIN_PREVIOUS_CAP = 24 * 1024;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** The abort text an aborted run carries. A capped run's cap line already says it. */
export const ABORT_TEXT = "Subagent was aborted";

/**
 * The abort texts a provider returns when the run is cut. A capped run maps each
 * to ABORT_TEXT. The check is exact, so a real error is never swallowed.
 */
const ABORT_TEXTS: ReadonlySet<string> = new Set([
	ABORT_TEXT,
	"Request was aborted",
	"The operation was aborted",
	"This operation was aborted",
	"The operation was aborted.",
	"The user aborted a request.",
	"signal is aborted without reason",
	"AbortError",
]);

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "package" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/** The turn cap in force for the run, read from the call. */
	maxTurns?: number;
	/** True when the cap ended the run by aborting it after the grace turns. */
	turnsCapped?: boolean;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Wall-clock start of the run, used for the live elapsed header. */
	runStartedAt?: number;
	/** Per-run thinking timing. Absent until the child reports thinking. */
	thinking?: ThinkingState;
	/** Reasoning tokens summed over the run's assistant turns, when the provider reports them. */
	reasoningTokens?: number;
	/** The store session id, or null when the run used no session id. */
	session: string | null;
	/** True when the run reopened a saved session file. */
	resumed: boolean;
	/** The store round this run took: 1 when there is no session. */
	round: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** The fields that decide a failed run. `SingleResult` and `ResultTextSource` both fit. */
export interface FailureSource {
	exitCode: number;
	stopReason?: string;
}

export function isFailedResult(result: FailureSource): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** One failure result, so every refusal returns the same field set. */
export function failureResult(
	agent: string,
	agentSource: SingleResult["agentSource"],
	task: string,
	step: number | undefined,
	stderr: string,
): SingleResult {
	return {
		agent,
		agentSource,
		task,
		exitCode: 1,
		messages: [],
		stderr,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: undefined,
		stopReason: "error",
		step,
		runStartedAt: Date.now(),
		thinking: { thinking: false, thinkingStartedAt: null, thinkingMs: 0 },
		session: null,
		resumed: false,
		round: 1,
	};
}

export function toInspectTask(r: SingleResult): InspectTask {
	return {
		agent: r.agent,
		status: isFailedResult(r) ? "failed" : "done",
		task: r.task,
		exitCode: r.exitCode,
		messages: r.messages,
		stderr: r.stderr,
		usage: {
			input: r.usage.input,
			output: r.usage.output,
			cacheRead: r.usage.cacheRead,
			cacheWrite: r.usage.cacheWrite,
			cost: r.usage.cost,
			turns: r.usage.turns,
		},
		thinkingMs: r.thinking?.thinkingMs ?? 0,
		reasoningTokens: r.reasoningTokens,
		errorMessage: r.errorMessage,
		turnsCapped: r.turnsCapped,
		maxTurns: r.maxTurns,
	};
}

/** The fields the run-text rule reads. `SingleResult` and `InspectTask` both fit. */
export interface ResultTextSource {
	messages: Message[];
	exitCode: number;
	stderr?: string;
	stopReason?: string;
	errorMessage?: string;
	turnsCapped?: boolean;
	maxTurns?: number;
	usage?: { turns?: number };
}

/** One run's text, decided in one place. */
export interface ResultText {
	/** The cap line, empty when the cap did not end the run. */
	capLine: string;
	/** The run's work, or its error text when it failed below the cap. */
	body: string;
	/** The error line text, or null when the surface shows no error line. */
	error: string | null;
}

/** The final assistant text, or the no-output marker. */
function outputText(messages: Message[]): string {
	return getFinalOutput(messages) || "(no output)";
}

/**
 * The one rule for a run's text. The cap line shows when and only when the cap
 * ended the run. The error line shows for any error, except the cap's own abort
 * text, because the cap line already carries it. A run that failed below the cap
 * keeps its error text and shows no cap line.
 */
export function resultText(source: ResultTextSource): ResultText {
	const capped = source.turnsCapped === true;
	const capLine = capped ? cappedTurnText(source.usage?.turns, source.maxTurns) : "";
	const errorMessage = source.errorMessage ?? null;
	// A capped run's abort text is the cap's own, so the cap line carries it instead.
	const error = capped && errorMessage !== null && ABORT_TEXTS.has(errorMessage) ? null : errorMessage;
	// A failure below the cap carries its reason as its body, so it shows once.
	const body = !capped && isFailedResult(source)
		? error || source.stderr || outputText(source.messages)
		: outputText(source.messages);
	return { capLine, body, error };
}

/**
 * The error line text, or null when the body already carries it. Both renderers
 * call this, so one rule decides the error line.
 */
export function errorLine(text: ResultText): string | null {
	return text.error !== null && text.error !== text.body ? text.error : null;
}

/** The cap line then the body: the run text a surface prints in one block. */
export function resultBodyBlock(source: ResultTextSource): string {
	const text = resultText(source);
	return text.capLine ? `${text.capLine}\n\n${text.body}` : text.body;
}

/** The cap line, the body, then the error line when the body does not carry it. */
export function resultTextBlock(source: ResultTextSource): string {
	const text = resultText(source);
	const parts = text.capLine ? [text.capLine, text.body] : [text.body];
	// A failure below the cap already carries its reason as its body.
	const line = errorLine(text);
	if (line) parts.push(line);
	return parts.join("\n\n");
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

/** Byte-safe truncation of the chain `{previous}` output so a giant prior step
 * cannot blow up the next spawn's prompt. Preserves behavior for normal sizes. */
export function truncateChainPrevious(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= CHAIN_PREVIOUS_CAP) return output;

	let truncated = output.slice(0, CHAIN_PREVIOUS_CAP);
	while (Buffer.byteLength(truncated, "utf8") > CHAIN_PREVIOUS_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Previous output truncated: ${Math.ceil((byteLength - Buffer.byteLength(truncated, "utf8")) / 1024)} KiB omitted — only the head was passed to the next chain step.]`;
}
