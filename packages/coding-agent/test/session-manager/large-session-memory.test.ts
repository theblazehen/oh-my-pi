import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile, STREAM_LOAD_THRESHOLD_BYTES } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

class CountingMemorySessionStorage extends MemorySessionStorage {
	writeTextSyncCalls = 0;

	override writeTextSync(filePath: string, content: string): void {
		this.writeTextSyncCalls++;
		super.writeTextSync(filePath, content);
	}
}

class GatedHistoryStorage extends FileSessionStorage {
	gate: { entered: () => void; released: Promise<void> } | undefined;
	atomicWrites = 0;
	commitThenThrow: Error | undefined;

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicWrites++;
		const gate = this.gate;
		this.gate = undefined;
		if (gate) {
			gate.entered();
			await gate.released;
		}
		const failure = this.commitThenThrow;
		this.commitThenThrow = undefined;
		await super.writeTextAtomic(filePath, content, options);
		if (failure) throw failure;
	}
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

describe("large session memory guards", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	it("does not rewrite an already-current session during sync flush", () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		storage.writeTextSyncCalls = 0;
		session.flushSync();

		expect(storage.writeTextSyncCalls).toBe(0);
	});

	it("elides superseded compactions only in the forward transcript", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		const firstSummary = `first-${"x".repeat(4096)}`;
		const secondSummary = `second-${"y".repeat(4096)}`;
		const archivedFrame = btoa("archived frame");
		const replacementHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
		];
		const firstPreserve = {
			openaiRemoteCompaction: { provider: "openai", replacementHistory },
			[snapcompact.PRESERVE_KEY]: {
				frames: [{ data: archivedFrame, mimeType: "image/png", cols: 10, rows: 10, chars: 14 }],
				totalChars: 14,
				truncatedChars: 0,
				textHead: "archived",
				textTail: "frame",
			},
		};
		const firstCompactionId = session.appendCompaction(firstSummary, undefined, firstKeptEntryId, 1000, {
			preserveData: firstPreserve,
		});
		const rewindId = session.appendMessage({ role: "user", content: "between compactions", timestamp: 3 });
		session.appendCompaction(secondSummary, undefined, rewindId, 2000);
		await session.flush();

		const firstCompaction = session.getEntry(firstCompactionId);
		if (firstCompaction?.type !== "compaction") throw new Error("Expected first compaction");
		expect(firstCompaction.summary).toBe(firstSummary);
		expect(firstCompaction.preserveData).toEqual(firstPreserve);

		const transcriptCompactions = session
			.buildSessionContext({ transcript: true })
			.messages.filter(message => message.role === "compactionSummary");
		const supersededDisplay = transcriptCompactions[0];
		if (supersededDisplay?.role !== "compactionSummary") throw new Error("Expected superseded transcript compaction");
		expect(supersededDisplay.summary).toContain("Superseded compaction");
		expect((supersededDisplay.blocks ?? []).some(block => block.type === "image")).toBeFalse();

		session.branch(rewindId);
		const rewoundSummary = session.buildSessionContext().messages[0];
		if (rewoundSummary?.role !== "compactionSummary") throw new Error("Expected rewound compaction summary");
		expect(rewoundSummary.summary).toBe(firstSummary);
		expect(rewoundSummary.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai",
			items: replacementHistory,
		});
		expect(rewoundSummary.blocks?.find(block => block.type === "image")).toMatchObject({ data: archivedFrame });

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persisted = await storage.readText(sessionFile);
		expect(persisted).toContain(firstSummary);
		expect(persisted).toContain(archivedFrame);
		expect(persisted).toContain(secondSummary);
	});

	it("streams large session files without discarding historical compactions", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-large-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "large.jsonl");
		const oldSummary = `old-${"x".repeat(5 * 1024 * 1024)}`;
		const latestSummary = `latest-${"y".repeat(5 * 1024 * 1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: oldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: makeAssistantMessage("hello"),
			},
			{
				type: "compaction",
				id: "c2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: latestSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const compactions = entries.filter(entry => entry.type === "compaction");

		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).toBe(oldSummary);
		expect(compactions[0]?.preserveData).toEqual({ stale: true });
		expect(compactions[1]?.summary).toBe(latestSummary);
	});

	it("bounds compacted resume while preserving cold state and explicit hydration", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-bounded-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "bounded.jsonl");
		const coldAssistantTimestamp = Date.parse("2026-01-01T00:00:03.000Z");
		const latestSummary = "Latest compacted summary";
		const journalEntries = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "bounded-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: tempDir,
			},
			{
				type: "model_change",
				id: "cold-model",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				model: "anthropic/cold-model",
				role: "default",
			},
			{
				type: "thinking_level_change",
				id: "cold-thinking-level",
				parentId: "cold-model",
				timestamp: "2026-01-01T00:00:01.100Z",
				thinkingLevel: "high",
				configured: "auto",
			},
			{
				type: "service_tier_change",
				id: "cold-service-tier",
				parentId: "cold-thinking-level",
				timestamp: "2026-01-01T00:00:01.200Z",
				serviceTier: { openai: "priority", anthropic: "priority" },
			},
			{
				type: "credential_pin",
				id: "cold-pin",
				parentId: "cold-service-tier",
				timestamp: "2026-01-01T00:00:02.000Z",
				provider: "anthropic",
				hash: "cold-credential-hash",
			},
			{
				type: "message",
				id: "cold-assistant",
				parentId: "cold-pin",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					...makeAssistantMessage("cold assistant"),
					timestamp: coldAssistantTimestamp,
					usage: {
						input: 101,
						output: 17,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 118,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
			{
				type: "compaction",
				id: "cold-compaction",
				parentId: "cold-assistant",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: "Cold compacted summary",
				firstKeptEntryId: "cold-assistant",
				tokensBefore: 500,
			},
			{
				type: "message",
				id: "huge-cold-message",
				parentId: "cold-compaction",
				timestamp: "2026-01-01T00:00:05.000Z",
				message: { role: "user", content: `cold-${"x".repeat(17 * 1024 * 1024)}`, timestamp: 5 },
			},
			{
				type: "label",
				id: "cold-label",
				parentId: "huge-cold-message",
				timestamp: "2026-01-01T00:00:06.000Z",
				targetId: "kept-user",
				label: "cold-derived-label",
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "cold-label",
				timestamp: "2026-01-01T00:00:07.000Z",
				message: { role: "user", content: "kept user", timestamp: 7 },
			},
			{
				type: "message",
				id: "kept-assistant",
				parentId: "kept-user",
				timestamp: "2026-01-01T00:00:08.000Z",
				message: makeAssistantMessage("kept assistant"),
			},
			{
				type: "compaction",
				id: "latest-compaction",
				parentId: "kept-assistant",
				timestamp: "2026-01-01T00:00:09.000Z",
				summary: latestSummary,
				firstKeptEntryId: "kept-user",
				tokensBefore: 2_000,
			},
			{
				type: "message",
				id: "tail-user",
				parentId: "latest-compaction",
				timestamp: "2026-01-01T00:00:10.000Z",
				message: { role: "user", content: "after compaction", timestamp: 10 },
			},
		];
		await fsp.writeFile(sessionFile, journalEntries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
		expect((await fsp.stat(sessionFile)).size).toBeGreaterThan(8 * 1024 * 1024);

		const session = await SessionManager.open(sessionFile, tempDir);
		try {
			const initialEntryCount = journalEntries.length - 1;
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getTotalEntryCount()).toBe(initialEntryCount);
			expect(session.getResidentEntryCount()).toBeLessThan(session.getTotalEntryCount());
			expect(session.getEntries().some(entry => entry.id === "huge-cold-message")).toBeFalse();

			const context = session.buildSessionContext();
			expect(session.hasThinkingLevelHistory()).toBeTrue();
			expect(session.hasServiceTierHistory()).toBeTrue();
			expect(context.thinkingLevel).toBe("high");
			expect(context.configuredThinkingLevel).toBe("auto");
			expect(context.serviceTier).toEqual({ openai: "priority", anthropic: "priority" });
			expect(context.models.default).toBe("anthropic/cold-model");
			expect(context.messages.map(message => message.role)).toEqual([
				"compactionSummary",
				"user",
				"assistant",
				"user",
			]);
			const summary = context.messages[0];
			if (summary?.role !== "compactionSummary") throw new Error("Expected latest compaction summary");
			expect(summary.summary).toBe(latestSummary);
			expect(context.messages[1]).toMatchObject({ role: "user", content: "kept user" });
			expect(context.messages[2]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "kept assistant" }],
			});
			expect(context.messages[3]).toMatchObject({ role: "user", content: "after compaction" });

			expect(session.getLastModelChangeRole()).toBe("default");
			expect(session.getLabel("kept-user")).toBe("cold-derived-label");
			expect(session.getCredentialPins().get("anthropic")).toEqual({
				hash: "cold-credential-hash",
				lastUsedAt: coldAssistantTimestamp,
			});
			expect(session.getUsageStatistics()).toMatchObject({ input: 102, output: 18, totalTokens: 120 });
			expect(session.getCompactionCount()).toBe(2);

			const appendedId = session.appendMessage({
				role: "user",
				content: "appended after bounded open",
				timestamp: 11,
			});
			expect(session.hasThinkingLevelHistory()).toBeTrue();
			expect(session.hasServiceTierHistory()).toBeTrue();
			expect(session.buildSessionContext()).toMatchObject({
				thinkingLevel: "high",
				configuredThinkingLevel: "auto",
				serviceTier: { openai: "priority", anthropic: "priority" },
			});
			await session.flush();

			const file = await fsp.open(sessionFile, "r");
			let persistedTail: Record<string, unknown>;
			try {
				const { size } = await file.stat();
				const length = Math.min(size, 4096);
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await file.read(buffer, 0, length, size - length);
				const lastLine = buffer.subarray(0, bytesRead).toString("utf8").trimEnd().split("\n").at(-1);
				if (!lastLine) throw new Error("Expected appended journal row");
				persistedTail = JSON.parse(lastLine) as Record<string, unknown>;
			} finally {
				await file.close();
			}
			expect(persistedTail).toMatchObject({
				type: "message",
				id: appendedId,
				parentId: "tail-user",
				message: { role: "user", content: "appended after bounded open", timestamp: 11 },
			});

			const hydrated = await session.getAllEntries();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.hasThinkingLevelHistory()).toBeTrue();
			expect(session.hasServiceTierHistory()).toBeTrue();
			expect(session.buildSessionContext()).toMatchObject({
				thinkingLevel: "high",
				configuredThinkingLevel: "auto",
				serviceTier: { openai: "priority", anthropic: "priority" },
			});
			expect(hydrated).toHaveLength(initialEntryCount + 1);
			expect(session.getResidentEntryCount()).toBeLessThan(initialEntryCount + 1);
			expect(hydrated.map(entry => entry.id)).toEqual([
				...journalEntries.slice(1).map(entry => entry.id),
				appendedId,
			]);
			expect(hydrated.at(-1)).toMatchObject({
				id: appendedId,
				message: { role: "user", content: "appended after bounded open" },
			});
			const completeBranch = await session.getBranchAsync();
			expect(completeBranch.some(entry => entry.id === "huge-cold-message")).toBeTrue();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("huge-cold-message")).toBeUndefined();
			expect(await session.getEntryAsync("huge-cold-message")).toMatchObject({ id: "huge-cold-message" });
			expect(session.hasColdHistory()).toBeTrue();
			expect((await session.getFullTree()).length).toBeGreaterThan(0);
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("huge-cold-message")).toBeUndefined();
		} finally {
			await session.close();
		}
	}, 15_000);

	it("restores cold todo phases without hydration and honors an explicit empty clear", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-cold-todo-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "todo.jsonl");
		const phases = [{ name: "Work", tasks: [{ content: "Preserve cold state", status: "pending" as const }] }];
		const timestamp = "2026-01-01T00:00:00.000Z";
		const entries: FileEntry[] = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "cold-todo", timestamp, cwd: tempDir },
			{
				type: "custom",
				id: "todo",
				parentId: null,
				timestamp,
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases },
			},
			{
				type: "message",
				id: "large",
				parentId: "todo",
				timestamp,
				message: { role: "user", content: "x".repeat(17 * 1024 * 1024), timestamp: 1 },
			},
			{
				type: "message",
				id: "kept",
				parentId: "large",
				timestamp,
				message: { role: "user", content: "current", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp,
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 1000,
			},
		];
		await fsp.writeFile(sessionFile, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
		const session = await SessionManager.open(sessionFile, tempDir);
		try {
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("todo")).toBeUndefined();
			const residentCount = session.getResidentEntryCount();
			expect(getLatestTodoPhasesFromEntries(session.getBranch(), session.getTodoPhasesSeed())).toEqual(phases);
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getResidentEntryCount()).toBe(residentCount);
			session.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			expect(getLatestTodoPhasesFromEntries(session.getBranch(), session.getTodoPhasesSeed())).toEqual([]);
			expect(session.hasColdHistory()).toBeTrue();
			await session.flush();
		} finally {
			await session.close();
		}
		const reopened = await SessionManager.open(sessionFile, tempDir);
		try {
			expect(reopened.hasColdHistory()).toBeTrue();
			expect(getLatestTodoPhasesFromEntries(reopened.getBranch(), reopened.getTodoPhasesSeed())).toEqual([]);
			expect(reopened.getEntry("todo")).toBeUndefined();
		} finally {
			await reopened.close();
		}
	}, 15_000);

	it("keeps pruning rewrites and continued compaction bounded without altering cold replay", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-retained-rewrite-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "history.jsonl");
		const imageBytes = Buffer.from(`cold image ${tempDir}`);
		const blob = new BlobStore(getBlobsDir()).putSync(imageBytes);
		const header: FileEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "retention-rewrite",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const entries: SessionEntry[] = [];
		const row = (id: string) => ({ id, parentId: entries.at(-1)?.id ?? null, timestamp: header.timestamp });
		entries.push({ type: "model_change", ...row("model"), model: "anthropic/cold-model", role: "default" });
		entries.push({ type: "thinking_level_change", ...row("thinking"), thinkingLevel: "high", configured: "auto" });
		entries.push({
			type: "message",
			...row("cold-image"),
			message: {
				role: "user",
				content: [{ type: "image", data: blob.ref, mimeType: "image/png" }],
				timestamp: 1,
			},
		});
		entries.push({
			type: "message",
			...row("cold-assistant"),
			message: {
				...makeAssistantMessage("cold reply"),
				content: [
					{ type: "thinking", thinking: "signed".repeat(200_000), thinkingSignature: "preserve-signature-bytes" },
					{ type: "text", text: "cold reply" },
				],
			},
		});
		entries.push({
			type: "compaction",
			...row("cold-compaction"),
			summary: "old summary",
			firstKeptEntryId: "cold-image",
			tokensBefore: 100,
		});
		entries.push({
			type: "message",
			...row("cold-large"),
			message: {
				role: "user",
				content: `historical-${"x".repeat(17 * 1024 * 1024)}`,
				timestamp: 2,
			},
		});
		entries.push({ type: "label", ...row("label"), targetId: "kept-user", label: "preserved label" });
		entries.push({
			type: "message",
			...row("kept-user"),
			message: { role: "user", content: "keep me", timestamp: 3 },
		});
		entries.push({
			type: "message",
			...row("pruned-tool"),
			message: {
				role: "toolResult",
				toolCallId: "call-pruned",
				toolName: "read",
				content: [{ type: "text", text: "original tool result" }],
				isError: false,
				timestamp: 4,
			},
		});
		entries.push({
			type: "compaction",
			...row("current-compaction"),
			summary: "current summary",
			firstKeptEntryId: "kept-user",
			tokensBefore: 200,
		});
		// An inactive branch is part of the authoritative journal too.
		entries.push({
			type: "custom",
			...row("inactive"),
			parentId: "cold-assistant",
			customType: "preserve",
			data: { exact: "inactive branch data" },
		});
		entries.push({
			type: "message",
			...row("tail"),
			parentId: "current-compaction",
			message: { role: "user", content: "continue", timestamp: 5 },
		});
		await Bun.write(sessionFile, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
		const expected = structuredClone(entries);
		const storage = new GatedHistoryStorage();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		// Corruption marks a bounded resume for repair without hydrating its
		// archived payloads. A synchronous durability boundary must repair it too.
		await fsp.appendFile(sessionFile, "{malformed-record}\n");
		const session = await SessionManager.open(sessionFile, tempDir, storage);
		const blobReads = spyOn(BlobStore.prototype, "get");
		try {
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("cold-image")).toBeUndefined();
			session.flushSync();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("cold-large")).toBeUndefined();
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			expect(await fsp.readFile(sessionFile, "utf8")).not.toContain("{malformed-record}");
			expect(blobReads).not.toHaveBeenCalled();
			const tool = session.getEntry("pruned-tool");
			if (tool?.type !== "message" || tool.message.role !== "toolResult") throw new Error("Expected tool result");
			tool.message.content = [{ type: "text", text: "[pruned result]" }];
			const expectedTool = expected.find(entry => entry.id === tool.id);
			if (expectedTool?.type !== "message") throw new Error("Expected persisted tool result");
			expectedTool.message = structuredClone(tool.message);
			storage.gate = { entered: entered.resolve, released: released.promise };
			const rewriting = session.rewriteEntries();
			await entered.promise;
			const concurrentId = session.appendMessage(makeAssistantMessage("appended during publish"));
			expected.push(structuredClone(session.getEntry(concurrentId)!));
			released.resolve();
			await rewriting;
			await session.flush();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("cold-large")).toBeUndefined();
			expect(session.getLabel("kept-user")).toBe("preserved label");
			expect(session.buildSessionContext()).toMatchObject({
				thinkingLevel: "high",
				models: { default: "anthropic/cold-model" },
			});
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			expect(blobReads).not.toHaveBeenCalled();

			const syncEntered = Promise.withResolvers<void>();
			const syncReleased = Promise.withResolvers<void>();
			storage.gate = { entered: syncEntered.resolve, released: syncReleased.promise };
			const superseded = session.rewriteEntries();
			try {
				await syncEntered.promise;
				const markerId = session.appendCustomEntry("sync-during-cold-rewrite", { preserved: true });
				expected.push(structuredClone(session.getEntry(markerId)!));
				session.flushSync();
			} finally {
				syncReleased.resolve();
				await superseded;
			}
			expect(session.hasColdHistory()).toBeTrue();
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			expect(blobReads).not.toHaveBeenCalled();

			const appendChunk = (index: number) => {
				const id = session.appendMessage({
					role: "user",
					content: `${index}:${"z".repeat(480_000)}`,
					timestamp: 10 + index,
				});
				expected.push(structuredClone(session.getEntry(id)!));
				return id;
			};
			let keptId = "";
			for (let index = 0; index < 25; index++) keptId = appendChunk(index);
			const newCompaction = session.appendCompaction("new effective summary", undefined, keptId, 10_000);
			expected.push(structuredClone(session.getEntry(newCompaction)!));
			await session.flush();
			expect(session.getCompactionCount()).toBe(3);
			expect(session.getEntry("current-compaction")).toBeDefined();
			for (let index = 25; index < 40; index++) appendChunk(index);
			await session.flush();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("current-compaction")).toBeUndefined();
			expect(session.getEntry(keptId)).toEqual(expected.find(entry => entry.id === keptId));
			expect(session.getTotalEntryCount()).toBe(expected.length);
			expect(session.getUsageStatistics()).toMatchObject({ input: 2, output: 2, totalTokens: 4 });
			const liveContext = session.buildSessionContext();
			expect(liveContext.messages[0]).toMatchObject({ role: "compactionSummary", summary: "new effective summary" });
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			expect(blobReads).not.toHaveBeenCalled();

			// Growth of the pinned effective context must not cause endless full
			// rewrites once all optional history has already been evicted.
			const writes = storage.atomicWrites;
			for (let index = 40; index < 70; index++) appendChunk(index);
			await session.flush();
			expect(storage.atomicWrites).toBe(writes);
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			expect(blobReads).not.toHaveBeenCalled();

			const complete = await session.getAllEntries();
			const coldImage = complete.find(entry => entry.id === "cold-image");
			expect(coldImage).toMatchObject({
				type: "message",
				message: {
					content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }],
				},
			});
			expect(complete.find(entry => entry.id === "inactive")).toEqual(
				expected.find(entry => entry.id === "inactive"),
			);
			expect(complete.find(entry => entry.id === "cold-large")).toEqual(
				expected.find(entry => entry.id === "cold-large"),
			);
			expect(session.buildSessionContext().messages.slice(0, liveContext.messages.length)).toEqual(
				liveContext.messages,
			);
		} finally {
			released.resolve();
			blobReads.mockRestore();
			await session.close();
			await fsp.unlink(blob.path);
		}
	}, 30_000);

	it("persists background results on evicted owned branches without switching the active branch", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-cold-branch-append-"));
		tempDirs.push(tempDir);
		const storage = new FileSessionStorage();
		const session = SessionManager.create(tempDir, tempDir, storage);
		try {
			const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
			session.appendMessage(makeAssistantMessage("shared reply"));
			const backgroundParentId = session.appendMessage({
				...makeAssistantMessage("background branch"),
				content: [
					{ type: "thinking", thinking: "x".repeat(17 * 1024 * 1024), thinkingSignature: "background-signature" },
				],
			});
			session.branch(rootId);
			const keptId = session.appendMessage({ role: "user", content: "active branch", timestamp: 4 });
			// Branch switching synchronously publishes the old branch. Its payload
			// must still be evictable when the new active branch compacts.
			expect(storage.statSync(session.getSessionFile()!).size).toBeGreaterThanOrEqual(STREAM_LOAD_THRESHOLD_BYTES);
			session.appendCompaction("active branch summary", undefined, keptId, 10_000);
			await session.flush();
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry(backgroundParentId)).toBeUndefined();
			const activeLeafId = session.getLeafId();
			const activeContext = session.buildSessionContext();
			const result = makeAssistantMessage("background result");
			expect(() => session.appendMessageToBranch(result, "unknown-parent")).toThrow(
				"Entry unknown-parent not found",
			);

			const firstResultId = session.appendMessageToBranch(result, backgroundParentId);
			expect(session.getEntry(firstResultId)?.parentId).toBe(backgroundParentId);
			expect(session.getLeafId()).toBe(activeLeafId);
			expect(session.buildSessionContext()).toEqual(activeContext);
			expect(session.getEntry(backgroundParentId)).toBeUndefined();
			await session.rewriteEntries();
			expect(session.getEntry(firstResultId)).toBeUndefined();
			const secondResultId = session.appendMessageToBranch(
				makeAssistantMessage("next background result"),
				firstResultId,
			);
			expect(session.getLeafId()).toBe(activeLeafId);
			expect(session.buildSessionContext()).toEqual(activeContext);
			expect(session.getEntry(backgroundParentId)).toBeUndefined();
			expect(session.getEntry(firstResultId)).toBeUndefined();

			// Session-owned work can move to a clone during navigation. Its cold
			// anchors survive the snapshot, but must not leak into a new session.
			const clone = session.cloneCurrentSession({ persist: false });
			try {
				const cloneResultId = clone.appendMessageToBranch(result, backgroundParentId);
				expect(clone.getEntry(cloneResultId)?.parentId).toBe(backgroundParentId);
				expect(clone.getLeafId()).toBe(activeLeafId);
				await clone.newSession();
				expect(() => clone.appendMessageToBranch(result, backgroundParentId)).toThrow(
					`Entry ${backgroundParentId} not found`,
				);
			} finally {
				await clone.close();
			}

			// The journal restores its last physical entry as the leaf. An ordinary
			// foreground continuation must still attach to the untouched active leaf.
			const foregroundId = session.appendMessage({ role: "user", content: "foreground continuation", timestamp: 5 });
			expect(session.getEntry(foregroundId)?.parentId).toBe(activeLeafId);
			await session.rewriteEntries();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session");
			const reopened = await SessionManager.open(sessionFile, tempDir);
			try {
				expect(reopened.getLeafId()).toBe(foregroundId);
				const history = await reopened.getAllEntries();
				expect(history.find(entry => entry.id === firstResultId)).toMatchObject({
					type: "message",
					parentId: backgroundParentId,
					message: { content: result.content },
				});
				expect(history.find(entry => entry.id === secondResultId)?.parentId).toBe(firstResultId);
				expect(reopened.getBranch().map(entry => entry.id)).not.toContain(firstResultId);
				expect(reopened.getBranch().map(entry => entry.id)).not.toContain(secondResultId);
			} finally {
				await reopened.close();
			}
		} finally {
			await session.close();
		}
	}, 30_000);

	async function openFullHistoryOperationFixture(coldImageRef?: string) {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-full-history-operation-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "history.jsonl");
		const timestamp = "2026-01-01T00:00:00.000Z";
		const header: FileEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "full-history-operation",
			timestamp,
			cwd: tempDir,
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "cold-large",
				parentId: null,
				timestamp,
				message: {
					...makeAssistantMessage("historical reply"),
					content: [
						{
							type: "thinking",
							thinking: "x".repeat(17 * 1024 * 1024),
							thinkingSignature: "preserve-history-signature",
						},
						{ type: "text", text: "historical reply" },
					],
				},
			},
			{
				type: "custom",
				id: "inactive",
				parentId: "cold-large",
				timestamp,
				customType: "inactive-history",
				data: { preserved: true },
			},
			{
				type: "message",
				id: "kept",
				parentId: "cold-large",
				timestamp,
				message: { role: "user", content: "current context", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compaction",
				parentId: "kept",
				timestamp,
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
			},
		];
		if (coldImageRef) {
			entries[0]!.parentId = "cold-image";
			entries.unshift({
				type: "message",
				id: "cold-image",
				parentId: null,
				timestamp,
				message: {
					role: "user",
					content: [{ type: "image", data: coldImageRef, mimeType: "image/png" }],
					timestamp: 1,
				},
			});
		}
		await Bun.write(sessionFile, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
		const storage = new GatedHistoryStorage();
		const session = await SessionManager.open(sessionFile, tempDir, storage);
		expect(session.hasColdHistory()).toBeTrue();
		await session.withFullHistory(() => {
			expect(session.hasColdHistory()).toBeFalse();
		});
		expect(session.hasColdHistory()).toBeTrue();
		return { session, storage, sessionFile, entries };
	}

	it.each(["reopen", "release"] as const)(
		"rejects a history scope superseded by %s",
		async action => {
			const blob = new BlobStore(getBlobsDir()).putSync(Buffer.from(`history-race:${crypto.randomUUID()}`));
			const { session, sessionFile, storage } = await openFullHistoryOperationFixture(blob.ref);
			await session.rewriteEntries();
			expect(session.hasColdHistory()).toBeTrue();
			expect(storage.statSync(sessionFile).size).toBeGreaterThanOrEqual(STREAM_LOAD_THRESHOLD_BYTES);
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			// Gate cold image resolution after the real streaming parse; unrelated
			// stores and hashes retain their normal I/O behavior.
			const get = BlobStore.prototype.get;
			const gate = spyOn(BlobStore.prototype, "get").mockImplementation(async function (this: BlobStore, hash) {
				const loaded = await get.call(this, hash);
				if (hash === blob.hash) {
					entered.resolve();
					await released.promise;
				}
				return loaded;
			});
			let called = false;
			const operation = session.withFullHistory(() => {
				called = true;
			});
			// Capture rejection without invoking Bun's eager async matcher while
			// hydration is gated: the matcher would wait before we can release it.
			const outcome = operation.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await entered.promise;
				if (action === "reopen") {
					// Same file and session ID must still supersede the old scope.
					await session.setSessionFile(sessionFile);
					expect(session.hasColdHistory()).toBeTrue();
				} else {
					await session.close();
					session.releaseRetainedEntries();
				}
				released.resolve();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Session changed while loading complete history");
				expect(called).toBeFalse();
				if (action === "reopen") {
					expect(session.hasColdHistory()).toBeTrue();
					expect(session.getEntry("cold-large")).toBeUndefined();
				} else expect(session.getResidentEntryCount()).toBe(0);
			} finally {
				released.resolve();
				gate.mockRestore();
				await outcome;
				await session.close();
				await fsp.unlink(blob.path);
			}
		},
		30_000,
	);

	it("preserves the entire journal when maintenance publishes during fork preflight", async () => {
		const { session, storage, sessionFile, entries } = await openFullHistoryOperationFixture();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		storage.gate = { entered: entered.resolve, released: released.promise };
		const maintenance = session.rewriteEntries();
		try {
			await entered.promise;
			const forking = session.fork();
			released.resolve();
			const [, forked] = await Promise.all([maintenance, forking]);
			expect(forked?.oldSessionFile).toBe(sessionFile);
			if (!forked) throw new Error("Expected a persisted fork");
			expect(forked.newSessionFile).not.toBe(sessionFile);
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(entries);
			expect((await loadEntriesFromFile(forked.newSessionFile)).slice(1)).toEqual(entries);
			// Fork owns an identity transition: it must release its hydrated source
			// immediately, without relying on a later maintenance rewrite.
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getResidentEntryCount()).toBeLessThan(entries.length);
			expect(session.getEntry("cold-large")).toBeUndefined();
			// The operation lease must not permanently disable retention.
			await session.rewriteEntries();
			expect(session.hasColdHistory()).toBeTrue();
		} finally {
			released.resolve();
			await maintenance;
			await session.close();
		}
	}, 30_000);

	it("never resurrects staged IDs when a batch commits then throws after maintenance preflight", async () => {
		const { session, storage, sessionFile, entries } = await openFullHistoryOperationFixture();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const preflightEntered = Promise.withResolvers<void>();
		const flush = session.flush.bind(session);
		const preflight = spyOn(session, "flush").mockImplementation(() => {
			preflightEntered.resolve();
			return flush();
		});
		storage.gate = { entered: entered.resolve, released: released.promise };
		const maintenance = session.rewriteEntries();
		let stagedId = "";
		try {
			await entered.promise;
			const committing = session.appendEntriesAtomically(() => {
				stagedId = session.appendCustomEntry("must-roll-back", { staged: true });
				storage.commitThenThrow = new Error("batch published then failed");
			});
			const outcome = committing.then(
				() => undefined,
				error => error,
			);
			// Wait for the batch's full-history preflight, not merely its FIFO lock reservation.
			await preflightEntered.promise;
			released.resolve();
			const [, failure] = await Promise.all([maintenance, outcome]);
			expect(failure).toBeInstanceOf(Error);
			expect(failure.message).toBe("batch published then failed");
			expect(stagedId).not.toBe("");
			expect(session.getEntry(stagedId)).toBeUndefined();
			expect(session.getLeafId()).toBe("compaction");
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(entries);
			expect(await session.getAllEntries()).toEqual(entries);
			const retryId = await session.appendEntriesAtomically(() => session.appendCustomEntry("successful-retry"));
			const expected = [...entries, session.getEntry(retryId)!];
			expect((await loadEntriesFromFile(sessionFile)).slice(1)).toEqual(expected);
			await session.rewriteEntries();
			expect(session.hasColdHistory()).toBeTrue();
			expect((await session.getAllEntries()).some(entry => entry.id === stagedId)).toBeFalse();
		} finally {
			preflight.mockRestore();
			released.resolve();
			await maintenance;
			await session.close();
		}
	}, 30_000);

	it("distinguishes absent control history from newly appended resident changes", () => {
		const session = SessionManager.inMemory("/work");
		const rootId = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		expect(session.hasThinkingLevelHistory()).toBeFalse();
		expect(session.hasServiceTierHistory()).toBeFalse();

		session.appendThinkingLevelChange("medium", "medium");
		const serviceTierId = session.appendServiceTierChange({ google: "flex" });

		expect(session.hasThinkingLevelHistory()).toBeTrue();
		expect(session.hasServiceTierHistory()).toBeTrue();
		expect(session.buildSessionContext()).toMatchObject({
			thinkingLevel: "medium",
			configuredThinkingLevel: "medium",
			serviceTier: { google: "flex" },
		});

		session.branch(rootId);
		expect(session.hasThinkingLevelHistory()).toBeFalse();
		expect(session.hasServiceTierHistory()).toBeFalse();

		session.branch(serviceTierId);
		expect(session.hasThinkingLevelHistory()).toBeTrue();
		expect(session.hasServiceTierHistory()).toBeTrue();
	});

	it("preserves sibling-branch compactions when a newer compaction lands on another branch", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("root reply"));

		const branchACompactionSummary = `branch-a-${"x".repeat(1024)}`;
		const branchAPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		session.appendCompaction(branchACompactionSummary, undefined, rootId, 1000, {
			preserveData: branchAPreserve,
		});
		const branchACompactionId = session.getLeafId();
		if (!branchACompactionId) throw new Error("Expected branch A compaction id");

		session.branch(rootId);
		session.appendMessage(makeAssistantMessage("branch B reply"));
		const branchBCompactionSummary = `branch-b-${"y".repeat(1024)}`;
		session.appendCompaction(branchBCompactionSummary, undefined, rootId, 1000);

		const branchACompaction = session.getEntry(branchACompactionId);
		if (branchACompaction?.type !== "compaction") throw new Error("Expected sibling compaction entry");
		expect(branchACompaction.summary).toBe(branchACompactionSummary);
		expect(branchACompaction.preserveData).toEqual(branchAPreserve);

		const branchBCompactions = session
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === branchBCompactionSummary);
		expect(branchBCompactions).toHaveLength(1);
	});

	it("preserves loaded compactions on every branch", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-branch-load-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "branched.jsonl");
		const branchASummary = `branch-a-${"x".repeat(1024)}`;
		const branchBOldSummary = `branch-b-old-${"y".repeat(1024)}`;
		const branchBNewSummary = `branch-b-new-${"z".repeat(1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "shared", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "ca",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: branchASummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } },
			},
			{
				type: "compaction",
				id: "cb1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: branchBOldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "cb1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: makeAssistantMessage("branch b reply"),
			},
			{
				type: "compaction",
				id: "cb2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: branchBNewSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile);
		const byId = new Map(entries.map(entry => [(entry as { id?: string }).id, entry] as const));
		const branchA = byId.get("ca");
		const branchBOld = byId.get("cb1");
		const branchBNew = byId.get("cb2");
		if (branchA?.type !== "compaction" || branchBOld?.type !== "compaction" || branchBNew?.type !== "compaction") {
			throw new Error("Expected compaction entries");
		}

		expect(branchA.summary).toBe(branchASummary);
		expect(branchA.preserveData).toBeDefined();
		expect(branchBOld.summary).toBe(branchBOldSummary);
		expect(branchBOld.preserveData).toEqual({ stale: true });
		expect(branchBNew.summary).toBe(branchBNewSummary);
	});

	it("evicts optional history after externalized image growth without another compaction", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-image-retention-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "history.jsonl");
		const header: FileEntry = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "image-retention",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const entries: SessionEntry[] = [];
		const row = (id: string) => ({ id, parentId: entries.at(-1)?.id ?? null, timestamp: header.timestamp });
		entries.push({
			type: "message",
			...row("cold-root"),
			message: {
				role: "user",
				content: "x".repeat(17 * 1024 * 1024),
				timestamp: 1,
			},
		});
		entries.push({
			type: "compaction",
			...row("optional-compaction"),
			summary: "optional summary",
			firstKeptEntryId: "cold-root",
			tokensBefore: 100,
		});
		for (let index = 0; index < 10; index++) {
			entries.push({
				type: "message",
				...row(`optional-${index}`),
				message: {
					role: "user",
					content: "o".repeat(480_000),
					timestamp: 2 + index,
				},
			});
		}
		entries.push({
			type: "message",
			...row("kept-user"),
			message: { role: "user", content: "keep me", timestamp: 12 },
		});
		entries.push({
			type: "compaction",
			...row("current-compaction"),
			summary: "current summary",
			firstKeptEntryId: "kept-user",
			tokensBefore: 200,
		});
		entries.push({ type: "message", ...row("tail"), message: makeAssistantMessage("continue") });
		await Bun.write(sessionFile, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
		const storage = new GatedHistoryStorage();
		const session = await SessionManager.open(sessionFile, tempDir, storage);
		const imageBytes = Buffer.alloc(9 * 1024 * 1024, tempDir);
		const imageData = imageBytes.toString("base64");
		const imageHash = new Bun.SHA256().update(imageBytes).digest("hex");
		const imagePath = path.join(getBlobsDir(), imageHash);
		const imageMessage = {
			role: "user" as const,
			content: [{ type: "image" as const, data: imageData, mimeType: "image/png" }],
			timestamp: 20,
		};
		try {
			expect(session.hasColdHistory()).toBeTrue();
			expect(session.getEntry("optional-compaction")).toBeDefined();
			expect(session.getEntry("optional-0")).toBeDefined();
			const writesBefore = storage.atomicWrites;
			const imageId = session.appendMessage(imageMessage);
			await session.flush();
			expect(storage.atomicWrites).toBe(writesBefore + 1);
			expect(session.getEntry("optional-compaction")).toBeUndefined();
			expect(session.getEntry("optional-0")).toBeUndefined();
			expect(session.getEntry("kept-user")).toBeDefined();
			expect(session.getEntry(imageId)).toMatchObject({ message: imageMessage });
			expect(session.getCompactionCount()).toBe(2);

			// All remaining history is pinned; another large image must not rewrite it.
			const writesAfterEviction = storage.atomicWrites;
			const secondImageId = session.appendMessage({ ...imageMessage, timestamp: 21 });
			await session.flush();
			expect(storage.atomicWrites).toBe(writesAfterEviction);
			expect(session.getEntry(imageId)).toMatchObject({ message: imageMessage });
			expect(session.getEntry(secondImageId)).toMatchObject({ message: { content: imageMessage.content } });
			const persisted = await loadEntriesFromFile(sessionFile);
			expect(persisted.slice(1, entries.length + 1)).toEqual(entries);
			for (const id of [imageId, secondImageId]) {
				expect(persisted.find(entry => entry.type !== "session" && entry.id === id)).toMatchObject({
					message: { content: [{ type: "image", data: `blob:sha256:${imageHash}`, mimeType: "image/png" }] },
				});
			}
			expect(await new BlobStore(getBlobsDir()).get(imageHash)).toEqual(imageBytes);
		} finally {
			await session.close();
			await Promise.all([imagePath, `${imagePath}.png`].map(file => fsp.rm(file, { force: true })));
		}
	}, 30_000);

	it("uses developer prefix text when a fork has no early user message", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const sessionFile = `${sessionDir}/fork.jsonl`;
		const lines = [
			{ type: "session", version: 3, id: "fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
			{
				type: "message",
				id: "d1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "developer", content: "Plan fork context", timestamp: 1 },
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		storage.writeTextSync(sessionFile, lines.join(""));

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Plan fork context");
	});
});
