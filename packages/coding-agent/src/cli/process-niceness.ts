import { setPriority } from "node:os";
import { isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";

export const DEFAULT_SUBPROCESS_NICE = 19;

interface SubprocessNicenessDeps {
	setPriority(nice: number): void;
	warn(message: string): void;
}

const SYSTEM_DEPS: SubprocessNicenessDeps = {
	setPriority: nice => setPriority(0, nice),
	warn: message => process.stderr.write(`Warning: ${message}\n`),
};

/** Lower a real OMP worker subprocess without changing the interactive CLI or Bun worker threads. */
export function applySubprocessNiceness(
	selector: string | undefined,
	isMainThread: boolean,
	configuredValue: string | undefined,
	deps: SubprocessNicenessDeps = SYSTEM_DEPS,
): void {
	if (!isMainThread || !isWorkerHostSelector(selector)) return;

	const value = configuredValue?.trim();
	if (value === "inherit") return;

	const nice = configuredValue === undefined ? DEFAULT_SUBPROCESS_NICE : Number(value);
	if (
		(configuredValue !== undefined && !/^[+-]?\d+$/.test(value ?? "")) ||
		!Number.isInteger(nice) ||
		nice < -20 ||
		nice > 19
	) {
		deps.warn(
			`Invalid OMP_SUBPROCESS_NICE=${JSON.stringify(configuredValue)}; expected "inherit" or an integer from -20 to 19. Subprocess priority was not changed.`,
		);
		return;
	}

	try {
		deps.setPriority(nice);
	} catch (error) {
		deps.warn(
			`Could not set subprocess niceness to ${nice}; the OMP worker will continue at its existing priority. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
