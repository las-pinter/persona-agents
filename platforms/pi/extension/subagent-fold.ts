/**
 * Child event folding: one session event into the running result.
 *
 * The runner subscribes once per child and folds every event here. A child
 * writes no stdout, so the folded message list is the run's only record.
 *
 * No pi runtime import: the event shape is read structurally, so a test needs
 * no session.
 */

import type { Message } from "@earendil-works/pi-ai";
import { type ThinkingEventType, isThinkingEventType } from "./subagent-thinking.ts";
import type { SingleResult } from "./subagent-result.ts";

/**
 * Fold one child session event into the running result. Returns the bytes the
 * event would have written, which the tree log reports as output size.
 */
export function foldEvent(
	event: unknown,
	result: SingleResult,
	count: (event: unknown) => void,
	onThinkingEvent: (eventType: ThinkingEventType) => void,
	onMessage: () => void,
): number {
	const typed = event as { type?: string; message?: Message; assistantMessageEvent?: { type?: string } };
	count(event);
	if (typed.type === "message_update" && typed.assistantMessageEvent?.type) {
		if (isThinkingEventType(typed.assistantMessageEvent.type)) onThinkingEvent(typed.assistantMessageEvent.type);
	}
	if (typed.type !== "message_end" || !typed.message) return 0;
	const msg = typed.message;
	result.messages.push(msg);
	if (msg.role === "assistant") {
		result.usage.turns++;
		const usage = msg.usage;
		if (usage) {
			result.usage.input += usage.input || 0;
			result.usage.output += usage.output || 0;
			result.usage.cacheRead += usage.cacheRead || 0;
			result.usage.cacheWrite += usage.cacheWrite || 0;
			result.usage.cost += usage.cost?.total || 0;
			result.usage.contextTokens = usage.totalTokens || 0;
			if (typeof usage.reasoning === "number") {
				result.reasoningTokens = (result.reasoningTokens ?? 0) + usage.reasoning;
			}
		}
		if (!result.model && msg.model) result.model = msg.model;
		if (msg.stopReason) result.stopReason = msg.stopReason;
		if (msg.errorMessage) result.errorMessage = msg.errorMessage;
	}
	onMessage();
	// The byte count stands in for the stdout a separate child used to write.
	return Buffer.byteLength(JSON.stringify(typed), "utf8");
}
