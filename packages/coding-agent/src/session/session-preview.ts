import * as fs from "node:fs/promises";

export interface SessionPreviewMessage {
	role: "user" | "assistant";
	text: string;
	timestamp?: string;
}

export interface SessionPreviewUpdate {
	messages: readonly SessionPreviewMessage[];
	complete: boolean;
	skippedRecords: number;
}

// These are I/O and parsing safety bounds, not the renderer's PREVIEW_LIMITS
// (visible line/item counts). Never grow a window until a huge record fits:
// tool results and torn live writes can be hundreds of megabytes on one line.
const READ_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARACTERS = 16 * 1024;
const PROGRESS_INTERVAL_MS = 50;
const SHORTENED_MESSAGE_SUFFIX = "\n[Message shortened for preview]";

function previewMessage(entry: unknown): SessionPreviewMessage | undefined {
	if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") {
		return undefined;
	}
	if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null) return undefined;
	const message = entry.message;
	if (!("role" in message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
	if (!("content" in message)) return undefined;

	const parts: string[] = [];
	let length = 0;
	let shortened = false;
	const append = (text: string): boolean => {
		if (parts.length === 0) text = text.trimStart();
		if (!text.trim()) return true;
		const separator = parts.length > 0 ? 1 : 0;
		const remaining = MAX_MESSAGE_CHARACTERS - length - separator;
		if (remaining <= 0) {
			shortened = true;
			return false;
		}
		if (text.length > remaining) {
			let end = remaining;
			// A UTF-16 slice must not leave half of a supplementary code point.
			const last = text.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end--;
			parts.push(text.slice(0, end));
			shortened = true;
			return false;
		}
		parts.push(text);
		length += text.length + separator;
		return true;
	};

	if (typeof message.content === "string") {
		append(message.content);
	} else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (typeof part === "string") {
				if (!append(part)) break;
			} else if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				if (!append(part.text)) break;
			}
		}
	}
	const text = parts.join("\n").trim();
	if (!text) return undefined;
	const timestamp =
		"timestamp" in entry && typeof entry.timestamp === "string"
			? entry.timestamp
			: "timestamp" in message && typeof message.timestamp === "string"
				? message.timestamp
				: undefined;
	return {
		role: message.role,
		text: shortened ? text + SHORTENED_MESSAGE_SUFFIX : text,
		...(timestamp === undefined ? {} : { timestamp }),
	};
}

/**
 * Read recent displayable messages backwards from a snapshot of the file size.
 * Each update is an independent chronological snapshot. Malformed and oversized
 * records are counted, while valid non-conversation records are simply ignored.
 * Appends after the initial stat belong to the next preview, not this snapshot.
 *
 * peekFileTail/readTextSlices are one-window peeks; growing those windows would
 * reread and copy huge records quadratically. One positional-read handle and a
 * lazily allocated, fixed-size reverse record buffer instead keep work linear.
 */
export async function* streamSessionPreview(
	path: string,
	options: { signal?: AbortSignal; maxMessages?: number } = {},
): AsyncGenerator<SessionPreviewUpdate> {
	const { signal, maxMessages = 8 } = options;
	if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) {
		throw new RangeError("maxMessages must be a non-negative safe integer");
	}
	signal?.throwIfAborted();
	if (maxMessages === 0) {
		yield { messages: [], complete: true, skippedRecords: 0 };
		return;
	}

	const handle = await fs.open(path, "r");
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => (closePromise ??= handle.close());
	// Also close while the consumer is paused at a yield. The finally below
	// observes close errors; this handler only prevents an unhandled rejection.
	const onAbort = () => void close().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		signal?.throwIfAborted();
		let position = (await handle.stat()).size;
		signal?.throwIfAborted();
		const chunk = Buffer.allocUnsafe(READ_BYTES);
		let recordBuffer: Buffer | undefined;
		let recordLength = 0;
		let skippingRecord = false;
		let skippedRecords = 0;
		const newestFirst: SessionPreviewMessage[] = [];
		const snapshot = (complete: boolean): SessionPreviewUpdate => ({
			messages: newestFirst.slice().reverse(),
			complete,
			skippedRecords,
		});
		let lastUpdate = performance.now();

		const consume = (segment: Buffer, complete: boolean): boolean => {
			if (!skippingRecord && recordLength + segment.length > MAX_RECORD_BYTES) {
				skippingRecord = true;
				recordLength = 0;
				skippedRecords++;
			}
			let bytes = segment;
			if (!skippingRecord && (!complete || recordLength > 0)) {
				if (segment.length > 0) {
					recordBuffer ??= Buffer.allocUnsafe(MAX_RECORD_BYTES);
					recordLength += segment.length;
					segment.copy(recordBuffer, MAX_RECORD_BYTES - recordLength);
				}
				bytes = recordBuffer?.subarray(MAX_RECORD_BYTES - recordLength) ?? segment;
			}
			if (!complete) return false;
			const skip = skippingRecord;
			skippingRecord = false;
			recordLength = 0;
			if (skip || bytes.length === 0) return false;
			let entries: unknown[];
			try {
				entries = Bun.JSONL.parse(bytes);
			} catch {
				skippedRecords++;
				return false;
			}
			// Bun.JSONL.parse can omit a torn final value instead of throwing.
			// This byte span is already one whole physical line, so a nonblank
			// span that produced no value is unreadable, not an ignorable record.
			if (entries.length === 0) {
				if (bytes.some(byte => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d)) skippedRecords++;
				return false;
			}
			const message = previewMessage(entries[0]);
			if (!message) return false;
			newestFirst.push(message);
			return true;
		};

		while (position > 0) {
			signal?.throwIfAborted();
			const length = Math.min(READ_BYTES, position);
			position -= length;
			let total = 0;
			while (total < length) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(chunk, total, length - total, position + total);
				signal?.throwIfAborted();
				if (bytesRead === 0) throw new Error("Session file changed while loading its preview");
				total += bytesRead;
			}

			let end = length;
			while (end > 0) {
				const newline = chunk.lastIndexOf(0x0a, end - 1);
				const complete = newline >= 0 || position === 0;
				const changed = consume(chunk.subarray(newline + 1, end), complete);
				end = newline;
				if (changed) {
					signal?.throwIfAborted();
					const completePreview = newestFirst.length >= maxMessages;
					if (completePreview) await close();
					signal?.throwIfAborted();
					yield snapshot(completePreview);
					if (completePreview) return;
					signal?.throwIfAborted();
					lastUpdate = performance.now();
				}
			}
			// Publish even without a message so long oversized-record skips never
			// hold a pending next() indefinitely. Async disk reads yield CPU too.
			if (performance.now() - lastUpdate >= PROGRESS_INTERVAL_MS) {
				signal?.throwIfAborted();
				yield snapshot(false);
				lastUpdate = performance.now();
			}
		}
		signal?.throwIfAborted();
		await close();
		signal?.throwIfAborted();
		yield snapshot(true);
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await close();
	}
}
