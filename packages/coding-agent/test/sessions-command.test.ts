import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as picker from "@oh-my-pi/pi-tui/apps/session-picker";
import { isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import Sessions from "@oh-my-pi/pi-coding-agent/commands/sessions";
import * as theme from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as workers from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import * as utils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

class CommandExit extends Error {
	constructor(readonly code: number | string | null | undefined) {
		super(`Command exited with ${code}`);
	}
}

function command(argv: string[] = []): Sessions {
	return new Sessions(argv, { bin: "omp", version: "0.0.0-test", commands: new Map() });
}

function session(cwd: string, id: string): SessionInfo {
	return {
		id,
		cwd,
		path: path.join(cwd, `${id}.jsonl`),
		title: id,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		size: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("omp sessions command", () => {
	let root: string;
	let sourceCwd: string;
	let targetCwd: string;
	let selected: SessionInfo;
	let stdinTTY: PropertyDescriptor | undefined;
	let stdoutTTY: PropertyDescriptor | undefined;
	let agentDirOverride: string | undefined;

	beforeEach(async () => {
		stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		agentDirOverride = process.env.PI_CODING_AGENT_DIR;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sessions-command-"));
		sourceCwd = path.join(root, "source project");
		targetCwd = path.join(root, "target project");
		await Promise.all([fs.mkdir(sourceCwd), fs.mkdir(targetCwd)]);
		selected = session(targetCwd, "original-session");
		vi.spyOn(process, "cwd").mockReturnValue(sourceCwd);
		vi.spyOn(theme, "initTheme").mockResolvedValue(undefined);
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([session(sourceCwd, "local-session"), selected]);
		vi.spyOn(picker, "selectSession").mockResolvedValue(selected);
		vi.spyOn(workers, "workerEnvFromParent").mockReturnValue({});
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new CommandExit(code);
		});
		// Never launch an agent accidentally if a rejection/cancellation regresses.
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("Unexpected agent launch");
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		if (agentDirOverride === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDirOverride;
		await fs.rm(root, { recursive: true, force: true });
	});

	it("routes sessions to the browser rather than an initial agent prompt", () => {
		expect(isSubcommand("sessions")).toBe(true);
		expect(resolveCliArgv(["sessions"])).toEqual({ argv: ["sessions"] });
		expect(resolveCliArgv(["sessions", "--help"])).toEqual({ argv: ["sessions", "--help"] });
	});

	it("rejects positional arguments before discovering sessions", async () => {
		await expect(command(["unexpected-prompt"]).run()).rejects.toThrow("does not accept positional arguments");
		expect(SessionManager.listAll).not.toHaveBeenCalled();
		expect(Bun.spawn).not.toHaveBeenCalled();
	});

	for (const stream of ["stdin", "stdout"] as const) {
		it(`rejects non-interactive ${stream} before discovering sessions`, async () => {
			Object.defineProperty(process[stream], "isTTY", { configurable: true, value: false });
			await expect(command().run()).rejects.toThrow("requires an interactive terminal");
			expect(SessionManager.listAll).not.toHaveBeenCalled();
			expect(Bun.spawn).not.toHaveBeenCalled();
		});
	}

	it("cancels without launching an agent and keeps folder/global scope datasets distinct", async () => {
		vi.spyOn(picker, "selectSession").mockResolvedValue(null);
		await expect(command().run()).rejects.toEqual(new CommandExit(0));
		expect(picker.selectSession).toHaveBeenCalledWith(
			[expect.objectContaining({ id: "local-session", cwd: sourceCwd })],
			expect.objectContaining({
				initialScope: "all",
				preview: true,
				allSessions: [expect.objectContaining({ id: "local-session" }), selected],
			}),
			expect.objectContaining({
				loadPinnedIds: expect.any(Function),
				loadHistoryMatcher: expect.any(Function),
				deleteSession: expect.any(Function),
				loadAllSessions: expect.any(Function),
				createPreview: expect.any(Function),
			}),
		);
		expect(Bun.spawn).not.toHaveBeenCalled();
	});

	it("rejects a missing recorded directory instead of resuming in the launch directory", async () => {
		await fs.rmdir(targetCwd);
		await expect(command().run()).rejects.toThrow(`its project directory is unavailable (${targetCwd})`);
		expect(Bun.spawn).not.toHaveBeenCalled();
		expect(process.exit).not.toHaveBeenCalled();
	});

	it("reports an empty session collection without opening the picker or launching", async () => {
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await command().run();
		expect(output).toHaveBeenCalledWith("No sessions found\n");
		expect(picker.selectSession).not.toHaveBeenCalled();
		expect(Bun.spawn).not.toHaveBeenCalled();
	});

	for (const compiled of [false, true]) {
		it(`resumes the original rollout in its recorded cwd from a ${compiled ? "compiled" : "source"} launcher`, async () => {
			const executable = path.join(root, compiled ? "omp" : "bun");
			const sourceRoot = path.join(root, "source checkout");
			const rolloutPath = path.join(root, "journals", "original-session.jsonl");
			selected.path = path.relative(sourceCwd, rolloutPath);
			vi.spyOn(workers, "resolveWorkerSpawnCmd").mockReturnValue(
				compiled ? { cmd: [executable, "launch"] } : { cmd: [executable, "src/cli.ts", "launch"], cwd: sourceRoot },
			);
			const listenerCounts = ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(name => process.listenerCount(name));
			vi.spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(17),
				signalCode: null,
				kill: vi.fn(),
			} as unknown as Subprocess);
			await expect(command().run()).rejects.toEqual(new CommandExit(17));
			expect(Bun.spawn).toHaveBeenCalledWith(
				[executable, ...(compiled ? [] : [path.join(sourceRoot, "src/cli.ts")]), "launch", "--resume", rolloutPath],
				expect.objectContaining({ cwd: targetCwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
			);
			expect(["SIGINT", "SIGTERM", "SIGHUP", "exit"].map(name => process.listenerCount(name))).toEqual(
				listenerCounts,
			);
		});
	}

	it("removes source dotenv values while preserving inherited values and the absolute agent-state root", async () => {
		const prefix = `OMP_SESSIONS_TEST_${path.basename(root).replaceAll("-", "_")}`;
		const projectKey = `${prefix}_PROJECT`;
		const sourceOnlyKey = `${prefix}_SOURCE_ONLY`;
		const inheritedKey = `${prefix}_PARENT`;
		await Bun.write(path.join(sourceCwd, ".env"), `${projectKey}=source\n${sourceOnlyKey}=source-only\n`);
		await Bun.write(path.join(targetCwd, ".env"), `${projectKey}=target\n`);
		const absoluteAgentDir = path.join(root, "agent-state");
		process.env.PI_CODING_AGENT_DIR = "../agent-state";
		vi.spyOn(utils, "getAgentDir").mockReturnValue(absoluteAgentDir);
		vi.spyOn(workers, "workerEnvFromParent").mockReturnValue({
			[projectKey]: "source",
			[sourceOnlyKey]: "source-only",
			[inheritedKey]: "retained",
			PI_CODING_AGENT_DIR: "../agent-state",
		});
		vi.spyOn(workers, "resolveWorkerSpawnCmd").mockReturnValue({ cmd: ["omp", "launch"] });
		vi.spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(0),
			signalCode: null,
			kill: vi.fn(),
		} as unknown as Subprocess);
		await expect(command().run()).rejects.toEqual(new CommandExit(0));
		expect(Bun.spawn).toHaveBeenCalledWith(
			["omp", "launch", "--resume", selected.path],
			expect.objectContaining({
				cwd: targetCwd,
				env: { [inheritedKey]: "retained", PI_CODING_AGENT_DIR: absoluteAgentDir },
			}),
		);
	});
});
