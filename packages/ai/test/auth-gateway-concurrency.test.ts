import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	GatewayConcurrencyLimiter,
	parseGatewayConcurrencyLimits,
	parseGatewayQueueTimeout,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

describe("GatewayConcurrencyLimiter", () => {
	const model = createMockModel({ provider: "ratecloud", id: "flash" }).model;

	it("admits waiters in arrival order and never exceeds the limit", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["ratecloud", 2]]));
		const signal = new AbortController().signal;
		const first = await limiter.acquire(model, signal);
		const second = await limiter.acquire(model, signal);
		const admitted: string[] = [];
		const third = limiter.acquire(model, signal).then(r => (admitted.push("third"), r));
		const fourth = limiter.acquire(model, signal).then(r => (admitted.push("fourth"), r));
		expect(limiter.snapshot().get("ratecloud/flash")).toMatchObject({ limit: 2, active: 2, waiting: 2 });

		if (typeof first !== "function" || typeof second !== "function") throw new Error("expected slots");
		first();
		first(); // a second release of the same slot must not free another
		const thirdRelease = await third;
		expect(admitted).toEqual(["third"]);
		expect(limiter.snapshot().get("ratecloud/flash")).toMatchObject({ active: 2, waiting: 1 });

		second();
		const fourthRelease = await fourth;
		expect(admitted).toEqual(["third", "fourth"]);
		if (typeof thirdRelease !== "function" || typeof fourthRelease !== "function") throw new Error("expected slots");
		thirdRelease();
		fourthRelease();
		expect(limiter.snapshot().size).toBe(0);
	});

	it("drops an aborted waiter so the next waiter gets the freed slot", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["ratecloud", 1]]));
		const held = await limiter.acquire(model, new AbortController().signal);
		const gone = new AbortController();
		const abandoned = limiter.acquire(model, gone.signal);
		const next = limiter.acquire(model, new AbortController().signal);
		gone.abort();
		expect(await abandoned).toBe("aborted");
		if (typeof held !== "function") throw new Error("expected slot");
		held();
		expect(typeof (await next)).toBe("function");
		expect(limiter.snapshot().get("ratecloud/flash")).toMatchObject({ active: 1, waiting: 0, oldestWaitMs: 0 });
	});

	it("sheds a waiter after the queue timeout without taking a slot", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["ratecloud", 1]]), 20);
		await limiter.acquire(model, new AbortController().signal);
		expect(await limiter.acquire(model, new AbortController().signal)).toBe("queue_timeout");
		expect(limiter.snapshot().get("ratecloud/flash")).toMatchObject({ active: 1, waiting: 0 });
	});

	it("keeps separate pools per model and leaves unlisted providers unlimited", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["ratecloud", 1]]));
		const signal = new AbortController().signal;
		const other = createMockModel({ provider: "ratecloud", id: "glm" }).model;
		const unlisted = createMockModel({ provider: "openrouter", id: "flash" }).model;
		expect(typeof (await limiter.acquire(model, signal))).toBe("function");
		expect(typeof (await limiter.acquire(other, signal))).toBe("function");
		for (let i = 0; i < 5; i++) expect(typeof (await limiter.acquire(unlisted, signal))).toBe("function");
	});

	it("rejects malformed --concurrency entries", () => {
		expect(parseGatewayConcurrencyLimits("ratecloud=4, arliai=2")).toEqual(
			new Map([
				["ratecloud", 4],
				["arliai", 2],
			]),
		);
		expect(() => parseGatewayConcurrencyLimits("ratecloud=0")).toThrow();
		expect(() => parseGatewayConcurrencyLimits("ratecloud=1.5")).toThrow();
		expect(() => parseGatewayConcurrencyLimits("=4")).toThrow();
	});

	it("accepts --queue-timeout only as whole seconds the open socket survives", () => {
		expect(parseGatewayQueueTimeout("240")).toBe(240_000);
		expect(parseGatewayQueueTimeout("250")).toBe(250_000);
		expect(() => parseGatewayQueueTimeout("251")).toThrow();
		expect(() => parseGatewayQueueTimeout("0")).toThrow();
		expect(() => parseGatewayQueueTimeout("1.5")).toThrow();
	});
});

