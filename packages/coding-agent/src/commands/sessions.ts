import * as path from "node:path";
import { directoryExists, filterChildShellEnv, getAgentDir, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { selectSession } from "../session/session-picker";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { SessionManager } from "../session/session-manager";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";

/** Browse before launching an agent, so its project is known before initialization. */
export default class Sessions extends Command {
	static description = "Browse sessions across projects and resume in their original directory";
	static examples = ["omp sessions"];

	async run(): Promise<void> {
		const { argv } = await this.parse(Sessions);
		if (argv.length > 0) {
			throw new CliUsageError("The sessions browser does not accept positional arguments");
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new CliUsageError("The sessions browser requires an interactive terminal");
		}

		const sourceCwd = process.cwd();
		const agentDirOverride = process.env.PI_CODING_AGENT_DIR ? getAgentDir() : undefined;
		const allSessions = await SessionManager.listAll();
		if (allSessions.length === 0) {
			process.stdout.write("No sessions found\n");
			return;
		}
		const launchCwd = normalizePathForComparison(sourceCwd);
		const folderSessions = allSessions.filter(
			session => session.cwd && normalizePathForComparison(session.cwd) === launchCwd,
		);
		await initTheme();
		const selected = await selectSession(folderSessions, {
			allSessions,
			initialScope: "all",
			title: "Sessions",
			preview: true,
		});
		// selectSession stops the TUI and restores the terminal before resolving.
		if (!selected) process.exit(0);
		if (!selected.cwd || !(await directoryExists(selected.cwd))) {
			throw new CliUsageError(
				`Cannot resume session ${selected.id}: its project directory is unavailable (${selected.cwd || "not recorded"}). Restore the directory or move the session explicitly before resuming.`,
			);
		}

		// Reuse the CLI's compiled/source-host resolver, but anchor its relative
		// source entry before switching the child's cwd to the selected project.
		const invocation = resolveWorkerSpawnCmd("launch");
		if (invocation.cwd) invocation.cmd[1] = path.resolve(invocation.cwd, invocation.cmd[1]!);
		// Drop source-project dotenv values, but retain the browser's explicitly
		// selected agent storage even when its override was a relative path.
		const childEnv = filterChildShellEnv(workerEnvFromParent(), sourceCwd);
		if (agentDirOverride) childEnv.PI_CODING_AGENT_DIR = agentDirOverride;
		const child = Bun.spawn([...invocation.cmd, "--resume", path.resolve(sourceCwd, selected.path)], {
			cwd: selected.cwd,
			env: childEnv,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const onInterrupt = () => child.kill("SIGINT");
		const onTerminate = () => child.kill("SIGTERM");
		const onHangup = () => child.kill("SIGHUP");
		const onExit = () => child.kill("SIGTERM");
		process.on("SIGINT", onInterrupt);
		process.on("SIGTERM", onTerminate);
		process.on("SIGHUP", onHangup);
		process.on("exit", onExit);
		let exitCode: number;
		try {
			exitCode = await child.exited;
		} finally {
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
			process.off("SIGHUP", onHangup);
			process.off("exit", onExit);
		}
		if (child.signalCode) {
			process.kill(process.pid, child.signalCode);
			return;
		}
		process.exit(exitCode);
	}
}
