/**
 * Named API keys for `omp auth-gateway serve`, stored in
 * `<config-dir>/auth-gateway.keys` (mode 0600) as a JSON object mapping each
 * key name to `{ "token": "…", "scope": "inference" | "full" }`. A missing
 * scope means `inference`. Usage from the requests a named key admits is
 * attributed to that name.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthGatewayApiKey, AuthGatewayApiKeyScope } from "@oh-my-pi/pi-ai/auth-gateway";
import { getConfigRootDir, isEnoent } from "@oh-my-pi/pi-utils";

const API_KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const GATEWAY_API_KEY_SCOPES: readonly AuthGatewayApiKeyScope[] = ["inference", "full"];

export function getGatewayApiKeysFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.keys");
}

/** Throws unless `name` is 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export function assertGatewayApiKeyName(name: string): void {
	if (!API_KEY_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid gateway API key name ${JSON.stringify(name)}: use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit`,
		);
	}
}

export function isGatewayApiKeyScope(value: unknown): value is AuthGatewayApiKeyScope {
	return GATEWAY_API_KEY_SCOPES.includes(value as AuthGatewayApiKeyScope);
}

/**
 * Parse keys-file content. Blank content holds no keys; anything else must be
 * a JSON object of valid names to entries with a distinct whitespace-free
 * token (so one token can never be attributed to two names) and an optional
 * known scope.
 */
export function parseGatewayApiKeys(raw: string, source: string): AuthGatewayApiKey[] {
	if (raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${source}: expected a JSON object mapping key names to { token, scope }`);
	}
	const keys: AuthGatewayApiKey[] = [];
	const seenTokens = new Set<string>();
	for (const [name, entry] of Object.entries(parsed)) {
		assertGatewayApiKeyName(name);
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${source}: key ${name} must be an object { token, scope }`);
		}
		const { token, scope = "inference" } = entry as { token?: unknown; scope?: unknown };
		if (typeof token !== "string" || token.length === 0 || /\s/.test(token)) {
			throw new Error(`${source}: key ${name} needs a non-empty token without whitespace`);
		}
		if (!isGatewayApiKeyScope(scope)) {
			throw new Error(`${source}: key ${name} has scope ${JSON.stringify(scope)}; use "inference" or "full"`);
		}
		if (seenTokens.has(token)) throw new Error(`${source}: key ${name} reuses another key's token`);
		seenTokens.add(token);
		keys.push({ name, token, scope });
	}
	return keys;
}

/** Read the keys file; a missing file holds no keys. */
export async function readGatewayApiKeys(file: string): Promise<AuthGatewayApiKey[]> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return parseGatewayApiKeys(raw, file);
}

/**
 * Replace the keys file atomically (temp file + rename), so a running gateway
 * polling it never reads a half-written set.
 */
export async function writeGatewayApiKeys(file: string, keys: readonly AuthGatewayApiKey[]): Promise<void> {
	const entries = Object.fromEntries(keys.map(key => [key.name, { token: key.token, scope: key.scope }]));
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(temp, file);
}
