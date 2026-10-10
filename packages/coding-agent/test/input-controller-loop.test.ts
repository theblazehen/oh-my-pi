import { describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
type Spy = Mock<(...args: unknown[]) => unknown>;

function createLoopContext(options: {
	isStreaming: boolean;
	isCompacting?: boolean;
	extensionCommandNames?: string[];
	onInputCallback?: (...args: never[]) => void;
}) {
	const extensionCommandNames = options.extensionCommandNames ?? [];
	const extensionRunner =
		extensionCommandNames.length > 0
			? {
					hasHandlers: () => false,
					getCommand: (name: string) => (extensionCommandNames.includes(name) ? {} : undefined),
				}
			: undefined;
	let loopPrompt: string | undefined = "original loop prompt";
	const finishLoopCommandSubmission = vi.fn((prompt: string, error?: unknown) => {
		if (error === undefined) loopPrompt = prompt;
	});
	const prompt = vi.fn(async () => true);
	const pauseLoop = vi.fn(() => {
		loopPrompt = undefined;
	});
	const editor = {
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: undefined,
		addToHistory: vi.fn(),
		setText: vi.fn(),
		getText: () => "",
		getExpandedText: () => "",
		clearDraft: vi.fn(),
		setCollapsedText: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: options.isStreaming,
			isCompacting: options.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner,
			customCommands: [],
			promptTemplates: [],
			prompt,
		},
		sessionManager: { putBlob: vi.fn() },
		loopModeEnabled: true,
		get loopPrompt() {
			return loopPrompt;
		},
		set loopPrompt(value: string | undefined) {
			loopPrompt = value;
		},
		finishLoopCommandSubmission,
		pauseLoop,
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		handleBashCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		onInputCallback: options.onInputCallback,
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		focusedAgentId: undefined,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		finishLoopCommandSubmission,
		pauseLoop,
		prompt,
		getLoopPrompt: () => loopPrompt,
		queueCompactionMessage: ctx.queueCompactionMessage as Spy,
		handleBashCommand: ctx.handleBashCommand as Spy,
		showError: ctx.showError as Spy,
	};
}

describe("loop mode interjections", () => {
	it("keeps the original loop prompt when steering mid-turn", async () => {
		const { ctx, finishLoopCommandSubmission, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("one-off correction");

		// One-off steer reaches the session but must not replace the loop body.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(finishLoopCommandSubmission).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("keeps idle submissions distinct from the recurring prompt", async () => {
		const onInputCallback = vi.fn();
		const { ctx, finishLoopCommandSubmission } = createLoopContext({ isStreaming: false, onInputCallback });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("new loop body");

		expect(finishLoopCommandSubmission).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt even while streaming", async () => {
		const { ctx, finishLoopCommandSubmission, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		// Mirror the command-owned prompt returned by handleLoopCommand:
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "inline loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 inline loop body");

		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("inline loop body", undefined);
		expect(getLoopPrompt()).toBe("inline loop body");
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt queued during compaction", async () => {
		const { ctx, finishLoopCommandSubmission, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
		});
		// Mirror the command-owned prompt returned by handleLoopCommand:
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "compact loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 compact loop body");

		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("compact loop body");
		expect(getLoopPrompt()).toBe("compact loop body");
		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
	});

	it("submits explicit loop shell syntax as model text", async () => {
		const { ctx, finishLoopCommandSubmission, getLoopPrompt, handleBashCommand } = createLoopContext({
			isStreaming: false,
		});
		// Mirror the command-owned body returned by handleLoopCommand:
		// back to the dispatcher as literal model text.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "!echo hi");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 !echo hi");

		expect(handleBashCommand).not.toHaveBeenCalled();
		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("!echo hi", undefined);
		expect(getLoopPrompt()).toBe("!echo hi");
	});

	it("retains explicit loop text queued during compaction", async () => {
		const { ctx, finishLoopCommandSubmission, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
			extensionCommandNames: ["ext-cmd"],
		});
		// Mirror the command-owned body returned by handleLoopCommand:
		// back to the dispatcher, where it queues for compaction.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "/ext-cmd args");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 /ext-cmd args");

		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("/ext-cmd args");
		expect(getLoopPrompt()).toBe("/ext-cmd args");
	});

	it("leaves the loop untouched when a streamed body is consumed locally", async () => {
		const { ctx, finishLoopCommandSubmission, pauseLoop, prompt, getLoopPrompt } = createLoopContext({
			isStreaming: true,
		});
		// Mirror the command-owned body returned by handleLoopCommand:
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "/void-cmd");
		// Mirror AgentSession.prompt reporting local consumption (void custom
		// command) instead of a started turn.
		prompt.mockResolvedValueOnce(false);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 /void-cmd");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("/void-cmd", expect.any(Error));
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("preserves the loop when a one-off submission is consumed locally", async () => {
		const { ctx, finishLoopCommandSubmission, pauseLoop, prompt, getLoopPrompt } = createLoopContext({
			isStreaming: false,
		});
		prompt.mockResolvedValueOnce(false);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/void-cmd");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(finishLoopCommandSubmission).not.toHaveBeenCalled();
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("preserves the loop after a successful one-off submission", async () => {
		const { ctx, finishLoopCommandSubmission, getLoopPrompt } = createLoopContext({ isStreaming: false });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("direct body");

		expect(finishLoopCommandSubmission).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("keeps the prior body when a streamed inline body is rejected", async () => {
		const { ctx, finishLoopCommandSubmission, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: true,
		});
		// Mirror the command-owned body returned by handleLoopCommand:
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "new body");
		// Mirror attachment normalization failing inside prompt dispatch.
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 new body");

		expect(finishLoopCommandSubmission).toHaveBeenCalledWith("new body", expect.any(Error));
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});

	it("preserves the loop when a one-off submission is rejected", async () => {
		const { ctx, finishLoopCommandSubmission, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: false,
		});
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("direct body");

		expect(finishLoopCommandSubmission).not.toHaveBeenCalled();
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});
});
