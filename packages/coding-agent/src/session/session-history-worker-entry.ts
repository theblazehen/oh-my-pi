import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { scanSessionHistoryHotWindow } from "./session-history-worker";
import type {
	SessionHistoryWorkerError,
	SessionHistoryWorkerInbound,
	SessionHistoryWorkerOutbound,
} from "./session-history-worker-protocol";

function serializeError(error: unknown): SessionHistoryWorkerError {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return {
		name: "Error",
		message: String(error),
	};
}

function requestId(message: unknown): string {
	if (typeof message !== "object" || message === null || !("id" in message)) return "unknown";
	return typeof message.id === "string" ? message.id : "unknown";
}

async function handleRequest(message: unknown): Promise<SessionHistoryWorkerOutbound> {
	const id = requestId(message);
	try {
		if (typeof message !== "object" || message === null || !("type" in message)) {
			throw new Error("session-history-worker: malformed request");
		}
		const request = message as SessionHistoryWorkerInbound;
		if (request.type === "ping") return { type: "pong", id: request.id };
		if (request.type === "scan") {
			const result = await scanSessionHistoryHotWindow(request.filePath, request.limits);
			return { type: "result", id: request.id, result };
		}
		throw new Error(`session-history-worker: unknown request type ${String(message.type)}`);
	} catch (error) {
		return { type: "error", id, error: serializeError(error) };
	}
}

/** Bind the disposable worker's single request and close it after one response. */
export function startSessionHistoryWorker(): void {
	if (!parentPort) throw new Error("session-history-worker-entry: missing parentPort");

	const port = parentPort;
	const inbox = consumeWorkerInbox();
	let handled = false;
	let unbind = (): void => {};
	const onMessage = (message: unknown): void => {
		if (handled) return;
		handled = true;
		void handleRequest(message).then(response => {
			port.postMessage(response);
			unbind();
			port.close();
		});
	};

	if (inbox) {
		unbind = inbox.bind(onMessage);
	} else {
		port.on("message", onMessage);
		unbind = () => port.off("message", onMessage);
	}
}

// Bun workers report `import.meta.main === false`. A source/test embedding has
// no shared CLI host selector, so the direct worker-module fallback starts here.
if (!Bun.isMainThread && !process.argv.some(isWorkerHostSelector) && import.meta.path === Bun.main) {
	startSessionHistoryWorker();
}
