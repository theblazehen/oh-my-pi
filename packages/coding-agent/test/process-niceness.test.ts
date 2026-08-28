import { describe, expect, it } from "bun:test";
import { applySubprocessNiceness, DEFAULT_SUBPROCESS_NICE } from "@oh-my-pi/pi-coding-agent/cli/process-niceness";

const WORKER_SELECTOR = "__omp_worker_test";

function capture(
	configuredValue: string | undefined,
	options: { selector?: string; isMainThread?: boolean; setterError?: unknown } = {},
) {
	const priorities: number[] = [];
	const warnings: string[] = [];
	applySubprocessNiceness(options.selector ?? WORKER_SELECTOR, options.isMainThread ?? true, configuredValue, {
		setPriority: nice => {
			priorities.push(nice);
			if (options.setterError !== undefined) throw options.setterError;
		},
		warn: warning => warnings.push(warning),
	});
	return { priorities, warnings };
}

describe("subprocess niceness policy", () => {
	it("defaults real OMP worker subprocesses to nice 19", () => {
		expect(capture(undefined)).toEqual({ priorities: [DEFAULT_SUBPROCESS_NICE], warnings: [] });
		expect(DEFAULT_SUBPROCESS_NICE).toBe(19);
	});

	it("leaves the normal CLI process priority unchanged", () => {
		expect(capture(undefined, { selector: "launch" })).toEqual({ priorities: [], warnings: [] });
	});

	it("leaves Bun worker-thread priority unchanged", () => {
		expect(capture(undefined, { isMainThread: false })).toEqual({ priorities: [], warnings: [] });
	});

	it("leaves inherited priority unchanged when explicitly opted out", () => {
		expect(capture("inherit")).toEqual({ priorities: [], warnings: [] });
	});

	it("applies a valid integer override", () => {
		expect(capture(" -5 ")).toEqual({ priorities: [-5], warnings: [] });
	});

	it.each(["", "high", "1.5", "0x10", "20", "-21"])("warns and leaves priority unchanged for %j", value => {
		const result = capture(value);
		expect(result.priorities).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Invalid OMP_SUBPROCESS_NICE");
		expect(result.warnings[0]).toContain("Subprocess priority was not changed");
	});

	it("keeps the worker usable and warns when the platform setter fails", () => {
		const result = capture(undefined, { setterError: new Error("operation not permitted") });
		expect(result.priorities).toEqual([19]);
		expect(result.warnings).toEqual([
			"Could not set subprocess niceness to 19; the OMP worker will continue at its existing priority. operation not permitted",
		]);
	});
});