interface Harness {
	url: string;
	mock: MockModel;
	close(): Promise<void>;
}

async function boot(limiter: GatewayConcurrencyLimiter, mock: MockModel): Promise<Harness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-concurrency-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => mock.model,
		version: "test",
		concurrency: limiter,
	});
	return {
		url: handle.url,
		mock,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function chat(url: string, stream: boolean, signal?: AbortSignal): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "mock/flash", messages: [{ role: "user", content: "hi" }], stream }),
		signal,
	});
}

describe("auth-gateway concurrency admission", () => {
	it("frees the slot when a client disconnects mid-stream", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["openrouter", 1]]));
		const mock = createMockModel({
			provider: "openrouter",
			id: "mock/flash",
			responses: [{ content: ["slow"], delayMs: 30_000 }],
			handler: { content: ["fast"] },
		});
		const gw = await boot(limiter, mock);
		try {
			const client = new AbortController();
			const slow = await chat(gw.url, true, client.signal);
			expect(slow.status).toBe(200);
			client.abort();
			await slow.body?.cancel().catch(() => {});
			const fast = await chat(gw.url, false);
			expect(fast.status).toBe(200);
			expect(limiter.snapshot().size).toBe(0);
		} finally {
			await gw.close();
		}
	});

	it("sheds a request queued past the timeout with the max_parallel_requests marker", async () => {
		// Real timers: the queue timeout runs inside the gateway's own HTTP handler.
		const limiter = new GatewayConcurrencyLimiter(new Map([["openrouter", 1]]), 50);
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openrouter",
			id: "mock/flash",
			handler: () => {
				started.resolve();
				return { content: ["held"], delayMs: 500 };
			},
		});
		const gw = await boot(limiter, mock);
		try {
			const held = chat(gw.url, false);
			await started.promise;
			const shed = await chat(gw.url, false);
			expect(shed.status).toBe(429);
			expect(shed.headers.get("rate_limit_type")).toBe("max_parallel_requests");
			expect((await held).status).toBe(200);
			expect(mock.calls).toHaveLength(1);
		} finally {
			await gw.close();
		}
	});

	it("reports the queue on /v1/concurrency and the wait on x-queue-wait-ms", async () => {
		const limiter = new GatewayConcurrencyLimiter(new Map([["openrouter", 1]]));
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openrouter",
			id: "mock/flash",
			responses: [
				async () => {
					started.resolve();
					await finish.promise;
					return { content: ["first"] };
				},
			],
			handler: { content: ["second"] },
		});
		const gw = await boot(limiter, mock);
		try {
			const first = chat(gw.url, false);
			await started.promise;
			const second = chat(gw.url, false);
			// The second request is queued once the pool reports a waiter.
			let pool: { limit: number; active: number; waiting: number } | undefined;
			while (pool?.waiting !== 1) {
				const body = (await (await fetch(`${gw.url}/v1/concurrency`)).json()) as {
					limits: Record<string, number>;
					models: Record<string, { limit: number; active: number; waiting: number }>;
				};
				expect(body.limits).toEqual({ openrouter: 1 });
				pool = body.models["openrouter/mock/flash"];
			}
			expect(pool).toMatchObject({ limit: 1, active: 1, waiting: 1 });
			finish.resolve();
			expect((await first).headers.get("x-queue-wait-ms")).toBe("0");
			const queued = await second;
			expect(queued.status).toBe(200);
			expect(Number(queued.headers.get("x-queue-wait-ms"))).toBeGreaterThan(0);
		} finally {
			await gw.close();
		}
	});
});
