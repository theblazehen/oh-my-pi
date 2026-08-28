/**
 * Verifies parent-discovered rules, extensions, and custom tools are forwarded
 * to `createAgentSession` so subagents skip the FS scans the parent already
 * paid for. Regression guard for issue #2190.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	BranchSummaryEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { runSubprocess, scrubTaskForkEntries } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function isAssistantEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isBranchSummaryEntry(entry: SessionEntry): entry is BranchSummaryEntry {
	return entry.type === "branch_summary";
}

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		clearCheckpointRuntimeState: () => {},
		setTodoPhases: (_phases: unknown[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-pass-through",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function createModelRegistry(model: Model): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards rules, preloadedExtensionPaths, and preloadedCustomToolPaths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.omp/extensions/foo.ts"];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];

		const result = await runSubprocess({
			...baseOptions,
			rules,
			preloadedExtensionPaths,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedCustomToolPaths).toBe(preloadedCustomToolPaths);
	});

	it("forwards an exact credential resolver without replacing it", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const getApiKey = async () => "exact-account-key";

		const result = await runSubprocess({ ...baseOptions, getApiKey });

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.getApiKey).toBe(getApiKey);
	});

	it("forwards undefined when the parent has not pre-discovered state", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.rules).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toBeUndefined();
		expect(forwarded?.preloadedCustomToolPaths).toBeUndefined();
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The registry parent is the spawning agent — never the child itself (the
		// self-parent bug). The child's own id still drives both its agent id and
		// its artifact/output-id prefix; those must not double as the parent link.
		expect(forwarded?.parentAgentId).toBe("SpawnerAgent");
		expect(forwarded?.agentId).toBe("ChildAgent");
		expect(forwarded?.parentTaskPrefix).toBe("ChildAgent");
	});

	it("removes all MCP and discovered capability sources for a restricted child", async () => {
		const session = yieldEmittingSession();
		const persistedInits: Array<{ restrictToolNames?: boolean; tools: string[] }> = [];
		vi.spyOn(session.sessionManager, "appendSessionInit").mockImplementation(init => {
			persistedInits.push(init);
			return "session-init";
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const preloadedExtensionPaths = ["/hostile/extensions/read.ts"];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "/hostile/tools/read.ts", source: { provider: "test", providerName: "Test", level: "project" } },
		];
		const getTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		const mcpManager = { getTools } as unknown as MCPManager;

		const result = await runSubprocess({
			...baseOptions,
			id: "restricted-child",
			restrictToolNames: true,
			mcpManager,
			preloadedExtensionPaths,
			preloadedCustomToolPaths,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			outputSchemaMode: "strict",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.restrictToolNames).toBe(true);
		expect(forwarded?.enableMCP).toBe(false);
		expect(forwarded?.mcpManager).toBeUndefined();
		expect(forwarded?.customTools).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toEqual([]);
		expect(forwarded?.preloadedCustomToolPaths).toEqual([]);
		expect(getTools).not.toHaveBeenCalled();
		expect(forwarded?.outputSchemaMode).toBe("strict");
		expect(persistedInits).toHaveLength(1);
		expect(persistedInits[0]).toMatchObject({ restrictToolNames: true, tools: ["read", "yield"] });
	});

	it("retains inherited MCP proxy tools for normal children", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const mcpManager = {
			getTools: () => [{ name: "mcp__private_read", label: "private/read" }],
		} as unknown as MCPManager;

		const result = await runSubprocess({ ...baseOptions, id: "normal-child", mcpManager });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.enableMCP).toBe(true);
		expect(forwarded?.mcpManager).toBe(mcpManager);
		expect(forwarded?.customTools?.map(tool => tool.name)).toEqual(["mcp__private_read"]);
	});

	it("preserves the legacy result shape when no output schema is selected", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "legacy-output-child" });

		expect(result.exitCode).toBe(0);
		expect(Object.hasOwn(result, "structuredOutput")).toBe(false);
	});

	it("caps caller-requested effort at task.maxEffort", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// The ceiling itself rides into the session so retry-fallback recovery
		// can re-clamp to it after model swaps.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBe(Effort.Low);
	});

	it("rejects a spawn when task.maxEffort is below the model floor", async () => {
		const baseModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!baseModel) throw new Error("Expected gpt-5.6-sol model to exist");
		const model = {
			...baseModel,
			id: "mock-high-only",
			provider: "mock",
			thinking: { mode: "effort", efforts: [Effort.High] },
		} as Model;
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling-below-floor",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"mock/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("preserves the model's full effort range by default", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-default-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(ThinkingLevel.Max);
	});

	it("resolves an explicit task-role effort suffix over the agent-definition default", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}:high`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-precedence",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The user's explicit `:high` suffix on the resolved role pattern wins over
		// the agent definition's default level (e.g. task's `auto`).
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("falls back to the agent-definition thinking level without an explicit suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-thinking-default",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("clones fork entries structurally, scrubbing parent-only control and relinking parents", () => {
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "inherit-evidence", timestamp: 1 },
			},
			{
				type: "custom_message",
				id: "e-prelude",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:01.000Z",
				customType: "eager-task-prelude",
				content: "delegate implementation",
				display: false,
			},
			{
				type: "message",
				id: "e2",
				parentId: "e-prelude",
				timestamp: "2026-08-23T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "parent-finding" },
						{ type: "toolCall", id: "todo-call", name: "todo", arguments: {} },
						{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "x" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "todo-call",
					toolName: "todo",
					content: [],
					isError: false,
					timestamp: 4,
				},
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: "2026-08-23T00:00:04.000Z",
				message: {
					role: "toolResult",
					toolCallId: "read-call",
					toolName: "read",
					content: [{ type: "text", text: "retain-read-result" }],
					isError: false,
					timestamp: 5,
				},
			},
			{
				type: "session_init",
				id: "e-init",
				parentId: "e4",
				timestamp: "2026-08-23T00:00:05.000Z",
				systemPrompt: "test",
				task: "do work",
				tools: ["read"],
			},
			{
				type: "compaction",
				id: "e5",
				parentId: "e-init",
				timestamp: "2026-08-23T00:00:06.000Z",
				summary: "compacted summary",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 10,
			},
			{
				type: "branch_summary",
				id: "e6",
				parentId: "e5",
				timestamp: "2026-08-23T00:00:07.000Z",
				fromId: "e5",
				summary: "branch summary text",
			},
			{
				type: "ttsr_injection",
				id: "e-ttsr",
				parentId: "e6",
				timestamp: "2026-08-23T00:00:07.500Z",
				injectedRules: ["time-traveling-rule"],
			},
			{
				type: "message",
				id: "e7",
				parentId: "e-ttsr",
				timestamp: "2026-08-23T00:00:08.000Z",
				message: { role: "user", content: "post-branch", timestamp: 6 },
			},
		];

		const cloned = scrubTaskForkEntries(forkEntries);

		// Non-conversation runtime/config entries are gone; control custom message gone.
		const ids = cloned.map(entry => entry.id);
		expect(ids).toEqual(["e1", "e2", "e4", "e6", "e7"]);
		expect(cloned.some(entry => entry.type === "session_init")).toBe(false);
		expect(cloned.some(entry => entry.type === "custom_message")).toBe(false);
		expect(cloned.some(entry => entry.type === "ttsr_injection")).toBe(false);
		// Every parent compaction is dropped unconditionally so the retained
		// raw messages replay as full text; the child compacts later on its own.
		expect(cloned.some(entry => entry.id === "e5" && entry.type === "compaction")).toBe(false);

		// The todo control call and its result are gone; the read pair survives.
		const assistant = cloned.find(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.id === "e2" && isAssistantEntry(entry),
		);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("Expected the retained assistant entry");
		expect(assistant.message.content.filter(part => part.type === "toolCall").map(part => part.name)).toEqual([
			"read",
		]);
		expect(cloned.some(entry => entry.id === "e3")).toBe(false); // todo result dropped
		expect(cloned.some(entry => entry.id === "e4")).toBe(true); // read result kept

		// Branch summaries stay structural, never folded into text.
		const branchSummary = cloned.find(
			(entry): entry is BranchSummaryEntry => entry.id === "e6" && isBranchSummaryEntry(entry),
		);
		expect(branchSummary).toBeDefined();
		if (!branchSummary) throw new Error("Expected the retained branch summary");
		expect(branchSummary.summary).toBe("branch summary text");

		// Parent links are relinked to nearest surviving ancestor in original order.
		const parentById = new Map(cloned.map(entry => [entry.id, entry.parentId]));
		expect(parentById.get("e1")).toBeNull();
		expect(parentById.get("e2")).toBe("e1"); // skipped removed prelude parent
		expect(parentById.get("e4")).toBe("e2"); // skipped removed todo result
		expect(parentById.get("e6")).toBe("e4"); // skipped removed session_init + compaction
		expect(parentById.get("e7")).toBe("e6"); // skipped removed ttsr_injection parent

		// Source entries are untouched by the clone.
		const sourceE2 = forkEntries.find(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.id === "e2" && isAssistantEntry(entry),
		);
		if (!sourceE2) throw new Error("Expected source assistant entry e2");
		expect(sourceE2.message.content).toHaveLength(3);
		expect(sourceE2.parentId).toBe("e-prelude");
	});

	it("drops persisted custom runtime diagnostics from inherited history", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "before-runtime-markers", timestamp: 1 },
			},
			{
				type: "custom",
				id: "start",
				parentId: "u1",
				timestamp: "2026-08-23T00:00:01.000Z",
				customType: "tool_execution_start",
				data: { toolCallId: "call-1", toolName: "read" },
			},
			{
				type: "custom",
				id: "exit",
				parentId: "start",
				timestamp: "2026-08-23T00:00:02.000Z",
				customType: "session_exit",
				data: { kind: "normal", reason: "dispose" },
			},
			{
				type: "message",
				id: "u2",
				parentId: "exit",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: { role: "user", content: "after-runtime-markers", timestamp: 2 },
			},
		];

		const cloned = scrubTaskForkEntries(entries);

		expect(cloned.map(entry => entry.id)).toEqual(["u1", "u2"]);
		expect(cloned.some(entry => entry.type === "custom")).toBe(false);
		expect(cloned[1]?.parentId).toBe("u1");
	});

	it("returns deep-independent entries that never share nested state with the source", () => {
		const source: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "question", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "plain" },
						{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "x" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp: "2026-08-23T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "read-call",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 3,
				},
			},
		];

		const cloned = scrubTaskForkEntries(source);

		// Every returned entry is structurally independent: mutating returned
		// nested state must never touch the source session.
		expect(cloned.length).toBe(3);
		for (const returned of cloned) {
			expect(returned).not.toBe(source.find(entry => entry.id === returned.id));
		}
		const clonedAssistant = cloned.find(isAssistantEntry);
		if (!clonedAssistant) throw new Error("Expected assistant entry in cloned output");
		const sourceA1 = source.find(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.id === "a1" && isAssistantEntry(entry),
		);
		if (!sourceA1) throw new Error("Expected source assistant entry a1");
		expect(clonedAssistant.message.content).not.toBe(sourceA1.message.content);
		// Mutating a returned nested array/object must not leak back into source.
		const firstBlock = clonedAssistant.message.content[0];
		if (firstBlock && typeof firstBlock === "object" && "text" in firstBlock) {
			firstBlock.text = "mutated";
		}
		const sourceAssistant = source.find(isAssistantEntry);
		const sourceFirst = sourceAssistant?.message.content[0];
		expect(
			sourceFirst && typeof sourceFirst === "object" && "text" in sourceFirst ? sourceFirst.text : undefined,
		).toBe("plain");
	});

	it("seeds from frozen entries directly, dropping the parent compaction and keeping ordered raw text", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "before-boundary", timestamp: 1 },
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: "first-retained", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "e5",
				parentId: "e2",
				timestamp: "2026-08-23T00:00:03.000Z",
				summary: "compacted summary",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 10,
			},
			{
				type: "message",
				id: "e3",
				parentId: "e5",
				timestamp: "2026-08-23T00:00:04.000Z",
				message: { role: "user", content: "after-boundary", timestamp: 3 },
			},
		];

		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-frozen-entries-drop",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(textOnlyModel),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e3",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		// The parent compaction is dropped unconditionally; both sides of its
		// boundary survive as ordinary raw text in original order.
		expect(childEntries.map(entry => entry.id)).toEqual(["e1", "e2", "e3"]);
		expect(childEntries.some(entry => entry.type === "compaction")).toBe(false);
		expect(
			childEntries.map(entry =>
				entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined,
			),
		).toEqual(["before-boundary", "first-retained", "after-boundary"]);
	});

	it("neutralizes protected reasoning on control-only assistant rewrites", () => {
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "question", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoned", thinkingSignature: "sig-1" },
						{ type: "redactedThinking", data: "encrypted" },
						{ type: "text", text: "after-control" },
						{ type: "toolCall", id: "todo-call", name: "todo", arguments: {} },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
		];

		const cloned = scrubTaskForkEntries(forkEntries);
		const assistant = cloned.find(isAssistantEntry);
		if (!assistant) throw new Error("Expected assistant entry in cloned output");
		// The control scrub dropped the todo call; the second-pass dangling
		// cleanup makes no further change, but protected reasoning is still
		// neutralized: redactedThinking dropped, thinking signature cleared.
		expect(assistant.message.content.map(part => part.type)).toEqual(["thinking", "text"]);
		const thinking = assistant.message.content.find(
			(part): part is { type: "thinking"; thinking: string; thinkingSignature?: string } => part.type === "thinking",
		);
		expect(thinking?.thinkingSignature).toBeUndefined();
		expect(thinking?.thinking).toBe("reasoned");
		expect(assistant.message.content.some(part => part.type === "redactedThinking")).toBe(false);
	});

	it("drops every parent compaction — Snapcompact, remote, and LLM — keeping full ordered raw text", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		// A parent branch carrying raw message history bracketed by three
		// distinct compaction kinds — a Snapcompact archive, a remote (OpenAI)
		// replay payload, and a plain LLM summary — all of which the fork must
		// drop unconditionally so every persisted message replays as full text.
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "pre-snapcompact", timestamp: 1 },
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: "pre-remote", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "e-snap",
				parentId: "e2",
				timestamp: "2026-08-23T00:00:02.000Z",
				summary: "snapcompact summary",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 20,
				preserveData: {
					snapcompact: {
						frames: [
							{
								data: "aW1hZ2UtcG5nLWJhc2U2NA==",
								mimeType: "image/png",
								cols: 80,
								rows: 24,
								chars: 900,
							},
						],
						totalChars: 900,
						truncatedChars: 0,
						text: "archived history",
					},
				},
			},
			{
				type: "message",
				id: "e-remote-in",
				parentId: "e-snap",
				timestamp: "2026-08-23T00:00:02.500Z",
				message: { role: "user", content: "pre-llm", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "e-remote",
				parentId: "e-remote-in",
				timestamp: "2026-08-23T00:00:03.000Z",
				summary: "remote summarized",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 10,
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [{ type: "message", role: "user", content: "opaque native replay" }],
					},
				},
			},
			{
				type: "message",
				id: "e-llm-in",
				parentId: "e-remote",
				timestamp: "2026-08-23T00:00:03.500Z",
				message: { role: "user", content: "pre-llm", timestamp: 3 },
			},
			{
				type: "compaction",
				id: "e-llm",
				parentId: "e-llm-in",
				timestamp: "2026-08-23T00:00:04.000Z",
				summary: "llm summarized",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 5,
			},
			{
				type: "message",
				id: "e3",
				parentId: "e-llm",
				timestamp: "2026-08-23T00:00:05.000Z",
				message: { role: "user", content: "after-all-compactions", timestamp: 4 },
			},
		];

		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-snapcompact-drop",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(textOnlyModel),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e3",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();

		// Every compaction kind is dropped; the raw text messages on both
		// sides of each boundary survive in original order with no parent
		// compaction/replay data.
		expect(childEntries.map(entry => entry.id)).toEqual(["e1", "e2", "e-remote-in", "e-llm-in", "e3"]);
		expect(childEntries.filter(entry => entry.type === "compaction")).toEqual([]);
		expect(
			childEntries.map(entry =>
				entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined,
			),
		).toEqual(["pre-snapcompact", "pre-remote", "pre-llm", "pre-llm", "after-all-compactions"]);

		// Built context: every persisted raw text message is present in order,
		// with no compactionSummary and no archive/replay/image data anywhere.
		const context = childManager.buildSessionContext();
		const roles = context.messages.map(message => message.role);
		expect(roles).toEqual(["user", "user", "user", "user", "user"]);
		expect(context.messages.map(message => ("content" in message ? message.content : message))).toEqual([
			"pre-snapcompact",
			"pre-remote",
			"pre-llm",
			"pre-llm",
			"after-all-compactions",
		]);
		for (const message of context.messages) {
			const content = "content" in message ? message.content : [];
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && "type" in part && part.type === "image") {
						throw new Error("forked child context must not carry image data");
					}
				}
			}
		}
	});

	it("provider-neutralizes every inherited assistant while dropping its compaction, keeping visible evidence", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		// A parent branch with an UNMODIFIED assistant (no control calls to
		// scrub, so the first-pass neutralization is the only rewrite) that
		// still carries signed thinking + redactedThinking + providerPayload,
		// and a compaction whose preserveData carries an openaiRemoteCompaction
		// replay payload. The compaction is dropped wholesale so no replay
		// payload ever reaches the child.
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "pre-compaction-evidence", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "visible-reasoned", thinkingSignature: "sig-1" },
						{ type: "redactedThinking", data: "encrypted-blob" },
						{ type: "text", text: "visible-answer" },
					],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "test",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [{ type: "reasoning", id: "rs_parent", summary: [], content: [] }],
					},
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: "2026-08-23T00:00:02.000Z",
				summary: "compacted summary",
				shortSummary: "short",
				firstKeptEntryId: "u1",
				tokensBefore: 10,
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [{ type: "message", role: "user", content: "opaque native replay" }],
					},
					artifactIndex: { version: 1, count: 3 },
				},
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: { role: "user", content: "post-compaction-evidence", timestamp: 3 },
			},
		];

		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-provider-neutralize",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(textOnlyModel),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "u2",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		// The compaction is dropped; the raw assistant + surrounding text survive.
		expect(childEntries.map(entry => entry.id)).toEqual(["u1", "a1", "u2"]);
		expect(childEntries.some(entry => entry.type === "compaction")).toBe(false);

		// Raw child assistant: visible thinking/text survive, but no
		// redactedThinking, no thinking signature, and no providerPayload.
		const childAssistant = childEntries.find(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.id === "a1" && isAssistantEntry(entry),
		);
		expect(childAssistant).toBeDefined();
		if (!childAssistant) throw new Error("Expected the retained assistant entry");
		expect(childAssistant.message.content.map(part => part.type)).toEqual(["thinking", "text"]);
		const childThinking = childAssistant.message.content.find(
			(part): part is { type: "thinking"; thinking: string; thinkingSignature?: string } => part.type === "thinking",
		);
		expect(childThinking).toBeDefined();
		if (!childThinking) throw new Error("Expected the retained thinking block");
		expect(childThinking.thinking).toBe("visible-reasoned");
		expect(childThinking.thinkingSignature).toBeUndefined();
		expect(childAssistant.message.content.some(part => part.type === "redactedThinking")).toBe(false);
		expect(childAssistant.message.providerPayload).toBeUndefined();

		// Built child context: the assistant's visible text/thinking survive,
		// no compactionSummary is emitted, and no provider-native replay state
		// anywhere.
		const context = childManager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(false);
		// Every built message that can carry provider-native replay state is free
		// of it: no providerPayload, no redactedThinking, and no thinking
		// signature anywhere in the inherited conversation.
		for (const message of context.messages) {
			if ("providerPayload" in message) expect(message.providerPayload).toBeUndefined();
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type === "redactedThinking") throw new Error("built assistant must not carry redactedThinking");
				if (part.type === "thinking") expect(part.thinkingSignature).toBeUndefined();
			}
		}
		const assistantContext = context.messages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistantContext).toBeDefined();
		if (!assistantContext) throw new Error("Expected assistant message in built context");
		expect(assistantContext.content.some(part => part.type === "text" && part.text === "visible-answer")).toBe(true);
		expect(
			assistantContext.content.some(
				(part): part is { type: "thinking"; thinking: string } =>
					part.type === "thinking" && part.thinking === "visible-reasoned",
			),
		).toBe(true);
		expect(assistantContext.content.some(part => part.type === "redactedThinking")).toBe(false);
		expect(assistantContext.providerPayload).toBeUndefined();
	});

	it("keeps fresh execution on the existing child path", async () => {
		const session = yieldEmittingSession();
		const clearCheckpointRuntimeState = vi.spyOn(session, "clearCheckpointRuntimeState");
		const setTodoPhases = vi.spyOn(session, "setTodoPhases");
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		// A valid frozen snapshot that the fresh path must never consume: if the
		// child were seeded from it, its entries would appear in the child
		// manager. They must not.
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "fork-e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "must-not-inherit", timestamp: 1 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			contextSource: "fresh",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "fork-e1",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		// The fresh path never seeded the frozen parent entries.
		expect(childManager.getEntries().some(entry => entry.id === "fork-e1")).toBe(false);
		expect(clearCheckpointRuntimeState).not.toHaveBeenCalled();
		expect(setTodoPhases).not.toHaveBeenCalled();
	});

	it("fails explicit fork when the scheduling snapshot is unavailable", async () => {
		const result = await runSubprocess({ ...baseOptions, contextSource: "fork" });

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
	});

	it("fails an explicit fork whose frozen snapshot is empty", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-empty-snapshot",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e7",
				entries: [],
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("empty");
	});

	it("fails an explicit fork whose snapshot does not end at the located leaf", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "root", timestamp: 1 },
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: "tail", timestamp: 2 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-leaf-mismatch",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e-other",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("does not end at the located leaf");
	});

	it("fails an explicit fork whose snapshot does not start at a root entry", async () => {
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "non-root", timestamp: 1 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-non-root-snapshot",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e2",
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("does not start at a root entry");
	});

	it("forks native context for a text-only resolved model with raw child entries and built context", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		// A completed parent branch carrying conversational evidence, a control
		// entry that must not survive into the child, and a runtime entry.
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "inherit-evidence", timestamp: 1 },
			},
			{
				type: "session_init",
				id: "e-init",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:00.500Z",
				systemPrompt: "test",
				task: "do work",
				tools: ["read"],
			},
			{
				type: "message",
				id: "e2",
				parentId: "e-init",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "parent-finding" },
						{ type: "toolCall", id: "todo-call", name: "todo", arguments: {} },
						{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "x" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: "2026-08-23T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "todo-call",
					toolName: "todo",
					content: [],
					isError: false,
					timestamp: 4,
				},
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "read-call",
					toolName: "read",
					content: [{ type: "text", text: "retain-read-result" }],
					isError: false,
					timestamp: 5,
				},
			},
			{
				type: "compaction",
				id: "e5",
				parentId: "e4",
				timestamp: "2026-08-23T00:00:04.000Z",
				summary: "compacted summary",
				shortSummary: "short",
				firstKeptEntryId: "e1",
				tokensBefore: 10,
				preserveData: {
					// Unrelated, non-Snapcompact hook data that must be carried
					// verbatim across the fork — never dropped with Snapcompact
					// archives and never regenerated.
					artifactIndex: { version: 1, count: 3 },
				},
			},
			{
				type: "branch_summary",
				id: "e6",
				parentId: "e5",
				timestamp: "2026-08-23T00:00:05.000Z",
				fromId: "e5",
				summary: "branch summary text",
			},
			{
				type: "message",
				id: "e7",
				parentId: "e6",
				timestamp: "2026-08-23T00:00:06.000Z",
				message: { role: "user", content: "post-branch", timestamp: 6 },
			},
		];

		const session = yieldEmittingSession();
		const clearCheckpointRuntimeState = vi.spyOn(session, "clearCheckpointRuntimeState");
		const setTodoPhases = vi.spyOn(session, "setTodoPhases");
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		// The child transcript must live at a real path for the fork session to
		// materialize; point artifacts at a throwaway temp dir.
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-text-only-fork",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(textOnlyModel),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e7",
				entries: forkEntries,
			},
		});

		// A text-only model must neither be rejected at model resolution nor by
		// the fork seeding path (Snapcompact/vision requirement removed).
		expect(result.exitCode).toBe(0);
		// Parent-only runtime control is dropped from the child.
		expect(clearCheckpointRuntimeState).toHaveBeenCalled();
		expect(setTodoPhases).toHaveBeenCalledWith([]);

		// Assert the actual child SessionManager passed to createAgentSession:
		// raw persisted entries preserve structural order, exclude runtime/config
		// and control state, and keep valid parent links + tool pairing.
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		// The parent compaction is dropped; runtime/config + control are gone;
		// the branch summary stays structural.
		expect(childEntries.map(entry => entry.id)).toEqual(["e1", "e2", "e4", "e6", "e7"]);
		expect(childEntries.some(entry => entry.type === "session_init")).toBe(false);
		expect(childEntries.some(entry => entry.type === "compaction")).toBe(false);
		expect(childEntries.find(entry => entry.id === "e6")?.type).toBe("branch_summary");

		// Parent links are relinked to nearest surviving ancestor, forming a chain.
		const childParentById = new Map(childEntries.map(entry => [entry.id, entry.parentId]));
		expect(childParentById.get("e1")).toBeNull();
		expect(childParentById.get("e2")).toBe("e1");
		expect(childParentById.get("e4")).toBe("e2");
		expect(childParentById.get("e6")).toBe("e4"); // skipped removed session_init + compaction
		expect(childParentById.get("e7")).toBe("e6");

		// Tool pairing: the read call/result survive, the todo call/result do not.
		const childAssistant = childEntries.find(
			(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
				entry.id === "e2" && isAssistantEntry(entry),
		);
		expect(childAssistant).toBeDefined();
		if (!childAssistant) throw new Error("Expected the retained assistant entry");
		expect(childAssistant.message.content.filter(part => part.type === "toolCall").map(part => part.name)).toEqual([
			"read",
		]);
		expect(childEntries.some(entry => entry.id === "e3")).toBe(false);
		expect(childEntries.some(entry => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);

		// Built context is ordered inherited text, with no dangling tool calls or
		// orphan results, no compactionSummary, and no newly-created archive/image
		// data.
		const context = childManager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"branchSummary",
			"user",
		]);
		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(false);
		const assistantContext = context.messages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistantContext).toBeDefined();
		if (!assistantContext) throw new Error("Expected an assistant context message");
		expect(assistantContext.content.filter(part => part.type === "toolCall").map(part => part.name)).toEqual([
			"read",
		]);
		expect(context.messages.some(message => message.role === "toolResult")).toBe(true);
		// No image blocks anywhere (no archive / no snapcompact).
		for (const message of context.messages) {
			const content = "content" in message ? message.content : [];
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && "type" in part && part.type === "image") {
						throw new Error("forked child context must not carry image data");
					}
				}
			}
		}
	});
});
