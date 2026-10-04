/**
 * herdr pane-state reporter for pi.
 *
 * Sends one NDJSON "pane.report_agent" request over the herdr unix socket so
 * herdr can show the pi agent as blocked or working. Mirrors the opencode
 * courier protocol: params { pane_id, source, agent, seq, state }.
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

function nextReportSeq(): number {
	reportSeq += 1;
	return reportSeq;
}

function request(state: "blocked" | "working"): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;

	// No-op unless herdr runs the pane with a live socket for it.
	if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) {
		return Promise.resolve();
	}

	const socketEndpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

	// Unique id per request; seq counts reports in send order.
	const requestId = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
		.toString()
		.padStart(6, "0")}`;
	const request = {
		id: requestId,
		method: "pane.report_agent",
		params: {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			seq: nextReportSeq(),
			state,
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

export function reportAgentState(state: "blocked" | "working"): void {
	// Queue the report behind the previous one; each link swallows rejection.
	chain = chain.then(() => request(state)).catch(() => {});
}