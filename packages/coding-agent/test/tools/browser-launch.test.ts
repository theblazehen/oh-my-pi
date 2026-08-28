import { describe, expect, it } from "bun:test";
import {
	buildHeadlessLaunchArgsForTest,
	stealthIgnoreDefaultArgsForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

describe("headless browser GPU launch policy", () => {
	const viewport = { width: 1280, height: 720 };

	it("enables ANGLE Vulkan when Linux has an accessible DRM render node", () => {
		const args = buildHeadlessLaunchArgsForTest(viewport, {
			platform: "linux",
			driEntries: ["card0", "renderD128"],
			accessibleDriEntries: ["renderD128"],
		});

		expect(args).toContain("--use-angle=vulkan");
		expect(args).toContain("--enable-features=Vulkan");
	});

	it("keeps the software/default path when Linux has no accessible render node", () => {
		for (const options of [
			{ driEntries: [] },
			{ driEntries: ["card0"] },
			{ driEntries: ["renderD128"], accessibleDriEntries: [] },
		]) {
			const args = buildHeadlessLaunchArgsForTest(viewport, { platform: "linux", ...options });

			expect(args).not.toContain("--use-angle=vulkan");
			expect(args).not.toContain("--enable-features=Vulkan");
			expect(args).not.toContain("--disable-software-rasterizer");
		}
	});

	it("does not alter GPU arguments on non-Linux platforms", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const args = buildHeadlessLaunchArgsForTest(viewport, {
				platform,
				driEntries: ["renderD128"],
				accessibleDriEntries: ["renderD128"],
			});

			expect(args).not.toContain("--use-angle=vulkan");
			expect(args).not.toContain("--enable-features=Vulkan");
		}
	});

	it("appends caller GPU overrides after policy defaults", () => {
		const callerArgs = ["--use-angle=swiftshader-webgl", "--enable-features=WebGPU"];
		const args = buildHeadlessLaunchArgsForTest(viewport, {
			platform: "linux",
			driEntries: ["renderD128"],
			accessibleDriEntries: ["renderD128"],
			additionalArgs: callerArgs,
		});

		expect(args.indexOf("--use-angle=vulkan")).toBeLessThan(args.indexOf(callerArgs[0]));
		expect(args.indexOf("--enable-features=Vulkan")).toBeLessThan(args.indexOf(callerArgs[1]));
	});
});
