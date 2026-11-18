/**
 * The Pi extension API surface this package uses, mirrored for type checking.
 *
 * Pi supplies the real `@earendil-works/pi-coding-agent` module at runtime; this
 * declaration only covers the members the wiring calls, so a renamed event or a
 * changed option fails `npm run typecheck` instead of failing silently in a
 * session. Keep it in step with the Pi release the package targets.
 */

declare module "@earendil-works/pi-coding-agent" {
	export type UiLevel = "info" | "warning" | "error";

	export interface ResolvedRequestAuth {
		apiKey?: string;
		headers?: Record<string, string>;
	}

	export interface ModelInfo {
		contextWindow?: number;
		id?: string;
		provider?: string;
	}

	export interface EntryLike {
		type?: string;
		message?: { role?: string; content?: unknown };
		customType?: string;
		data?: unknown;
	}

	export interface CompactionResult {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		usage?: unknown;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		isProjectTrusted(): boolean;
		isIdle(): boolean;
		model?: ModelInfo;
		thinkingLevel: string;
		modelRegistry: {
			getApiKeyAndHeaders(model: ModelInfo): Promise<ResolvedRequestAuth>;
		};
		ui: {
			notify(text: string, level?: UiLevel): void;
			select(title: string, options: string[]): Promise<string | undefined>;
			confirm(title: string, body: string): Promise<boolean>;
			setStatus(key: string, text: string | undefined): void;
		};
		sessionManager: {
			getEntries(): EntryLike[];
			getSessionFile(): string | undefined;
		};
	}

	export interface ToolCallEvent {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}

	export interface BeforeAgentStartEvent {
		messageType: "user" | "custom";
		prompt?: string;
		systemPrompt: string;
		systemPromptOptions: {
			sections: Record<string, string>;
			promptGuidelines: string[];
		};
	}

	export interface SessionStartEvent {
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}

	export interface SessionCompactEvent {
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
	}

	export interface SessionBeforeCompactEvent {
		preparation: unknown;
		branchEntries: EntryLike[];
		customInstructions?: string;
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
		signal: AbortSignal;
	}

	export interface BlockResult {
		block: true;
		reason?: string;
	}

	export interface ExtensionAPI {
		registerFlag(name: string, options: { description: string; type: "string" | "boolean"; default?: string | boolean }): void;
		getFlag(name: string): string | boolean | undefined;
		on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown): void;
		on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown): void;
		on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => unknown): void;
		on(event: "session_before_compact", handler: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => unknown): void;
		on(event: "session_compact", handler: (event: SessionCompactEvent, ctx: ExtensionContext) => unknown): void;
		registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown }): void;
		setActiveTools(names: string[]): void;
		getActiveTools(): string[];
		sendMessage(
			message: { customType: string; content: string; display?: boolean },
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		): void;
		appendEntry(customType: string, data?: unknown): void;
	}

	/** Pi's own summarizer, used to add a focus to the compaction summary. */
	export function compact(
		preparation: unknown,
		model: ModelInfo,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions?: string,
		signal?: AbortSignal,
		thinkingLevel?: string,
	): Promise<CompactionResult>;
}
