import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayApiKey, AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { ClientUsageIdentity } from "@oh-my-pi/pi-ai/usage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface Harness {
	url: string;
	storage: AuthStorage;
	handle: AuthGatewayServerHandle;
	dir: string;
	observed: ClientUsageIdentity[];
	upstreamCalls: number;
}

const MODEL: Model<Api> = buildModel({
	id: "text-embedding-3-small",
	name: "text-embedding-3-small",
	api: "openai-embeddings",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: null,
	kind: "embedding",
	supportsTools: false,
} satisfies ModelSpec<Api>);

async function boot(apiKeys: () => readonly AuthGatewayApiKey[]): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-api-keys-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openai", "openai-secret");
	const harness = { storage, dir, observed: [] as ClientUsageIdentity[], upstreamCalls: 0 } as Harness;
	vi.spyOn(storage.usage, "observe").mockImplementation(entry => {
		if (entry.client) harness.observed.push(entry.client);
	});
	const fetchImpl: FetchImpl = async () => {
		harness.upstreamCalls++;
		return Response.json({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: [0.5] }],
			model: MODEL.id,
			usage: { prompt_tokens: 3, total_tokens: 3 },
		});
	};
	harness.handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		apiKeys,
		storage,
		resolveModel: id => (id === MODEL.id || id === `openai/${MODEL.id}` ? MODEL : undefined),
		listModels: () => [MODEL],
		version: "test",
		fetch: fetchImpl,
	});
	harness.url = harness.handle.url;
	return harness;
}

function embed(harness: Harness, headers: Record<string, string>): Promise<Response> {
	return fetch(`${harness.url}/v1/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ model: `openai/${MODEL.id}`, input: "hello" }),
	});
}

const LAPTOP: AuthGatewayApiKey = { name: "laptop", token: "laptop-key", scope: "inference" };
const WIDGET: AuthGatewayApiKey = { name: "widget", token: "widget-key", scope: "full" };

describe("auth-gateway named API keys", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (!harness) return;
		await harness.handle.close();
		harness.storage.close();
		await fs.rm(harness.dir, { recursive: true, force: true });
		harness = undefined;
	});

	it("admits a named key as x-api-key or bearer and attributes usage to its name, not caller headers", async () => {
		harness = await boot(() => [LAPTOP]);

		const viaApiKey = await embed(harness, {
			"x-api-key": "laptop-key",
			"x-omp-install-id": "spoofed-install",
			"x-omp-hostname": "spoofed-host",
			"x-omp-app": "claude-code",
		});
		const viaBearer = await embed(harness, { Authorization: "Bearer laptop-key" });
		const viaUnnamedToken = await embed(harness, {
			Authorization: "Bearer gw-token",
			"x-omp-install-id": "box-1",
			"x-omp-hostname": "box-1.lan",
		});
		const wrongKey = await embed(harness, { "x-api-key": "not-a-key" });

		expect([viaApiKey.status, viaBearer.status, viaUnnamedToken.status, wrongKey.status]).toEqual([
			200, 200, 200, 401,
		]);
		expect(harness.observed).toEqual([
			{ installId: "gateway-key:laptop", hostname: "laptop", app: "claude-code" },
			{ installId: "gateway-key:laptop", hostname: "laptop", app: "gateway" },
			{ installId: "box-1", hostname: "box-1.lan", app: "gateway" },
		]);
		expect(harness.upstreamCalls).toBe(3);
	});

	it("limits inference keys to inference routes, failing closed on unlisted routes", async () => {
		harness = await boot(() => [LAPTOP, WIDGET]);
		const get = (pathname: string, headers: Record<string, string>) =>
			fetch(`${harness!.url}${pathname}`, { headers });

		const inference = { "x-api-key": "laptop-key" };
		expect((await get("/v1/usage", inference)).status).toBe(403);
		expect((await get("/v1/credentials/check", inference)).status).toBe(403);
		expect((await get("/v1/not-a-route", inference)).status).toBe(403);
		expect((await get("/v1/models", inference)).status).toBe(200);

		expect((await get("/v1/usage", { "x-api-key": "widget-key" })).status).toBe(200);
		expect((await get("/v1/usage", { Authorization: "Bearer gw-token" })).status).toBe(200);
		expect((await get("/v1/not-a-route", { Authorization: "Bearer gw-token" })).status).toBe(404);
	});

	it("applies the current key set to every request without a restart", async () => {
		let keys: readonly AuthGatewayApiKey[] = [LAPTOP];
		harness = await boot(() => keys);

		expect((await embed(harness, { "x-api-key": "laptop-key" })).status).toBe(200);
		keys = [WIDGET];
		expect((await embed(harness, { "x-api-key": "laptop-key" })).status).toBe(401);
		expect((await embed(harness, { "x-api-key": "widget-key" })).status).toBe(200);
		expect(harness.observed.map(client => client.installId)).toEqual(["gateway-key:laptop", "gateway-key:widget"]);
	});

	it("rejects a named key leaked into the URL before provider dispatch", async () => {
		harness = await boot(() => [LAPTOP]);
		const response = await fetch(`${harness.url}/v1/embeddings?key=laptop-key`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": "laptop-key" },
			body: JSON.stringify({ model: `openai/${MODEL.id}`, input: "hello" }),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("laptop-key");
		expect(harness.upstreamCalls).toBe(0);
	});
});
