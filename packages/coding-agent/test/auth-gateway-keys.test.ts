import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseGatewayApiKeys,
	readGatewayApiKeys,
	writeGatewayApiKeys,
} from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-keys";

describe("auth-gateway named API keys file", () => {
	let dir: string | undefined;
	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("defaults a missing scope to inference and treats blank content as no keys", () => {
		expect(parseGatewayApiKeys("  \n", "keys")).toEqual([]);
		expect(
			parseGatewayApiKeys(
				JSON.stringify({ laptop: { token: "a1" }, widget: { token: "b2", scope: "full" } }),
				"keys",
			),
		).toEqual([
			{ name: "laptop", token: "a1", scope: "inference" },
			{ name: "widget", token: "b2", scope: "full" },
		]);
	});

	it.each([
		["a non-object root", JSON.stringify(["a1"])],
		["a bare string entry", JSON.stringify({ laptop: "a1" })],
		["an invalid name", JSON.stringify({ "has space": { token: "a1" } })],
		["an empty token", JSON.stringify({ laptop: { token: "" } })],
		["a token with whitespace", JSON.stringify({ laptop: { token: "a 1" } })],
		["an unknown scope", JSON.stringify({ laptop: { token: "a1", scope: "admin" } })],
		["a token shared by two names", JSON.stringify({ laptop: { token: "a1" }, phone: { token: "a1" } })],
		["malformed JSON", "{"],
	])("rejects %s", (_label, raw) => {
		expect(() => parseGatewayApiKeys(raw, "keys")).toThrow();
	});

	it("round-trips keys through an owner-only file and reads a missing file as empty", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-keys-"));
		const file = path.join(dir, "nested", "auth-gateway.keys");
		expect(await readGatewayApiKeys(file)).toEqual([]);

		const keys = [
			{ name: "laptop", token: "a1", scope: "inference" as const },
			{ name: "widget", token: "b2", scope: "full" as const },
		];
		await writeGatewayApiKeys(file, keys);

		expect(await readGatewayApiKeys(file)).toEqual(keys);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});
});
