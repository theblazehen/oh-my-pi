/**
 * Per-model admission control for providers that sell a fixed number of
 * concurrent slots (e.g. "4 parallel requests per model").
 *
 * Without it every caller races the provider for a slot and the losers get an
 * immediate 429, which the gateway then reads as a rate limit and blocks the
 * credential for everyone. With it, requests beyond the limit wait here in
 * arrival order and are admitted the moment a slot frees; a request that waits
 * longer than the queue timeout is shed with the same `max_parallel_requests`
 * 429 LiteLLM uses, which omp clients hand straight to turn-level backoff.
 *
 * Slots are keyed by `provider/model id`: providers that sell slots sell them
 * per model.
 */
import type { Api, Model } from "../types";

/** Waiting longer than this sheds the request; well inside clients' first-event watchdogs. */
export const DEFAULT_GATEWAY_QUEUE_TIMEOUT_MS = 120_000;

/** Why a request was not admitted. */
export type GatewayAdmissionRejection = "queue_timeout" | "aborted";

/** Frees the slot; safe to call more than once. */
export type GatewaySlotRelease = () => void;

interface Waiter {
	grant: (release: GatewaySlotRelease) => void;
	/** `Date.now()` when the request joined the queue. */
	readonly since: number;
}

interface Pool {
	readonly limit: number;
	active: number;
	readonly waiters: Waiter[];
}

/** One `provider/model` pool as `GET /v1/concurrency` reports it. */
export interface GatewayConcurrencyPoolSnapshot {
	limit: number;
	active: number;
	waiting: number;
	/** How long the oldest queued request has waited; 0 with an empty queue. */
	oldestWaitMs: number;
}

/**
 * Parse `--concurrency` entries: comma-separated `provider=limit` pairs, e.g.
 * `ratecloud=4,arliai=2`. Each limit applies per model of that provider.
 */
export function parseGatewayConcurrencyLimits(spec: string): Map<string, number> {
	const limits = new Map<string, number>();
	for (const entry of spec.split(",")) {
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		const separator = trimmed.lastIndexOf("=");
		const provider = separator > 0 ? trimmed.slice(0, separator).trim() : "";
		const raw = separator > 0 ? trimmed.slice(separator + 1).trim() : "";
		const limit = Number(raw);
		if (provider.length === 0 || !/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) {
			throw new Error(`Invalid --concurrency entry "${trimmed}": expected provider=<positive integer>`);
		}
		limits.set(provider, limit);
	}
	return limits;
}

export class GatewayConcurrencyLimiter {
	readonly #limits: ReadonlyMap<string, number>;
	readonly #queueTimeoutMs: number;
	readonly #pools = new Map<string, Pool>();

	constructor(limits: ReadonlyMap<string, number>, queueTimeoutMs = DEFAULT_GATEWAY_QUEUE_TIMEOUT_MS) {
		this.#limits = limits;
		this.#queueTimeoutMs = queueTimeoutMs;
	}

	/**
	 * Take a slot for `model`, waiting in arrival order when all are busy.
	 * Resolves to a release function (a no-op for unlimited providers) or the
	 * reason the request was turned away.
	 */
	acquire(model: Model<Api>, signal: AbortSignal): Promise<GatewaySlotRelease | GatewayAdmissionRejection> {
		const limit = this.#limits.get(model.provider);
		if (limit === undefined) return Promise.resolve(noopRelease);
		if (signal.aborted) return Promise.resolve("aborted");
		const key = `${model.provider}/${model.id}`;
		let pool = this.#pools.get(key);
		if (!pool) {
			pool = { limit, active: 0, waiters: [] };
			this.#pools.set(key, pool);
		}
		if (pool.active < limit) {
			pool.active++;
			return Promise.resolve(this.#releaser(key, pool));
		}
		const queue = pool;
		const { promise, resolve } = Promise.withResolvers<GatewaySlotRelease | GatewayAdmissionRejection>();
		const leave = (reason: GatewayAdmissionRejection): void => {
			const index = queue.waiters.indexOf(waiter);
			if (index === -1) return;
			queue.waiters.splice(index, 1);
			cleanup();
			resolve(reason);
		};
		const onAbort = (): void => leave("aborted");
		const timer = setTimeout(() => leave("queue_timeout"), this.#queueTimeoutMs);
		const cleanup = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const waiter: Waiter = {
			since: Date.now(),
			grant: release => {
				cleanup();
				resolve(release);
			},
		};
		queue.waiters.push(waiter);
		signal.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	/** Configured slots per model, keyed by provider. */
	get limits(): ReadonlyMap<string, number> {
		return this.#limits;
	}

	/** Pools with requests running or queued, per `provider/model`; idle pools are absent. */
	snapshot(now = Date.now()): Map<string, GatewayConcurrencyPoolSnapshot> {
		const out = new Map<string, GatewayConcurrencyPoolSnapshot>();
		for (const [key, pool] of this.#pools) {
			const oldest = pool.waiters[0];
			out.set(key, {
				limit: pool.limit,
				active: pool.active,
				waiting: pool.waiters.length,
				oldestWaitMs: oldest ? now - oldest.since : 0,
			});
		}
		return out;
	}

	#releaser(key: string, pool: Pool): GatewaySlotRelease {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// Hand the slot straight to the oldest waiter so a newcomer can't
			// overtake the queue between this release and the waiter waking.
			const next = pool.waiters.shift();
			if (next) {
				next.grant(this.#releaser(key, pool));
				return;
			}
			pool.active--;
			if (pool.active === 0) this.#pools.delete(key);
		};
	}
}

const noopRelease: GatewaySlotRelease = () => {};
