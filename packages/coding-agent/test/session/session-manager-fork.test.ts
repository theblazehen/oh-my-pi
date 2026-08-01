import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("clones the selected leaf branch and preserves the provider prompt cache key", async () => {
		using tempDir = TempDir.createSync("@omp-session-bounded-fork-");
		const storage = new MemorySessionStorage();
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const source = SessionManager.create(cwd, sessionDir, storage);
		const providerPromptCacheKey = "bounded-fork-cache-key";
		await source.newSession({ providerPromptCacheKey });
		const rootId = source.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const selectedId = source.appendMessage({ role: "user", content: "selected", timestamp: Date.now() });
		source.appendMessage({ role: "user", content: "selected descendant", timestamp: Date.now() });
		source.branch(rootId);
		source.appendMessage({ role: "user", content: "later sibling", timestamp: Date.now() });
		await source.ensureOnDisk();
		await source.flush();

		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("expected source session file");
		const cloneFile = path.join(sessionDir, "bounded.jsonl");
		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, storage, {
			sourceLeafId: selectedId,
			sessionFile: cloneFile,
			suppressBreadcrumb: true,
		});

		const cloneEntries = await loadEntriesFromFile(cloneFile, storage);
		const cloneMessages = cloneEntries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		expect(cloneMessages.map(entry => entry.id)).toEqual([rootId, selectedId]);
		expect(
			cloneMessages.map(entry =>
				entry.message.role === "user" && typeof entry.message.content === "string"
					? entry.message.content
					: undefined,
			),
		).toEqual(["root", "selected"]);
		expect(forked.getHeader()?.providerPromptCacheKey).toBe(providerPromptCacheKey);
	});

	it("creates a header-only child when the selected source leaf is null", async () => {
		using tempDir = TempDir.createSync("@omp-session-root-fork-");
		const storage = new MemorySessionStorage();
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const source = SessionManager.create(cwd, sessionDir, storage);
		source.appendMessage({ role: "user", content: "not copied", timestamp: Date.now() });
		await source.ensureOnDisk();
		await source.flush();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("expected source session file");
		const cloneFile = path.join(sessionDir, "root.jsonl");

		await SessionManager.forkFrom(sourceFile, cwd, sessionDir, storage, {
			sourceLeafId: null,
			sessionFile: cloneFile,
			suppressBreadcrumb: true,
		});

		const cloneEntries = await loadEntriesFromFile(cloneFile, storage);
		expect(cloneEntries).toHaveLength(1);
		expect(cloneEntries[0]?.type).toBe("session");
		const reopened = await SessionManager.open(cloneFile, sessionDir, storage, { suppressBreadcrumb: true });
		expect(reopened.getHeader()?.type).toBe("session");
		expect(reopened.getEntries()).toHaveLength(0);
	});
});
