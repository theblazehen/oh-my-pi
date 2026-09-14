import { randomUUID } from "node:crypto";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS,
	SESSION_HISTORY_WORKER_ARG,
	type SessionHistoryHotWindow,
	type SessionHistoryHotWindowLimits,
	type SessionHistoryWorkerError,
	type SessionHistoryWorkerInbound,
	type SessionHistoryWorkerOutbound,
} from "./session-history-worker-protocol";

const DEFAULT_SCAN_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 5_000;

export interface SessionHistoryWorkerHandle {
	send(message: SessionHistoryWorkerInbound): void;
	onMessage(handler: (message: SessionHistoryWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export interface SessionHistoryWorkerOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

function workerError(error: SessionHistoryWorkerError): Error {
	const result = new Error(error.message);
	result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

function wrapWorker(worker: Worker): SessionHistoryWorkerHandle {
	return {
		send(message) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			const listener = (event: MessageEvent): void => handler(event.data as SessionHistoryWorkerOutbound);
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
		onError(handler) {
			const listener = (event: ErrorEvent): void =>
				handler(event.error instanceof Error ? event.error : new Error(event.message));
			worker.addEventListener("error", listener);
			return () => worker.removeEventListener("error", listener);
		},
		async terminate() {
			const closed = Promise.withResolvers<void>();
			const onClose = (): void => closed.resolve();
			worker.addEventListener("close", onClose);
			worker.terminate();
			await Promise.race([closed.promise, Bun.sleep(1_000)]);
			worker.removeEventListener("close", onClose);
		},
	};
}

/** Spawn through the packaged CLI host, with a direct module fallback for source/tests. */
export function spawnSessionHistoryWorker(): SessionHistoryWorkerHandle {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [SESSION_HISTORY_WORKER_ARG] })
		: new Worker(new URL("./session-history-worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapWorker(worker);
}

async function requestWorker(
	request: SessionHistoryWorkerInbound,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SessionHistoryWorkerOutbound> {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");

	const worker = spawnSessionHistoryWorker();
	const response = Promise.withResolvers<SessionHistoryWorkerOutbound>();
	const expectedType = request.type === "ping" ? "pong" : "result";
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.id !== request.id) return;
		if (message.type === "error") {
			response.reject(workerError(message.error));
			return;
		}
		if (message.type !== expectedType) {
			response.reject(new Error(`session-history-worker: expected ${expectedType}, received ${message.type}`));
			return;
		}
		response.resolve(message);
	});
	const unsubscribeError = worker.onError(error => response.reject(error));

	try {
		worker.send(request);
		return await withTimeout(
			response.promise,
			timeoutMs,
			`session-history-worker: ${request.type} timed out after ${timeoutMs}ms`,
			signal,
		);
	} finally {
		unsubscribeMessage();
		unsubscribeError();
		await worker.terminate();
		// Bun workers share the process allocator. A full-journal scan can leave
		// hundreds of MiB of now-dead worker pages resident until the next major
		// collection, defeating the bounded handoff even though the long-lived JS
		// graph contains only the hot window. Reclaim at this explicit isolation
		// boundary; scans are cold-start operations, never an append hot path.
		if (request.type === "scan") {
			// Worker teardown publishes allocator pages asynchronously. Give the
			// release turn a chance to complete before asking mimalloc/JSC to trim.
			await Bun.sleep(500);
			Bun.gc(true);
		}
	}
}

/** Load a bounded, migrated hot window without retaining the full journal in this process. */
export async function loadSessionHistoryHotWindow(
	filePath: string,
	limits: SessionHistoryHotWindowLimits = DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS,
	options: SessionHistoryWorkerOptions = {},
): Promise<SessionHistoryHotWindow> {
	const response = await requestWorker(
		{ type: "scan", id: randomUUID(), filePath, limits },
		options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
		options.signal,
	);
	if (response.type !== "result") throw new Error("session-history-worker: scan returned no result");
	return response.result;
}

/** Distribution smoke probe for selector dispatch and the direct worker protocol. */
export async function smokeTestSessionHistoryWorker(): Promise<void> {
	const response = await requestWorker({ type: "ping", id: randomUUID() }, SMOKE_TIMEOUT_MS);
	if (response.type !== "pong") throw new Error("session-history-worker smoke failed: no pong");
}
