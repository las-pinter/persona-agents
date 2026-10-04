/**
 * herdr pane-state reporter for pi.
 *
 * Sends NDJSON "pane.report_agent" and "pane.report_agent_session" requests
 * over the herdr unix socket so herdr can show the pi agent as blocked or
 * working. Mirrors the opencode courier protocol:
 *
 *   - pane.report_agent_session: params { pane_id, source, agent, seq, agent_session_id }
 *   - pane.report_agent:         params { pane_id, source, agent, seq, state, agent_session_id? }
 *
 * agent_session_id is the pi session jsonl path — the value herdr shows for
 * the pane. extension.ts captures it from ctx.sessionManager via
 * getSessionFile, with getSessionId as fallback, at session_start and
 * before_agent_start. The registration fires once per process, on the first
 * state report that has a ref (opencode re-arms on session.updated; the
 * decree fixes ours to a one-shot didRegister guard).
 *
 * Active only when HERDR_ENV is "1" and both HERDR_SOCKET_PATH and
 * HERDR_PANE_ID are set. Otherwise every call is a no-op.
 *
 * Failures are silent: connect errors, write errors, timeouts, and EPIPE are
 * swallowed. The socket is destroyed after the write. Callers can fire and
 * forget; the returned path never rejects.
 */

import net from "node:net";

const SOURCE = "herdr:pi";
const AGENT = "pi";
// Seed like the opencode courier: seq stays unique across process restarts.
let reportSeq = Date.now() * 1000;
// Serialize reports so a slow connect can never arrive behind a later one.
let chain: Promise<void> = Promise.resolve();

type AgentState = "working" | "blocked" | "idle";

// The pane's agent session ref. extension.ts refreshes it at session_start
// and before_agent_start. Undefined until the first message persists a
// session file, so getSessionFile can legitimately return undefined early.
let sessionRef: string | undefined;

// One-shot registration guard: the first state report with a ref registers.
let didRegisterSession = false;

/** Hand the pane's session ref to the courier. Silent: never throws, ignores non-string input. */
export function setAgentSessionRef(ref: string | undefined): void {
	if (typeof ref !== "string" || ref.length === 0) {
		return;
	}
	sessionRef = ref;
}

function nextReportSeq(): number {
	reportSeq += 1;
	return reportSeq;
}

function request(
	method: "pane.report_agent" | "pane.report_agent_session",
	params: Record<string, unknown>,
): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;

	// No-op unless herdr runs the pane with a live socket for it.
	if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) {
		return Promise.resolve();
	}

	const socketEndpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

	// Unique id per request; seq counts reports in send order. Mirrors the
	// opencode courier: pane_id, source, agent, and seq precede the
	// method-specific params on every wire request.
	const requestId = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
		.toString()
		.padStart(6, "0")}`;
	const request = {
		id: requestId,
		method,
		params: {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			seq: nextReportSeq(),
			...params,
		},
	};

	return new Promise<void>((resolve) => {
		// Every path ends in resolve, so this promise never rejects.
		// Callers can drop the promise without awaiting it.
		try {
			const client = net.createConnection(socketEndpoint, () => {
				try {
					client.write(`${JSON.stringify(request)}\n`);
				} catch {
					// EPIPE and similar write failures resolve via the error event too.
				}
			});

			const finish = (): void => {
				client.destroy();
				resolve();
			};

			client.setTimeout(500, finish);
			client.on("data", finish);
			client.on("error", finish);
			client.on("end", finish);
			client.on("close", resolve);
		} catch {
			resolve();
		}
	});
}

// Mirrors opencode reportSession: declares the pane's session to herdr.
function requestSessionRegistration(ref: string): Promise<void> {
	return request("pane.report_agent_session", { agent_session_id: ref });
}

// Mirrors opencode reportState: the state report carries the session ref so
// the state lands on the right pane session.
function requestState(ref: string | undefined, state: AgentState): Promise<void> {
	return request("pane.report_agent", {
		state,
		...(ref ? { agent_session_id: ref } : {}),
	});
}

export function reportAgentState(state: "blocked" | "working"): void {
	// No ref: herdr cannot bind this pane to a session. Ref discovery was
	// attempted in extension.ts — getSessionFile (jsonl path) first, then
	// getSessionId (ULID) — and both can be missing before the first message
	// persists a file. Report "idle" instead of "working" then, so a missing
	// ref can never leave the ask-gate pane blocked.
	const ref = sessionRef;
	const effective: AgentState = state === "working" && !ref ? "idle" : state;

	if (ref && !didRegisterSession) {
		// Flag first, synchronously: concurrent first reports must not
		// double-register. Registration joins the SAME chain ahead of the
		// state report, so herdr reads registration then state in order.
		didRegisterSession = true;
		chain = chain.then(() => requestSessionRegistration(ref)).catch(() => {});
	}

	// Queue the report behind the previous one; each link swallows rejection.
	chain = chain.then(() => requestState(ref, effective)).catch(() => {});
}