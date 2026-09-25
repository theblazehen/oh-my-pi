import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as loopCondition from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let pendingInput: Promise<SubmittedUserInput> | undefined;

	async function acceptLoopCommand(args: string): Promise<string> {
		const prompt = await mode.handleLoopCommand(args);
		if (!prompt) throw new Error(`Expected /loop ${args} to return a prompt`);
		mode.finishLoopCommandSubmission(prompt);
		return prompt;
	}

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		cfgLoopMode.set(settings, "prompt");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode.disableLoopMode("Loop mode disabled.");
		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
		pendingInput = undefined;
		mode.vibeModeEnabled = false;
		Reflect.deleteProperty(session, "isCompacting");
		Reflect.deleteProperty(session, "isStreaming");
		Reflect.deleteProperty(session, "hasPostPromptWork");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		expect(await acceptLoopCommand("repeat this")).toBe("repeat this");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		expect(await acceptLoopCommand("repeat after compact")).toBe("repeat after compact");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		expect(await acceptLoopCommand("deliver this")).toBe("deliver this");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("disables reset loops when vibe blocks the session transition", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "reset");
		mode.vibeModeEnabled = true;
		expect(await acceptLoopCommand("do not resubmit")).toBe("do not resubmit");
		const showStatus = vi.spyOn(mode, "showStatus");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
	});

	it("captures an inline prompt immediately and reports running, paused, resumed, and disabled states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		expect(await acceptLoopCommand("3 repeat this")).toBe("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});
		expect(mode.loopPrompt).toBe("repeat this");

		mode.pauseLoop();
		expect(mode.loopPrompt).toBe("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		await mode.handleLoopCommand("resume");
		expect(mode.loopPrompt).toBe("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});

	it("atomically replaces an active prompt, resets its limit, and cancels the stale timer", async () => {
		vi.useFakeTimers();
		expect(await acceptLoopCommand("5 original prompt")).toBe("original prompt");

		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));
		expect(await mode.handleLoopCommand("2 replacement prompt")).toBe("replacement prompt");
		mode.finishLoopCommandSubmission("replacement prompt");

		expect(mode.loopPrompt).toBe("replacement prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
		expect(mode.loopModePaused).toBe(false);
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		// The old scheduled prompt must not race the replacement returned for immediate submission.
		expect(resolved).toHaveLength(0);
		await mode.handleLoopCommand("resume");
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("replacement prompt");
		mode.finishPendingSubmission(resolved[0]);

		expect(await acceptLoopCommand("now unbounded")).toBe("now unbounded");
		expect(mode.loopPrompt).toBe("now unbounded");
		expect(mode.loopLimit).toBeUndefined();
	});

	it("keeps a paused prompt dormant until resume schedules it through the normal delay", async () => {
		vi.useFakeTimers();
		expect(await acceptLoopCommand("3 retained prompt")).toBe("retained prompt");
		mode.pauseLoop();

		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));
		vi.advanceTimersByTime(2_400);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);
		expect(mode.loopPrompt).toBe("retained prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 3 });

		await mode.handleLoopCommand("resume");
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBe("retained prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 3 });
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("retained prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
		mode.finishPendingSubmission(resolved[0]);
	});

	it("does not submit after pausing a deferred blocked iteration", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		expect(await acceptLoopCommand("retained prompt")).toBe("retained prompt");

		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		mode.pauseLoop();
		compacting = false;
		vi.advanceTimersByTime(1_600);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);
		expect(mode.loopModePaused).toBe(true);
		expect(mode.loopPrompt).toBe("retained prompt");

		await mode.handleLoopCommand("resume");
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		mode.finishPendingSubmission(resolved[0]);
	});

	it.each(["compact", "reset"] as const)(
		"preserves the remaining count when paused during an awaited %s action",
		async action => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, action);
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			const actionGate = Promise.withResolvers<void>();
			const actionSpy =
				action === "compact"
					? vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
							await actionGate.promise;
							return "ok";
						})
					: vi.spyOn(mode, "handleClearCommand").mockImplementation(async () => {
							await actionGate.promise;
						});
			expect(await acceptLoopCommand("3 retained prompt")).toBe("retained prompt");

			const resolved: SubmittedUserInput[] = [];
			void mode.getUserInput().then(input => resolved.push(input));
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			expect(actionSpy).toHaveBeenCalledTimes(1);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 3 });

			mode.pauseLoop();
			actionGate.resolve();
			await flushMicrotasks();
			vi.advanceTimersByTime(1_600);
			await flushMicrotasks();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModePaused).toBe(true);
			expect(mode.loopPrompt).toBe("retained prompt");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 3 });

			await mode.handleLoopCommand("resume");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			await flushMicrotasks();
			expect(resolved).toHaveLength(1);
			expect(resolved[0].text).toBe("retained prompt");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
			mode.finishPendingSubmission(resolved[0]);
		},
	);

	it.each(["compact", "reset"] as const)(
		"waits for an in-flight %s action before applying a replacement",
		async action => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, action);
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			const actionGate = Promise.withResolvers<void>();
			const actionSpy =
				action === "compact"
					? vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
							await actionGate.promise;
							return "ok";
						})
					: vi.spyOn(mode, "handleClearCommand").mockImplementation(async () => {
							await actionGate.promise;
						});
			expect(await acceptLoopCommand("3 original prompt")).toBe("original prompt");

			const resolved: SubmittedUserInput[] = [];
			void mode.getUserInput().then(input => resolved.push(input));
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			expect(actionSpy).toHaveBeenCalledTimes(1);

			let replacementSettled = false;
			const replacement = mode.handleLoopCommand("2 replacement prompt").then(prompt => {
				replacementSettled = true;
				return prompt;
			});
			await flushMicrotasks();
			expect(replacementSettled).toBe(false);
			expect(mode.loopModePaused).toBe(true);
			expect(mode.loopPrompt).toBe("original prompt");

			actionGate.resolve();
			await flushMicrotasks();
			expect(await replacement).toBe("replacement prompt");
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(true);
			expect(mode.loopModePaused).toBe(false);
			expect(mode.loopPrompt).toBe("replacement prompt");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
			mode.finishLoopCommandSubmission("replacement prompt");
		},
	);

	it("restores the prior retained loop when replacement delivery is rejected", async () => {
		expect(await acceptLoopCommand("4 original prompt")).toBe("original prompt");
		mode.pauseLoop();

		expect(await mode.handleLoopCommand("2 replacement prompt")).toBe("replacement prompt");
		expect(mode.loopPrompt).toBe("replacement prompt");
		expect(mode.loopModePaused).toBe(false);

		mode.finishLoopCommandSubmission("replacement prompt", new Error("queue rejected"));

		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(true);
		expect(mode.loopPrompt).toBe("original prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 4, remaining: 4 });
	});

	it("reschedules a prior running loop when replacement delivery is rejected", async () => {
		vi.useFakeTimers();
		vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async condition =>
			condition.command === "true" ? { kind: "continue" } : { kind: "halt", message: "replacement gate" },
		);
		expect(await acceptLoopCommand("4 --while 'true' original prompt")).toBe("original prompt");
		const resolved: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => resolved.push(input));

		expect(await mode.handleLoopCommand("2 --until 'false' replacement prompt")).toBe("replacement prompt");
		mode.finishLoopCommandSubmission("replacement prompt", new Error("queue rejected"));

		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBe("original prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 4, remaining: 4 });
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("original prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 4, remaining: 3 });
		mode.finishPendingSubmission(resolved[0]);
	});

	it("returns to disabled when the first loop prompt is rejected", async () => {
		expect(await mode.handleLoopCommand("first prompt")).toBe("first prompt");
		expect(mode.loopModeEnabled).toBe(true);

		mode.finishLoopCommandSubmission("first prompt", new Error("model unavailable"));

		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(mode.loopLimit).toBeUndefined();
	});

	it("does not undo an explicit pause when pending replacement delivery later rejects", async () => {
		expect(await acceptLoopCommand("4 original prompt")).toBe("original prompt");
		expect(await mode.handleLoopCommand("2 replacement prompt")).toBe("replacement prompt");

		mode.pauseLoop();
		mode.finishLoopCommandSubmission("replacement prompt", new Error("late rejection"));

		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(true);
		expect(mode.loopPrompt).toBe("replacement prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
	});

	it("ignores a stale rejection after a newer replacement command takes ownership", async () => {
		expect(await acceptLoopCommand("4 original prompt")).toBe("original prompt");
		expect(await mode.handleLoopCommand("3 intermediate prompt")).toBe("intermediate prompt");
		expect(await mode.handleLoopCommand("2 latest prompt")).toBe("latest prompt");

		mode.finishLoopCommandSubmission("intermediate prompt", new Error("stale rejection"));

		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBe("latest prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
		mode.finishLoopCommandSubmission("latest prompt");
	});

	it("stops and clears retained state through bare loop, stop, and off", async () => {
		for (const command of ["", "stop", "off"] as const) {
			expect(await acceptLoopCommand("4 retained prompt")).toBe("retained prompt");
			mode.pauseLoop();

			await mode.handleLoopCommand(command);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopModePaused).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(mode.loopLimit).toBeUndefined();
		}
	});

	it("does not arm a disabled loop without a prompt", async () => {
		const showError = vi.spyOn(mode, "showError");

		expect(await mode.handleLoopCommand()).toBeUndefined();
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(mode.loopLimit).toBeUndefined();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("/loop stop"));
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("/loop off"));
	});

	it("uses update as an explicit replace-and-resume alias", async () => {
		expect(await acceptLoopCommand("4 retained prompt")).toBe("retained prompt");
		mode.pauseLoop();

		expect(await mode.handleLoopCommand("update 2 replacement prompt")).toBe("replacement prompt");
		mode.finishLoopCommandSubmission("replacement prompt");
		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(false);
		expect(mode.loopPrompt).toBe("replacement prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 2, remaining: 2 });
	});

	it("requires a prompt for update without mutating the retained loop", async () => {
		expect(await acceptLoopCommand("4 retained prompt")).toBe("retained prompt");
		mode.pauseLoop();
		const showError = vi.spyOn(mode, "showError");

		expect(await mode.handleLoopCommand("update")).toBeUndefined();
		expect(mode.loopModeEnabled).toBe(true);
		expect(mode.loopModePaused).toBe(true);
		expect(mode.loopPrompt).toBe("retained prompt");
		expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 4, remaining: 4 });
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("Usage: /loop"));
	});

	describe("continue condition", () => {
		function idleSession(): void {
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
		}

		function armLoop(prompt: string): SubmittedUserInput[] {
			const resolved: SubmittedUserInput[] = [];
			mode.loopModeEnabled = true;
			mode.loopPrompt = prompt;
			pendingInput = mode.getUserInput();
			void pendingInput.then(input => resolved.push(input));
			return resolved;
		}

		it("submits the next iteration when the condition says continue", async () => {
			vi.useFakeTimers();
			idleSession();
			const evaluate = vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
			mode.loopCondition = { command: "test -f GO", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(evaluate).toHaveBeenCalledTimes(1);
			expect(evaluate.mock.calls[0][0]).toEqual({ command: "test -f GO", until: false });
			expect(resolved).toHaveLength(1);
			expect(resolved[0].text).toBe("keep going");
			expect(mode.loopModeEnabled).toBe(true);
		});

		it("disables the loop and submits nothing when the condition says halt", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({
				kind: "halt",
				message: "Loop condition `bun test` is now satisfied. Loop mode disabled.",
			});
			const showStatus = vi.spyOn(mode, "showStatus");
			mode.loopCondition = { command: "bun test", until: true };

			const resolved = armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(showStatus).toHaveBeenCalledWith("Loop condition `bun test` is now satisfied. Loop mode disabled.");
		});

		// A halted iteration never ran, so it must not spend the user's budget:
		// `/loop 3 --until ...` that stops early should still report 3 remaining.
		it("does not consume the iteration budget when the condition halts", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "halt", message: "stop" });
			mode.loopCondition = { command: "bun test", until: true };
			const limit = { kind: "iterations", initial: 3, remaining: 3 } as const;
			mode.loopLimit = { ...limit };
			const observed = mode.loopLimit;

			armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(observed).toEqual(limit);
		});

		// Esc between iterations must kill the child process and skip the
		// iteration without tearing down loop mode, and the late verdict that
		// arrives afterwards must not resurrect the cancelled iteration.
		it("aborts an in-flight condition on pause and ignores its late verdict", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.pauseLoop();
			expect(captured?.aborted).toBe(true);
			expect(mode.loopModeEnabled).toBe(true);
			expect(mode.loopModePaused).toBe(true);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(true);
		});

		it("cancels the gate for a manual submission without replacing or pausing the owned loop", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let signal: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				signal = options.signal;
				return pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };
			const resolved = armLoop("owned prompt");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();
			const manual = mode.startPendingSubmission({ text: "manual message" });
			expect(signal?.aborted).toBe(true);
			pending.resolve({ kind: "halt", message: "stale gate" });
			await flushMicrotasks();
			expect(resolved).toHaveLength(0);
			expect(mode.loopPrompt).toBe("owned prompt");
			expect(mode.loopModeEnabled).toBe(true);
			expect(mode.loopModePaused).toBe(false);
			mode.finishPendingSubmission(manual);
		});

		it("aborts an in-flight condition when an explicit loop command replaces its prompt", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			await acceptLoopCommand("a replacement loop prompt");
			expect(captured?.aborted).toBe(true);
			pending.resolve({ kind: "halt", message: "stale gate" });
			await flushMicrotasks();
			expect(mode.loopPrompt).toBe("a replacement loop prompt");
			expect(mode.loopModeEnabled).toBe(true);
		});

		it("ignores a stale condition verdict when an explicit replacement repeats the same prompt", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			await acceptLoopCommand("keep going");
			expect(captured?.aborted).toBe(true);
			pending.resolve({ kind: "halt", message: "stale gate" });
			await flushMicrotasks();
			expect(mode.loopPrompt).toBe("keep going");
			expect(mode.loopModeEnabled).toBe(true);
		});

		// /vibe enabled while the gate is awaiting must kill a reset loop: the
		// pre-gate guard is stale by then, and handleClearCommand would only
		// warn while the iteration still submitted without resetting. Goes
		// through the real /vibe command so the vibeModeEnabled transition is
		// exercised instead of assigned directly.
		it("disables a reset loop when vibe is enabled while the condition is in flight", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			vi.spyOn(session, "activateVibeTools").mockResolvedValue();
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			await mode.handleVibeModeCommand();
			expect(mode.vibeModeEnabled).toBe(true);
			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
		});

		// The condition can resolve while /vibe tool activation is still in
		// flight: vibeModeEnabled is still false, but the reset must not run
		// concurrently with the toolset switch. The loop must disable on the
		// entering transition, not just the settled flag.
		it("disables a reset loop when the condition resolves during vibe activation", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			const vibeGate = Promise.withResolvers<void>();
			vi.spyOn(session, "activateVibeTools").mockImplementation(() => vibeGate.promise);
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			const vibeEnter = mode.handleVibeModeCommand();
			await flushMicrotasks();
			expect(mode.vibeModeEnabled).toBe(false);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");

			vibeGate.resolve();
			await vibeEnter;
			expect(mode.vibeModeEnabled).toBe(true);
		});
	});

	it("resubmits a /skill: prompt dispatched inline by the submit handler", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		new InputController(mode).setupEditorSubmitHandler();
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(true);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });

		mode.disableLoopMode();
		mode.loopModeEnabled = true;
		mode.loopPrompt = "/skill:recap go";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		await mode.editor.onSubmit?.("/skill:recap go");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(mode.loopPrompt).toBe("/skill:recap go");
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		mode.skillCommands.delete("skill:recap");
	});

	it("paints no optimistic user row for a resubmitted /skill: loop prompt", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "/skill:recap go";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		// A plain loop prompt paints one; the skill row comes from the dispatched
		// custom message instead.
		expect(mode.addMessageToChat).not.toHaveBeenCalled();
		mode.skillCommands.delete("skill:recap");
	});

	it("paints an optimistic user row for a resubmitted plain loop prompt", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(mode.addMessageToChat).toHaveBeenCalledTimes(1);
	});
});
