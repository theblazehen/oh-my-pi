import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "@oh-my-pi/pi-coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";

// Reproduces issue #3665: when the upstream system prompt resolution leaves
// `event.systemPrompt` unset, the autoresearch handler must still render its
// own block instead of crashing with `event.systemPrompt.join is not a function`.

interface CapturedHandlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	agent_end?: ExtensionHandler<AgentEndEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

interface SentMessage {
	message: unknown;
	options: unknown;
}

function repositoryFixture(cwd: string): VcsRepo {
	const unexpected = (): never => {
		throw new Error("Unexpected repository operation in autoresearch handler fixture");
	};
	return {
		root: () => cwd,
		label: async () => "autoresearch/test",
		kind: unexpected,
		primaryRoot: unexpected,
		prefixOf: unexpected,
		watchTarget: unexpected,
		supports: unexpected,
		asGit: unexpected,
		asJj: unexpected,
		headId: unexpected,
		statusSummary: unexpected,
		statusPorcelain: unexpected,
		diffText: unexpected,
		changedFiles: unexpected,
		numstat: unexpected,
		uncommittedDiff: unexpected,
		logSubjects: unexpected,
		logOnelines: unexpected,
		commitDetails: unexpected,
		lsFiles: unexpected,
	};
}

function buildHarness(): { handlers: CapturedHandlers; activeTools: string[]; sentMessages: SentMessage[] } {
	const handlers: CapturedHandlers = {};
	const activeTools: string[] = [];
	const sentMessages: SentMessage[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(): void {},
		sendMessage(message: unknown, options: unknown): void {
			sentMessages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { handlers, activeTools, sentMessages };
}

function makeCtx(cwd: string, pendingMessages: string[] = []): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => pendingMessages.length > 0,
		sessionManager: {
			getSessionId: () => "session-bas-test",
			getBranchAsync: async () => [
				{
					type: "custom",
					customType: "autoresearch-control",
					id: "ctrl-1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					data: { mode: "on", goal: "speed up the thing" },
				},
			],
		},
	} as unknown as ExtensionContext;
}

describe("autoresearch before_agent_start handler", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-bas-test-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-bas-cwd-");
		vi.spyOn(vcs, "repo").mockReturnValue(repositoryFixture(cwdDir.path()));
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		try {
			await cwdDir.remove();
			await dbDir.remove();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("renders an autoresearch block when event.systemPrompt is undefined (issue #3665)", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		// Crash repro: upstream leaves event.systemPrompt unset; handler must
		// not throw, and the rendered block must still contain the autoresearch
		// header so the model gets its mode-specific instructions.
		const event = {
			type: "before_agent_start",
			prompt: "kick off",
			images: undefined,
			systemPrompt: undefined,
		} as unknown as BeforeAgentStartEvent;

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		expect(Array.isArray(result.systemPrompt)).toBe(true);
		const blocks = result.systemPrompt as string[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Autoresearch Mode");
	});

	it("joins event.systemPrompt blocks into the rendered base prompt", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "kick off",
			systemPrompt: ["alpha block", "beta block"],
		};

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered.startsWith("alpha block\n\nbeta block")).toBe(true);
	});
});

describe("autoresearch agent_end handler", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-agent-end-test-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-agent-end-cwd-");
		vi.spyOn(vcs, "repo").mockReturnValue(repositoryFixture(cwdDir.path()));
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		try {
			await cwdDir.remove();
			await dbDir.remove();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("queues one hidden continuation alongside unrelated pending messages", async () => {
		const storage = await openAutoresearchStorage(cwdDir.path());
		const session = storage.openSession({
			name: "speed",
			goal: "speed up the thing",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bun run bench",
			branch: "autoresearch/test",
			baselineCommit: "abc1234",
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bun run bench",
			logPath: "/tmp/run.log",
			preRunDirtyPaths: [],
			startedAt: 1,
		});
		storage.markRunCompleted({
			runId: run.id,
			completedAt: 2,
			durationMs: 1,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 100,
			parsedMetrics: { runtime_ms: 100 },
			parsedAsi: null,
		});

		const { handlers, sentMessages } = buildHarness();
		if (!handlers.session_start || !handlers.agent_end) {
			throw new Error("Autoresearch extension should register both session_start and agent_end");
		}
		const pendingMessages = ["unrelated queued user work"];
		const ctx = makeCtx(cwdDir.path(), pendingMessages);
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const event = { type: "agent_end", messages: [] } as AgentEndEvent;
		await handlers.agent_end(event, ctx);
		await handlers.agent_end(event, ctx);

		expect(sentMessages).toEqual([
			{
				message: expect.objectContaining({
					customType: "autoresearch-resume",
					display: false,
					attribution: "agent",
				}),
				options: { deliverAs: "nextTurn", triggerTurn: true },
			},
		]);
		expect(pendingMessages).toEqual(["unrelated queued user work"]);
	});
});
