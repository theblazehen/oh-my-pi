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
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult, PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	BranchSummaryEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	runSubprocess,
	scrubTaskForkEntries,
	selectEffectiveTaskForkEntries,
} from "@oh-my-pi/pi-coding-agent/task/executor";
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
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
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

function taskForkModel(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
	return model;
}

function scrubForModel(entries: readonly SessionEntry[], childModel: Model = taskForkModel()): SessionEntry[] {
	return scrubTaskForkEntries(entries, { parentModel: null, childModel });
}

function resolvedForkModelOptions() {
	const model = taskForkModel();
	const settings = Settings.isolated();
	settings.setModelRole("task", `${model.provider}/${model.id}`);
	return {
		agent: { ...baseAgent, model: ["@task"] },
		settings,
		modelRegistry: createModelRegistry(model),
	};
}

function remoteReplayForkEntries(remoteCompaction: unknown): SessionEntry[] {
	return [
		{
			type: "message",
			id: "remote-kept",
			parentId: null,
			timestamp: "2026-08-23T00:00:00.000Z",
			message: { role: "user", content: "portable kept tail", timestamp: 1 },
		},
		{
			type: "compaction",
			id: "remote-compaction",
			parentId: "remote-kept",
			timestamp: "2026-08-23T00:00:01.000Z",
			summary: "portable compacted summary",
			shortSummary: "remote",
			firstKeptEntryId: "remote-kept",
			tokensBefore: 20,
			preserveData: { openaiRemoteCompaction: remoteCompaction },
		},
		{
			type: "message",
			id: "remote-after",
			parentId: "remote-compaction",
			timestamp: "2026-08-23T00:00:02.000Z",
			message: { role: "user", content: "portable post-compaction tail", timestamp: 2 },
		},
	];
}

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards rules, extension-root policy, prepared extensions, and preloaded source paths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.omp/extensions/foo.ts"];
		const preloadedPreparedExtensions: PreparedExtension[] = [
			{
				path: preloadedExtensionPaths[0]!,
				resolvedPath: preloadedExtensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];
		const extensionRoots = () => ({
			explicit: ["/abs/parent/explicit-extension"],
			mode: "explicit-only" as const,
			configured: ["/abs/parent/configured-extension"],
			configuredLevel: "project" as const,
		});

		const result = await runSubprocess({
			...baseOptions,
			rules,
			extensionRoots,
			preloadedExtensionPaths,
			preloadedPreparedExtensions,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.extensionRoots).toBe(extensionRoots);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedPreparedExtensions).toBe(preloadedPreparedExtensions);
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
	it("preserves empty and absent agent tool declarations through session creation", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const emptyFields = parseAgentFields({ name: "quiet", description: "desc", tools: [] });
		const absentFields = parseAgentFields({ name: "default", description: "desc" });
		if (!emptyFields || !absentFields) throw new Error("agent fields did not parse");

		const emptyResult = await runSubprocess({
			...baseOptions,
			id: "empty-tools-child",
			agent: { ...baseAgent, ...emptyFields },
		});
		const absentResult = await runSubprocess({
			...baseOptions,
			id: "default-tools-child",
			agent: { ...baseAgent, ...absentFields },
		});

		expect(emptyResult.exitCode).toBe(0);
		expect(absentResult.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.toolNames).toEqual(["yield", "hub"]);
		expect(spy.mock.calls[1]?.[0]?.toolNames).toBeUndefined();
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
		const preloadedPreparedExtensions: PreparedExtension[] = [
			{
				path: preloadedExtensionPaths[0]!,
				resolvedPath: preloadedExtensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		];
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
			preloadedPreparedExtensions,
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
		expect(forwarded?.preloadedPreparedExtensions).toEqual([]);
		expect(forwarded?.preloadedCustomToolPaths).toEqual([]);
		expect(getTools).not.toHaveBeenCalled();
		expect(forwarded?.outputSchemaMode).toBe("strict");
		expect(persistedInits).toHaveLength(1);
		expect(persistedInits[0]).toMatchObject({ restrictToolNames: true, tools: ["read", "yield"] });
	});

	it("persists bridge-only tools in the enabled Code Mode set", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["eval", "yield"]);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["eval", "read", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "code-mode-child" });

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["eval", "read", "yield"] }));
	});

	it("omits transport-only write from the persisted cold-revival contract", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "transport-only-child",
			agent: { ...baseAgent, tools: ["read"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "yield"] }));
	});

	it("persists write when the original subagent contract grants it", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "write", "yield"] }));
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
	it("persists an explicit role from a caller model override", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			modelRoles: { reviewer: `${model.provider}/${model.id}` },
		});
		const session = yieldEmittingSession();
		const initSpy = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-model-override-role",
			modelOverride: "@reviewer",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ modelRole: "reviewer" }));
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

		const cloned = scrubForModel(forkEntries);

		// Non-conversation runtime/config entries are gone; control custom message gone.
		const ids = cloned.map(entry => entry.id);
		expect(ids).toEqual(["e1", "e2", "e4", "e5", "e6", "e7"]);
		expect(cloned.some(entry => entry.type === "session_init")).toBe(false);
		expect(cloned.some(entry => entry.type === "custom_message")).toBe(false);
		expect(cloned.some(entry => entry.type === "ttsr_injection")).toBe(false);
		// The effective compaction stays structural so inherited context remains
		// bounded to its summary plus retained tail.
		expect(cloned.some(entry => entry.id === "e5" && entry.type === "compaction")).toBe(true);

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
		expect(parentById.get("e5")).toBe("e4"); // skipped removed session_init
		expect(parentById.get("e6")).toBe("e5");
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

		const cloned = scrubForModel(entries);

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

		const cloned = scrubForModel(source);

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

	it("seeds only the latest compaction's bounded summary and retained tail in order", async () => {
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
				message: { role: "user", content: "superseded-before-boundary", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "e-old-compaction",
				parentId: "e1",
				timestamp: "2026-08-23T00:00:00.500Z",
				summary: "superseded summary",
				shortSummary: "old",
				firstKeptEntryId: "e1",
				tokensBefore: 20,
			},
			{
				type: "message",
				id: "e2",
				parentId: "e-old-compaction",
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
				firstKeptEntryId: "e2",
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
		const boundedEntries = selectEffectiveTaskForkEntries(forkEntries);
		expect(boundedEntries.map(entry => entry.id)).toEqual(["e2", "e5", "e3"]);
		expect(boundedEntries[0]?.parentId).toBeNull();

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
				parentModel: { provider: model.provider, id: model.id },
				entries: boundedEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		expect(childEntries.map(entry => entry.id)).toEqual(["e2", "e5", "e3"]);
		expect(childEntries.find(entry => entry.id === "e5")?.type).toBe("compaction");
		expect(childManager.buildSessionContext().messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"user",
		]);
		expect(
			childManager
				.buildSessionContext()
				.messages.map(message => ("content" in message ? message.content : undefined)),
		).toEqual([undefined, "first-retained", "after-boundary"]);
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

		const cloned = scrubForModel(forkEntries);
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

	it("preserves remote replay only for the exact captured parent and child model", async () => {
		const model = taskForkModel();
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const compactionItem = { type: "compaction", encrypted_content: "opaque-compatible-compaction" };
		const replacementHistory = [
			{ type: "message", role: "user", content: "opaque compatible replay" },
			compactionItem,
		];
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "remote-superseded",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "must-not-replay-as-raw-text", timestamp: 1 },
			},
			{
				type: "message",
				id: "remote-kept",
				parentId: "remote-superseded",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: "kept-by-native-replay", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "remote-compaction",
				parentId: "remote-kept",
				timestamp: "2026-08-23T00:00:02.000Z",
				summary: "compatible remote summary",
				shortSummary: "remote",
				firstKeptEntryId: "remote-kept",
				tokensBefore: 20,
				details: { privateExtensionState: true },
				preserveData: {
					openaiRemoteCompaction: {
						provider: model.provider,
						replacementHistory,
						compactionItem,
					},
					artifactIndex: { version: 1 },
				},
			},
			{
				type: "message",
				id: "remote-after",
				parentId: "remote-compaction",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: { role: "user", content: "after-compatible-replay", timestamp: 3 },
			},
		];

		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-compatible-remote-replay",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "remote-after",
				parentModel: { provider: model.provider, id: model.id },
				entries: selectEffectiveTaskForkEntries(forkEntries),
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => entry.id)).toEqual([
			"remote-kept",
			"remote-compaction",
			"remote-after",
		]);
		const compaction = childManager.getEntries().find(entry => entry.id === "remote-compaction");
		expect(compaction?.type).toBe("compaction");
		if (compaction?.type !== "compaction") throw new Error("Expected remote compaction");
		expect(compaction.details).toBeUndefined();
		expect(compaction.preserveData).toEqual({
			openaiRemoteCompaction: { provider: model.provider, replacementHistory, compactionItem },
		});
		const context = childManager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user"]);
		const summary = context.messages.find(message => message.role === "compactionSummary");
		expect(summary?.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: model.provider,
			items: replacementHistory,
		});
	});

	for (const malformedReplay of [
		{
			name: "provider mismatch",
			value: {
				provider: "different-provider",
				replacementHistory: [{ type: "message", role: "user", content: "wrong-provider replay" }],
			},
		},
		{
			name: "malformed replacementHistory",
			value: {
				provider: taskForkModel().provider,
				replacementHistory: [{ type: "message", role: "user", content: "valid item" }, "not-a-record"],
			},
		},
		{
			name: "empty replacementHistory",
			value: {
				provider: taskForkModel().provider,
				replacementHistory: [],
			},
		},
		{
			name: "record-only replacementHistory without a compaction item",
			value: {
				provider: taskForkModel().provider,
				replacementHistory: [
					{ type: "message", role: "user", content: "native replay without compaction" },
					{ type: "reasoning", encrypted_content: "opaque-reasoning" },
				],
			},
		},
		{
			name: "V2 compaction discriminator without encrypted content",
			value: {
				version: "v2",
				provider: taskForkModel().provider,
				replacementHistory: [
					{ type: "message", role: "user", content: "native replay before malformed compaction" },
					{ type: "compaction" },
				],
			},
		},
		{
			name: "V2 valid compaction with a bogus retained sibling",
			value: {
				version: "v2",
				provider: taskForkModel().provider,
				replacementHistory: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "well-formed retained user message" }],
					},
					{ type: "bogus_replay_item", content: "must not pass V2 replay validation" },
					{ type: "compaction", encrypted_content: "otherwise-valid-terminal-compaction" },
				],
			},
		},
	]) {
		it(`strips same-model remote replay with ${malformedReplay.name} and keeps portable summary and tail`, async () => {
			const model = taskForkModel();
			const settings = Settings.isolated();
			settings.setModelRole("task", `${model.provider}/${model.id}`);
			const session = yieldEmittingSession();
			const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
			const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
			const forkEntries = remoteReplayForkEntries(malformedReplay.value);

			const result = await runSubprocess({
				...baseOptions,
				agent: { ...baseAgent, model: ["@task"] },
				id: `subagent-malformed-remote-${malformedReplay.name.replaceAll(" ", "-")}`,
				artifactsDir,
				settings,
				modelRegistry: createModelRegistry(model),
				contextSource: "fork",
				forkContext: {
					sourceFile: "/tmp/source.jsonl",
					sourceLeafId: "remote-after",
					parentModel: { provider: model.provider, id: model.id },
					entries: forkEntries,
				},
			});

			expect(result.exitCode).toBe(0);
			expect(createSpy).toHaveBeenCalledTimes(1);
			const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
			expect(childManager).toBeDefined();
			if (!childManager) throw new Error("Expected a child SessionManager");
			const childCompaction = childManager.getEntries().find(entry => entry.id === "remote-compaction");
			expect(childCompaction?.type).toBe("compaction");
			if (childCompaction?.type !== "compaction") throw new Error("Expected retained compaction");
			expect(childCompaction.preserveData).toBeUndefined();

			const context = childManager.buildSessionContext();
			expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user", "user"]);
			const summary = context.messages[0];
			expect(summary?.role).toBe("compactionSummary");
			if (summary?.role !== "compactionSummary") throw new Error("Expected portable compaction summary");
			expect(summary.summary).toBe("portable compacted summary");
			expect(summary.providerPayload).toBeUndefined();
			expect(context.messages[1]).toMatchObject({ role: "user", content: "portable kept tail" });
			expect(context.messages[2]).toMatchObject({ role: "user", content: "portable post-compaction tail" });
		});
	}

	it("keeps summary and tail but strips remote and Snapcompact payloads for an incompatible text-only child", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		// The latest effective compaction carries both opaque remote replay and
		// image-only Snapcompact state. Neither may cross to a different model
		// whose input capabilities are text-only.
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
				firstKeptEntryId: "e-llm-in",
				tokensBefore: 5,
				details: { privateExtensionState: true },
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [{ type: "message", role: "user", content: "opaque latest replay" }],
					},
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
						text: "latest archived history",
					},
					artifactIndex: { version: 1 },
				},
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
				parentModel: { provider: "openai", id: "different-parent-model" },
				entries: selectEffectiveTaskForkEntries(forkEntries),
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();

		expect(childEntries.map(entry => entry.id)).toEqual(["e-llm-in", "e-llm", "e3"]);
		const retainedCompaction = childEntries.find(entry => entry.id === "e-llm");
		expect(retainedCompaction?.type).toBe("compaction");
		if (retainedCompaction?.type !== "compaction") {
			throw new Error("Expected retained compaction");
		}
		expect(retainedCompaction.summary).toBe("llm summarized");
		expect(retainedCompaction.details).toBeUndefined();
		expect(retainedCompaction.preserveData).toBeUndefined();

		// Built context remains bounded to summary + kept tail and cannot carry
		// remote replay or image blocks into the incompatible text-only model.
		const context = childManager.buildSessionContext();
		const roles = context.messages.map(message => message.role);
		expect(roles).toEqual(["compactionSummary", "user", "user"]);
		const summary = context.messages.find(message => message.role === "compactionSummary");
		expect(summary?.providerPayload).toBeUndefined();
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

	it("provider-neutralizes inherited assistants while retaining the bounded compaction summary", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const textOnlyModel = { ...model, input: ["text"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		// A parent branch with an UNMODIFIED assistant (no control calls to
		// scrub, so the first-pass neutralization is the only rewrite) that
		// still carries signed thinking + redactedThinking + providerPayload,
		// and a compaction whose preserveData carries an incompatible remote
		// replay payload. The summary remains, but opaque replay state does not.
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
				parentModel: { provider: "openai", id: "different-parent-model" },
				entries: selectEffectiveTaskForkEntries(forkEntries),
			},
		});

		expect(result.exitCode).toBe(0);
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		// The bounded compaction and its visible retained assistant survive.
		expect(childEntries.map(entry => entry.id)).toEqual(["u1", "a1", "c1", "u2"]);
		const childCompaction = childEntries.find(entry => entry.id === "c1");
		expect(childCompaction?.type).toBe("compaction");
		if (childCompaction?.type !== "compaction") throw new Error("Expected child compaction");
		expect(childCompaction.preserveData).toBeUndefined();

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
		// its compactionSummary is emitted, and no provider-native replay state
		// appears anywhere.
		const context = childManager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "user", "assistant", "user"]);
		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(true);
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
				parentModel: null,
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
		const openSpy = vi.spyOn(SessionManager, "open");
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const result = await runSubprocess({ ...baseOptions, contextSource: "fork" });

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(openSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("fails an explicit fork whose frozen snapshot is empty", async () => {
		const session = yieldEmittingSession();
		const openSpy = vi.spyOn(SessionManager, "open");
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));

		const result = await runSubprocess({
			...baseOptions,
			...resolvedForkModelOptions(),
			id: "subagent-empty-snapshot",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e7",
				parentModel: null,
				entries: [],
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("empty");
		expect(openSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("fails an explicit fork whose snapshot does not end at the located leaf", async () => {
		const openSpy = vi.spyOn(SessionManager, "open");
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
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
			...resolvedForkModelOptions(),
			id: "subagent-leaf-mismatch",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e-other",
				parentModel: null,
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("does not end at the located leaf");
		expect(openSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("fails an explicit fork whose snapshot does not start at a root entry", async () => {
		const openSpy = vi.spyOn(SessionManager, "open");
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
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
			...resolvedForkModelOptions(),
			id: "subagent-non-root-snapshot",
			artifactsDir,
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "e2",
				parentModel: null,
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Cannot fork task context");
		expect(result.error).toContain("does not start at a root entry");
		expect(openSpy).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("falls back from oversized portable compaction to the largest fitting coherent tail", async () => {
		const model = { ...taskForkModel(), contextWindow: 512 } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "portable-kept",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: "retained before compaction", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "portable-compaction",
				parentId: "portable-kept",
				timestamp: "2026-08-23T00:00:01.000Z",
				summary: `inherited summary ${"large ".repeat(2_000)}`,
				shortSummary: "oversized",
				firstKeptEntryId: "portable-kept",
				tokensBefore: 10_000,
			},
			{
				type: "message",
				id: "portable-too-large",
				parentId: "portable-compaction",
				timestamp: "2026-08-23T00:00:02.000Z",
				message: { role: "user", content: `older tail ${"large ".repeat(1_000)}`, timestamp: 2 },
			},
			{
				type: "custom_message",
				id: "portable-custom-boundary",
				parentId: "portable-too-large",
				timestamp: "2026-08-23T00:00:03.000Z",
				customType: "portable-context",
				content: "coherent custom boundary",
				display: true,
			},
			{
				type: "message",
				id: "portable-final",
				parentId: "portable-custom-boundary",
				timestamp: "2026-08-23T00:00:04.000Z",
				message: { role: "user", content: "small final turn", timestamp: 4 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			description: "portable tail fallback",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-portable-tail-fallback",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "portable-final",
				parentModel: { provider: model.provider, id: model.id },
				entries: selectEffectiveTaskForkEntries(forkEntries),
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "portable-custom-boundary", parentId: null },
			{ id: "portable-final", parentId: "portable-custom-boundary" },
		]);
		expect(childManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("removes an orphaned tool result created by coherent suffix slicing", async () => {
		const model = { ...taskForkModel(), contextWindow: 512 } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "pairing-compaction",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				summary: `oversized pairing summary ${"large ".repeat(2_000)}`,
				shortSummary: "pairing",
				firstKeptEntryId: "pairing-compaction",
				tokensBefore: 10_000,
			},
			{
				type: "message",
				id: "pairing-older-user",
				parentId: "pairing-compaction",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: `older turn ${"large ".repeat(1_000)}`, timestamp: 2 },
			},
			{
				type: "message",
				id: "pairing-call",
				parentId: "pairing-older-user",
				timestamp: "2026-08-23T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "split-read-call", name: "read", arguments: { path: "x" } }],
					api: "openai-responses",
					provider: model.provider,
					model: model.id,
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
				type: "custom_message",
				id: "pairing-custom-boundary",
				parentId: "pairing-call",
				timestamp: "2026-08-23T00:00:03.000Z",
				customType: "portable-context",
				content: "coherent boundary between call and result",
				display: true,
			},
			{
				type: "message",
				id: "pairing-result",
				parentId: "pairing-custom-boundary",
				timestamp: "2026-08-23T00:00:04.000Z",
				message: {
					role: "toolResult",
					toolCallId: "split-read-call",
					toolName: "read",
					content: [{ type: "text", text: "must not become an orphan" }],
					isError: false,
					timestamp: 4,
				},
			},
			{
				type: "message",
				id: "pairing-final",
				parentId: "pairing-result",
				timestamp: "2026-08-23T00:00:05.000Z",
				message: { role: "user", content: "small final turn", timestamp: 5 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			description: "paired suffix fallback",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-paired-suffix-fallback",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "pairing-final",
				parentModel: { provider: model.provider, id: model.id },
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "pairing-custom-boundary", parentId: null },
			{ id: "pairing-final", parentId: "pairing-custom-boundary" },
		]);
		expect(childManager.buildSessionContext().messages.some(message => message.role === "toolResult")).toBe(false);
	});

	it("conservatively sizes classic replay despite stale positive usedTokens", async () => {
		const model = { ...taskForkModel(), contextWindow: 4_096 } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const compactionItem = { type: "compaction", encrypted_content: "classic-opaque-summary" };
		const forkEntries = remoteReplayForkEntries({
			provider: model.provider,
			replacementHistory: [
				{ type: "message", role: "user", content: `oversized classic replay ${"history ".repeat(20_000)}` },
				compactionItem,
			],
			compactionItem,
			usedTokens: 1,
		});

		const result = await runSubprocess({
			...baseOptions,
			description: "classic stale usage fallback",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-classic-stale-usage-fallback",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "remote-after",
				parentModel: { provider: model.provider, id: model.id },
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => entry.id)).toEqual([
			"remote-kept",
			"remote-compaction",
			"remote-after",
		]);
		const childCompaction = childManager.getEntries().find(entry => entry.id === "remote-compaction");
		expect(childCompaction?.type).toBe("compaction");
		if (childCompaction?.type !== "compaction") throw new Error("Expected retained compaction");
		expect(childCompaction.preserveData).toBeUndefined();
		const summary = childManager.buildSessionContext().messages[0];
		expect(summary?.role).toBe("compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected portable compaction summary");
		expect(summary.providerPayload).toBeUndefined();
	});

	it("falls back from oversized native replay and archive to portable compaction", async () => {
		const model = { ...taskForkModel(), contextWindow: 4_096, input: ["text", "image"] } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries = remoteReplayForkEntries({
			version: "v2",
			provider: model.provider,
			replacementHistory: [
				{ type: "message", role: "user", content: "opaque native replay" },
				{ type: "compaction", encrypted_content: "opaque remote summary" },
			],
			usedTokens: 20_000,
		});
		const sourceCompaction = forkEntries.find(entry => entry.type === "compaction");
		if (sourceCompaction?.type !== "compaction") throw new Error("Expected source compaction");
		sourceCompaction.preserveData = {
			...sourceCompaction.preserveData,
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
				text: "archived native history",
			},
		};

		const result = await runSubprocess({
			...baseOptions,
			description: "oversized native replay fallback",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-oversized-native-fallback",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "remote-after",
				parentModel: { provider: model.provider, id: model.id },
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "remote-kept", parentId: null },
			{ id: "remote-compaction", parentId: "remote-kept" },
			{ id: "remote-after", parentId: "remote-compaction" },
		]);
		const childCompaction = childManager.getEntries().find(entry => entry.id === "remote-compaction");
		expect(childCompaction?.type).toBe("compaction");
		if (childCompaction?.type !== "compaction") throw new Error("Expected child compaction");
		expect(childCompaction.preserveData).toBeUndefined();
		expect(childManager.buildSessionContext().messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"user",
		]);
	});

	it("uses the reserve-adjusted budget when selecting a coherent tail", async () => {
		const model = { ...taskForkModel(), contextWindow: 10_000 } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		settings.set("compaction.reserveTokens", 6_000);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "reserve-compaction",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				summary: `under full window, over usable budget ${"summary ".repeat(1_000)}`,
				shortSummary: "reserve-boundary",
				firstKeptEntryId: "reserve-compaction",
				tokensBefore: 20_000,
			},
			{
				type: "message",
				id: "reserve-too-large",
				parentId: "reserve-compaction",
				timestamp: "2026-08-23T00:00:01.000Z",
				message: { role: "user", content: `older turn ${"budget ".repeat(3_000)}`, timestamp: 2 },
			},
			{
				type: "branch_summary",
				id: "reserve-summary-boundary",
				parentId: "reserve-too-large",
				timestamp: "2026-08-23T00:00:02.000Z",
				fromId: "reserve-too-large",
				summary: `fitting recent summary ${"fit ".repeat(1_000)}`,
			},
			{
				type: "message",
				id: "reserve-final",
				parentId: "reserve-summary-boundary",
				timestamp: "2026-08-23T00:00:03.000Z",
				message: { role: "user", content: "small post-summary turn", timestamp: 3 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			description: "reserve-adjusted fork preflight",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-reserve-adjusted-fork",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "reserve-final",
				parentModel: { provider: model.provider, id: model.id },
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries().map(entry => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "reserve-summary-boundary", parentId: null },
			{ id: "reserve-final", parentId: "reserve-summary-boundary" },
		]);
	});

	it("creates the fork with empty inheritance when the final user turn alone is oversized", async () => {
		const model = { ...taskForkModel(), contextWindow: 512 } as Model;
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-pass-through-"));
		const forkEntries: SessionEntry[] = [
			{
				type: "message",
				id: "oversized-final-user",
				parentId: null,
				timestamp: "2026-08-23T00:00:00.000Z",
				message: { role: "user", content: `final ${"oversized ".repeat(2_000)}`, timestamp: 1 },
			},
		];

		const result = await runSubprocess({
			...baseOptions,
			description: "empty bounded fork fallback",
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-empty-bounded-fork",
			artifactsDir,
			settings,
			modelRegistry: createModelRegistry(model),
			contextSource: "fork",
			forkContext: {
				sourceFile: "/tmp/source.jsonl",
				sourceLeafId: "oversized-final-user",
				parentModel: { provider: model.provider, id: model.id },
				entries: forkEntries,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(createSpy).toHaveBeenCalledTimes(1);
		const childManager = createSpy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		expect(childManager.getEntries()).toEqual([]);
	});

	it("forks bounded summary context for a text-only resolved model", async () => {
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
				preserveData: { artifactIndex: { version: 1, count: 3 } },
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
				parentModel: { provider: model.provider, id: model.id },
				entries: selectEffectiveTaskForkEntries(forkEntries),
			},
		});

		// A text-only model must neither be rejected at model resolution nor by
		// the fork seeding path (Snapcompact/vision requirement removed).
		expect(result.exitCode).toBe(0);
		// Parent-only runtime control is dropped from the child.
		expect(clearCheckpointRuntimeState).toHaveBeenCalled();
		expect(setTodoPhases).toHaveBeenCalledWith([]);

		// Assert the actual child SessionManager passed to createAgentSession:
		// bounded persisted entries preserve structural order, exclude runtime/config
		// and control state, and keep valid parent links + tool pairing.
		const childManager = spy.mock.calls[0]?.[0]?.sessionManager;
		expect(childManager).toBeDefined();
		if (!childManager) throw new Error("Expected a child SessionManager");
		const childEntries = childManager.getEntries();
		// Runtime/config + control are gone; the compaction and branch summary stay
		// structural while unrelated compaction payloads are discarded.
		expect(childEntries.map(entry => entry.id)).toEqual(["e1", "e2", "e4", "e5", "e6", "e7"]);
		expect(childEntries.some(entry => entry.type === "session_init")).toBe(false);
		const childCompaction = childEntries.find(entry => entry.id === "e5");
		expect(childCompaction?.type).toBe("compaction");
		if (childCompaction?.type !== "compaction") throw new Error("Expected child compaction");
		expect(childCompaction.preserveData).toBeUndefined();
		expect(childEntries.find(entry => entry.id === "e6")?.type).toBe("branch_summary");

		// Parent links are relinked to nearest surviving ancestor, forming a chain.
		const childParentById = new Map(childEntries.map(entry => [entry.id, entry.parentId]));
		expect(childParentById.get("e1")).toBeNull();
		expect(childParentById.get("e2")).toBe("e1");
		expect(childParentById.get("e4")).toBe("e2");
		expect(childParentById.get("e5")).toBe("e4");
		expect(childParentById.get("e6")).toBe("e5"); // skipped removed session_init
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
		// orphan results, a bounded compactionSummary, and no archive/image
		// data.
		const context = childManager.buildSessionContext();
		expect(context.messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"branchSummary",
			"user",
		]);
		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(true);
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
