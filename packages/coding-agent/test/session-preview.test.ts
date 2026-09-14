import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SessionPreviewUpdate, streamSessionPreview } from "@oh-my-pi/pi-coding-agent/session/session-preview";

let directory: string;
const streams = new Set<AsyncGenerator<SessionPreviewUpdate>>();

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-preview-"));
});

afterEach(async () => {
	try {
		await Promise.all([...streams].map(stream => stream.return(undefined)));
	} finally {
		streams.clear();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

function message(role: string, content: unknown, timestamp = "2026-09-05T12:00:00.000Z"): string {
	return JSON.stringify({ type: "message", timestamp, message: { role, content } });
}

async function fixture(content: string | Uint8Array): Promise<string> {
	const file = path.join(directory, "session.jsonl");
	await Bun.write(file, content);
	return file;
}

function preview(file: string, options?: { signal?: AbortSignal; maxMessages?: number }) {
	const stream = streamSessionPreview(file, options);
	streams.add(stream);
	return stream;
}

async function collect(file: string, options?: { signal?: AbortSignal; maxMessages?: number }) {
	const updates: SessionPreviewUpdate[] = [];
	for await (const update of preview(file, options)) updates.push(update);
	return updates;
}

function texts(update: SessionPreviewUpdate): string[] {
	return update.messages.map(item => item.text);
}

// Inspect only descriptors for this test's unique file, not process-wide totals:
// unrelated tests and Bun's runtime can open descriptors concurrently.
async function openDescriptors(file: string): Promise<string[]> {
	const descriptors = await fs.readdir("/proc/self/fd");
	const targets = await Promise.all(
		descriptors.map(async descriptor => {
			try {
				return (await fs.readlink(`/proc/self/fd/${descriptor}`)) === file ? descriptor : undefined;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
		}),
	);
	return targets.filter((descriptor): descriptor is string => descriptor !== undefined);
}

describe("streamSessionPreview", () => {
	it("returns the newest eight textual user/assistant messages chronologically", async () => {
		const lines = [JSON.stringify({ type: "session", id: "session", cwd: directory })];
		for (let index = 0; index < 12; index++) {
			lines.push(
				message(
					index % 2 === 0 ? "user" : "assistant",
					index % 2 === 0
						? `message ${index}`
						: [
								{ type: "thinking", thinking: "private reasoning" },
								{ type: "text", text: `message ${index}` },
								{ type: "toolCall", name: "bash", arguments: {} },
							],
				),
				message("toolResult", [{ type: "text", text: "tool output" }]),
				message("assistant", [{ type: "thinking", thinking: "reasoning only" }]),
				message("user", "   "),
			);
		}
		const updates = await collect(await fixture(`${lines.join("\n")}\n`));
		const final = updates.at(-1)!;
		expect(texts(final)).toEqual(Array.from({ length: 8 }, (_, index) => `message ${index + 4}`));
		expect(final.messages.map(item => item.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(final.messages.every(item => item.timestamp === "2026-09-05T12:00:00.000Z")).toBe(true);
		expect(final.complete).toBe(true);
		expect(final.skippedRecords).toBe(0);
	});

	it("joins string and text blocks without exposing non-text content", async () => {
		const file = await fixture(
			message("assistant", [
				"first",
				{ type: "text", text: "second" },
				{ type: "image", data: "image bytes" },
				{ type: "thinking", thinking: "hidden" },
				null,
				{ type: "text", text: 12 },
			]),
		);
		expect(texts((await collect(file)).at(-1)!)).toEqual(["first\nsecond"]);
	});

	it("reconstructs records and multibyte characters split across reverse-read boundaries", async () => {
		const line = message("user", "boundary café 日本語 😀 intact");
		const bytes = Buffer.from(line);
		// The first backwards window starts inside the four-byte emoji. A large
		// trailing metadata record also forces reconstruction across windows.
		const split = bytes.indexOf(Buffer.from("😀")) + 2;
		const suffix = JSON.stringify({ type: "custom", data: "" });
		const padding = 64 * 1024 - (bytes.length - split) - 1 - Buffer.byteLength(suffix);
		const file = await fixture(`${line}\n${JSON.stringify({ type: "custom", data: "x".repeat(padding) })}`);
		const final = (await collect(file)).at(-1)!;
		expect(texts(final)).toEqual(["boundary café 日本語 😀 intact"]);
		expect(final.skippedRecords).toBe(0);
	});

	it("retains earlier messages when a newline falls exactly on a reverse-read boundary", async () => {
		const last = message("assistant", "last");
		const metadata = JSON.stringify({ type: "custom", data: "" });
		const padding = 64 * 1024 - Buffer.byteLength(last) - Buffer.byteLength(metadata) - 2;
		const file = await fixture(
			[message("user", "first"), JSON.stringify({ type: "custom", data: "x".repeat(padding) }), last, ""].join("\n"),
		);
		expect(texts((await collect(file)).at(-1)!)).toEqual(["first", "last"]);
	});

	it("skips a torn final record and malformed middle record without dropping surrounding messages", async () => {
		const file = await fixture(
			[
				message("user", "before corruption"),
				"{invalid json",
				message("assistant", "after corruption"),
				'{"type":"message","message":',
			].join("\n"),
		);
		const final = (await collect(file)).at(-1)!;
		expect(texts(final)).toEqual(["before corruption", "after corruption"]);
		expect(final.skippedRecords).toBe(2);
		expect(final.complete).toBe(true);
	});

	it("includes a valid final record without a terminating newline", async () => {
		const file = await fixture(`${message("user", "first")}\n${message("assistant", "unterminated line")}`);
		const final = (await collect(file)).at(-1)!;
		expect(texts(final)).toEqual(["first", "unterminated line"]);
		expect(final.skippedRecords).toBe(0);
	});

	it("skips an oversized record once, preserves older messages, and exposes bounded previews", async () => {
		const file = await fixture(
			[
				message("user", "before oversized record"),
				message("assistant", "x".repeat(2 * 1024 * 1024)),
				message("assistant", "after oversized record"),
			].join("\n"),
		);
		const updates = await collect(file);
		const final = updates.at(-1)!;
		expect(texts(final)).toEqual(["before oversized record", "after oversized record"]);
		expect(final.skippedRecords).toBe(1);
		expect(final.complete).toBe(true);
		for (const update of updates) {
			expect(update.messages.every(item => item.text.length < 1024)).toBe(true);
		}
	});

	it("publishes the newest message before completing and never mutates previous snapshots", async () => {
		const file = await fixture(
			[message("user", "oldest"), message("assistant", "middle"), message("user", "newest")].join("\n"),
		);
		const stream = preview(file);
		const first = await stream.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual({
			messages: [{ role: "user", text: "newest", timestamp: "2026-09-05T12:00:00.000Z" }],
			complete: false,
			skippedRecords: 0,
		});
		const original = structuredClone(first.value);
		let final = first.value;
		for await (const update of stream) final = update;
		expect(texts(final)).toEqual(["oldest", "middle", "newest"]);
		expect(final.complete).toBe(true);
		expect(first.value).toEqual(original);
	});

	it("marks shortened text and does not split a surrogate pair at the preview limit", async () => {
		const prefix = "x".repeat(16 * 1024 - 1);
		const file = await fixture(message("assistant", `${prefix}😀trailing text`));
		const final = (await collect(file)).at(-1)!;
		const text = final.messages[0].text;
		expect(text.startsWith(prefix)).toBe(true);
		expect(text).toContain("[Message shortened for preview]");
		expect(text).not.toContain("trailing text");
		expect(text.isWellFormed()).toBe(true);
		expect(text.length).toBeLessThan(17 * 1024);
	});

	it("honors cancellation before opening even when the requested file does not exist", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled before opening");
		controller.abort(reason);
		await expect(preview(path.join(directory, "absent.jsonl"), { signal: controller.signal }).next()).rejects.toBe(
			reason,
		);
	});

	it("stops an in-flight read on cancellation instead of publishing another message", async () => {
		const file = await fixture(message("user", "must not be published"));
		const controller = new AbortController();
		const reason = new Error("cancelled during read");
		const handle = await fs.open(file, "r");
		const originalOpen = fs.open;
		const originalRead = handle.read.bind(handle);
		// Abort at a real read completion rather than racing a wall-clock timer.
		// Proxy preserves all generic read overloads while forwarding their exact
		// arguments; reducing the overloads to one rest tuple loses buffer types.
		const readSpy = spyOn(handle, "read").mockImplementation(
			new Proxy(originalRead, {
				apply(target, receiver, args) {
					const pending = Reflect.apply(target, receiver, args) as Promise<
						fs.FileReadResult<NodeJS.ArrayBufferView>
					>;
					return pending.then(result => {
						controller.abort(reason);
						return result;
					});
				},
			}),
		);
		const openSpy = spyOn(fs, "open").mockImplementation((...args) =>
			args[0] === file ? Promise.resolve(handle) : originalOpen(...args),
		);
		try {
			await expect(preview(file, { signal: controller.signal }).next()).rejects.toBe(reason);
			await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
		} finally {
			openSpy.mockRestore();
			readSpy.mockRestore();
			await handle.close();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"closes the descriptor when aborted while suspended at a yield",
		async () => {
			const file = await fixture(`${message("user", "older")}\n${message("assistant", "newer")}`);
			const controller = new AbortController();
			const handle = await fs.open(file, "r");
			const originalOpen = fs.open;
			const openSpy = spyOn(fs, "open").mockImplementation((...args) =>
				args[0] === file ? Promise.resolve(handle) : originalOpen(...args),
			);
			const closed = Promise.withResolvers<void>();
			const originalClose = handle.close.bind(handle);
			const closeSpy = spyOn(handle, "close").mockImplementation(async () => {
				await originalClose();
				closed.resolve();
			});
			try {
				const stream = preview(file, { signal: controller.signal });
				expect((await stream.next()).done).toBe(false);
				expect(await openDescriptors(file)).toHaveLength(1);
				const reason = new Error("cancelled while consumer is paused");
				controller.abort(reason);
				// Await the real close completion without resuming the generator. A UI may
				// stop consuming a discarded preview altogether; no timer is needed.
				await closed.promise;
				expect(await openDescriptors(file)).toEqual([]);
				await expect(stream.next()).rejects.toBe(reason);
			} finally {
				openSpy.mockRestore();
				closeSpy.mockRestore();
				await handle.close();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"releases the descriptor on early iterator return and on completion",
		async () => {
			const file = await fixture(`${message("user", "older")}\n${message("assistant", "newer")}`);
			const stream = preview(file);
			await stream.next();
			expect(await openDescriptors(file)).toHaveLength(1);
			await stream.return(undefined);
			expect(await openDescriptors(file)).toEqual([]);
			const completeStream = preview(file, { maxMessages: 1 });
			expect((await completeStream.next()).value?.complete).toBe(true);
			expect(await openDescriptors(file)).toEqual([]);
		},
	);

	it("surfaces a genuine missing-file error", async () => {
		await expect(preview(path.join(directory, "missing.jsonl")).next()).rejects.toMatchObject({ code: "ENOENT" });
	});
});
