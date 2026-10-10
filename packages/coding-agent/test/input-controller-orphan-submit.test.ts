import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a submission arriving while the main loop has no input waiter
 * (`onInputCallback === undefined` — post-turn epilogue, retry backoff, or a
 * scheduled continue) and the session is neither streaming nor compacting used
 * to fall through every branch of the submit ladder. The editor clears itself
 * on Enter, so the message vanished without a trace (no queue entry, no error,
 * no transcript message).
 *
 * Contract: such a submission must start a real prompt directly, with steer
 * fallback for a concurrent background turn, and be recorded as a local
 * submission so its eventual delivery does not clobber the editor.
 */

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	setCollapsedText(text: string): void;
	composerChips(): unknown[];
	getExpandedText(): string;
	addToHistory(text: string): void;
	clearDraft(historyText?: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createContext(sessionOverride?: InteractiveModeContext["session"]) {
	let editorText = "";
	const steer = vi.fn(async (_text: string, _images?: unknown) => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const addToHistory = vi.fn();
	const flushPendingBashComponents = vi.fn();
	const handleBashCommand = vi.fn(async () => {});
	const handlePythonCommand = vi.fn(async () => {});
	const promptCustomMessage = vi.fn(async () => {});
	const finishLoopCommandSubmission = vi.fn();
	const startPendingSubmission = vi.fn(
		(input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			streamingBehavior?: "steer" | "followUp";
			loopCommandPrompt?: string;
		}): SubmittedUserInput => ({ ...input, cancelled: false, started: false }),
	);

	const editor: FakeEditor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	const session =
		sessionOverride ??
		({
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			settings: Settings.isolated({}),
			steer,
			prompt,
			promptCustomMessage,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"]);

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		session,
		settings: session.settings,
		sessionManager: { getSessionName: () => "named-session" } as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			return () => {
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		// No input waiter: the state under test.
		onInputCallback: undefined,
		updatePendingMessagesDisplay,
		flushPendingBashComponents,
		startPendingSubmission,
		finishLoopCommandSubmission,
		handleBashCommand,
		handlePythonCommand,
		showError,
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		loopModePaused: false,
		loopPrompt: undefined,
		loopLimit: undefined,
	} as unknown as InteractiveModeContext;
	const setStreaming = (streaming: boolean) => {
		Object.defineProperty(session, "isStreaming", { configurable: true, value: streaming });
	};

	return {
		ctx,
		editor,
		setStreaming,
		spies: {
			steer,
			prompt,
			promptCustomMessage,
			startPendingSubmission,
			finishLoopCommandSubmission,
			handleBashCommand,
			handlePythonCommand,
			updatePendingMessagesDisplay,
			requestRender,
			showError,
			addToHistory,
		},
	};
}

function installLoopCommandLifecycle(ctx: InteractiveModeContext) {
	let pending:
		| {
				prompt: string;
				enabled: boolean;
				paused: boolean;
				loopPrompt: string | undefined;
				limit: InteractiveModeContext["loopLimit"];
		  }
		| undefined;
	const handleLoopCommand = vi.fn(async (args = "") => {
		const prompt = args.replace(/^update\s+/i, "").trim();
		pending = {
			prompt,
			enabled: ctx.loopModeEnabled,
			paused: ctx.loopModePaused,
			loopPrompt: ctx.loopPrompt,
			limit: ctx.loopLimit ? { ...ctx.loopLimit } : undefined,
		};
		ctx.loopModeEnabled = true;
		ctx.loopModePaused = false;
		ctx.loopPrompt = prompt;
		ctx.loopLimit = undefined;
		return prompt;
	});
	const finishLoopCommandSubmission = vi.fn((prompt: string, error?: unknown) => {
		if (!pending || pending.prompt !== prompt) return;
		if (error !== undefined) {
			ctx.loopModeEnabled = pending.enabled;
			ctx.loopModePaused = pending.paused;
			ctx.loopPrompt = pending.loopPrompt;
			ctx.loopLimit = pending.limit ? { ...pending.limit } : undefined;
		}
		pending = undefined;
	});
	ctx.handleLoopCommand = handleLoopCommand;
	ctx.finishLoopCommandSubmission = finishLoopCommandSubmission;
	return { handleLoopCommand, finishLoopCommandSubmission };
}

describe("InputController orphaned submit", () => {
	it.each([
		{ label: "bash", prompt: "!printf literal", diverted: "bash" },
		{ label: "python", prompt: "$ print('literal')", diverted: "python" },
	] as const)("submits a command-owned $label loop prompt literally", async ({ prompt, diverted }) => {
		const { ctx, editor, spies } = createContext();
		installLoopCommandLifecycle(ctx);
		const delivered = vi.fn((_input: SubmittedUserInput) => {});
		ctx.onInputCallback = delivered;
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.(`/loop ${prompt}`);

		expect(spies.startPendingSubmission).toHaveBeenCalledWith(
			expect.objectContaining({ text: prompt, loopCommandPrompt: prompt }),
			{ clearEditor: false },
		);
		expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ text: prompt, loopCommandPrompt: prompt }));
		if (diverted === "bash") {
			expect(spies.handleBashCommand).not.toHaveBeenCalled();
		} else {
			expect(spies.handlePythonCommand).not.toHaveBeenCalled();
		}
	});

	it("submits a known-skill loop prompt literally instead of invoking the skill", async () => {
		const tempDir = TempDir.createSync("@pi-loop-literal-skill-");
		try {
			const skillPath = path.join(tempDir.path(), "test-skill.md");
			await Bun.write(skillPath, "---\nname: test-skill\n---\nDo the thing.\n");
			const { ctx, editor, spies } = createContext();
			ctx.skillCommands.set("skill:test-skill", {
				name: "test-skill",
				description: "",
				filePath: skillPath,
				baseDir: tempDir.path(),
				source: "test",
			});
			installLoopCommandLifecycle(ctx);
			const delivered = vi.fn((_input: SubmittedUserInput) => {});
			ctx.onInputCallback = delivered;
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();
			const prompt = "/skill:test-skill literal argument";

			await editor.onSubmit?.(`/loop ${prompt}`);

			expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ text: prompt, loopCommandPrompt: prompt }));
			expect(spies.promptCustomMessage).not.toHaveBeenCalled();
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes idle Ctrl+Enter loop replacement through the installed input waiter", async () => {
		const { ctx, editor, spies } = createContext();
		installLoopCommandLifecycle(ctx);
		ctx.loopModeEnabled = true;
		ctx.loopPrompt = "original prompt";
		const delivered = vi.fn((_input: SubmittedUserInput) => {});
		ctx.onInputCallback = delivered;
		const controller = new InputController(ctx);
		editor.setText("/loop replacement prompt");

		await controller.handleFollowUp();

		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.startPendingSubmission).toHaveBeenCalledWith({
			text: "replacement prompt",
			images: undefined,
			imageLinks: undefined,
			streamingBehavior: "followUp",
			loopCommandPrompt: "replacement prompt",
		});
		expect(delivered).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "replacement prompt",
				streamingBehavior: "followUp",
				loopCommandPrompt: "replacement prompt",
			}),
		);
		expect(ctx.loopPrompt).toBe("replacement prompt");
	});

	it.each([
		{ label: "streaming Enter", streaming: true, followUp: false, enabled: true, paused: false },
		{ label: "orphaned idle Enter", streaming: false, followUp: false, enabled: true, paused: true },
		{ label: "idle Ctrl+Enter without a waiter", streaming: false, followUp: true, enabled: true, paused: false },
		{ label: "first loop start", streaming: false, followUp: false, enabled: false, paused: false },
	] as const)(
		"restores prior loop state when $label delivery rejects",
		async ({ streaming, followUp, enabled, paused }) => {
			const { ctx, editor, setStreaming, spies } = createContext();
			setStreaming(streaming);
			ctx.loopModeEnabled = enabled;
			ctx.loopModePaused = paused;
			ctx.loopPrompt = enabled ? "original prompt" : undefined;
			ctx.loopLimit = enabled ? { kind: "iterations", initial: 4, remaining: 3 } : undefined;
			const lifecycle = installLoopCommandLifecycle(ctx);
			const rejection = new Error("queue rejected");
			spies.prompt.mockRejectedValueOnce(rejection);
			const controller = new InputController(ctx);

			if (followUp) {
				editor.setText("/loop replacement prompt");
				await controller.handleFollowUp();
			} else {
				controller.setupEditorSubmitHandler();
				await editor.onSubmit?.("/loop replacement prompt");
			}

			expect(lifecycle.finishLoopCommandSubmission).toHaveBeenCalledTimes(1);
			expect(lifecycle.finishLoopCommandSubmission).toHaveBeenCalledWith("replacement prompt", rejection);
			expect(ctx.loopModeEnabled).toBe(enabled);
			expect(ctx.loopModePaused).toBe(paused);
			expect(ctx.loopPrompt).toBe(enabled ? "original prompt" : undefined);
			expect(ctx.loopLimit).toEqual(enabled ? { kind: "iterations", initial: 4, remaining: 3 } : undefined);
		},
	);

	it("keeps ordinary idle Enter one-off while a paused loop retains its prompt", async () => {
		const { ctx, editor, spies } = createContext();
		const delivered = vi.fn((_input: SubmittedUserInput) => {});
		ctx.onInputCallback = delivered;
		ctx.loopModeEnabled = true;
		ctx.loopModePaused = true;
		ctx.loopPrompt = "original recurring prompt";
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("one-off follow-up");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith(
			{
				text: "one-off follow-up",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
		expect(delivered).toHaveBeenCalledWith(
			expect.objectContaining({ text: "one-off follow-up", streamingBehavior: "steer" }),
		);
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(ctx.loopPrompt).toBe("original recurring prompt");
		expect(ctx.loopModePaused).toBe(true);
	});

	it.each([
		{ state: "orphan-idle/running", streaming: false, paused: false },
		{ state: "orphan-idle/paused", streaming: false, paused: true },
		{ state: "streaming/running", streaming: true, paused: false },
		{ state: "streaming/paused", streaming: true, paused: true },
	])("keeps ordinary Enter one-off while the loop is $state", async ({ streaming, paused }) => {
		const { ctx, editor, setStreaming, spies } = createContext();
		setStreaming(streaming);
		ctx.loopModeEnabled = true;
		ctx.loopModePaused = paused;
		ctx.loopPrompt = "original recurring prompt";
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("one-off follow-up");

		expect(spies.prompt).toHaveBeenCalledWith("one-off follow-up", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(ctx.loopPrompt).toBe("original recurring prompt");
		expect(ctx.loopModePaused).toBe(paused);
	});

	it("starts an idle submit with no input waiter instead of queueing it forever", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("do not lose me");

		expect(spies.prompt).toHaveBeenCalledWith("do not lose me", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.steer).not.toHaveBeenCalled();
		// Delivery protection: the prompted message is marked as locally submitted.
		expect(ctx.locallySubmittedUserSignatures.has("do not lose me\u00000")).toBe(true);
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalled();
		expect(spies.requestRender).toHaveBeenCalled();
		expect(spies.addToHistory).toHaveBeenCalledWith("do not lose me");
	});

	it("starts a real idle session even when steer drain would be non-resumable", async () => {
		const tempDir = TempDir.createSync("@pi-orphan-submit-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			authStorage.keys.setRuntime("anthropic", "test-key");
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: "stale prompt", timestamp: Date.now() }],
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({}),
				modelRegistry: new ModelRegistry(authStorage),
			});
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
			const { ctx, editor } = createContext(session);
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();

			await editor.onSubmit?.("wake from orphan state");

			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(continueSpy).not.toHaveBeenCalled();
			expect(session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			await session?.dispose();
			authStorage?.close();
			tempDir.removeSync();
		}
	});

	it("forwards pending images and counts them in the local-submission signature", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image", data: "abc", mimeType: "image/png" };
		(ctx.editor.pendingImages as unknown[]).push(image);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("look at this [Image #1]");

		expect(spies.prompt).toHaveBeenCalledWith("look at this [Image #1]", {
			streamingBehavior: "steer",
			images: [image],
		});
		expect(ctx.locallySubmittedUserSignatures.has("look at this [Image #1]\u00001")).toBe(true);
		expect(ctx.editor.pendingImages.length).toBe(0);
	});

	it("restores text and images to the editor when prompt dispatch rejects", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		(ctx.editor.pendingImages as unknown[]).push(image);
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue exploded");
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("doomed message [Image #1]");

		expect(spies.showError).toHaveBeenCalledWith("queue exploded");
		// The message survives the failure: text and images return to the editor.
		expect(editor.getText()).toBe("doomed message [Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		// The signature must not leak for a message that never started.
		expect(ctx.locallySubmittedUserSignatures.has("doomed message [Image #1]\u00001")).toBe(false);
	});

	it("returns queued images to the pending-image buffer on queue restore", async () => {
		const { ctx, editor } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const session = ctx.session as unknown as { clearQueue: () => unknown };
		session.clearQueue = () => ({
			steering: [{ text: "queued with image", images: [image] }],
			followUp: [],
		});
		const controller = new InputController(ctx);

		const restored = controller.restoreQueuedMessagesToEditor();

		expect(restored).toBe(1);
		expect(editor.getText()).toBe("queued with image");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
	});
});
