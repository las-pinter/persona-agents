/**
 * The one-line agent list text: a slice of agents and a remainder count.
 *
 * An agent is presented by three fields only, so the module takes no import
 * from agent discovery.
 */

/** The agent fields the list text reads. */
export interface AgentListEntry {
	name: string;
	source: string;
	description: string;
}

export function formatAgentList(agents: AgentListEntry[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
