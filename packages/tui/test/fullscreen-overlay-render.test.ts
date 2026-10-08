import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	type Focusable,
	CURSOR_MARKER,
	ImageProtocol,
	renderKittyPlaceholderLines,
	setTerminalImageProtocol,
	TERMINAL,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

class MutableLinesComponent implements Component, Focusable {
	#lines: string[];
	focused = false;

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setUseTerminalCursor(_useTerminalCursor: boolean): void {}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("fullscreen overlay rendering", () => {
	const scheduler = new VirtualRenderScheduler();
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		scheduler.reset();
		for (const key of [
			"TERM_PROGRAM",
			"TMUX",
			"STY",
			"ZELLIJ",
			"HERDR",
			"HERDR_EXPORT_SOCKET",
			"PI_TUI_RESIZE_IN_PLACE",
		]) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		for (const key in savedEnv) {
			if (savedEnv[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = savedEnv[key];
		}
		vi.restoreAllMocks();
	});
	it("passes terminal image rows through the fullscreen compositor byte-exact", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const [imageLine] = renderKittyPlaceholderLines({ imageId: 17, placementId: 4, columns: 2, rows: 1 });
		const term = new VirtualTerminal(20, 3, 20);
		const writes = captureWrites(term);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const imageComponent: Component = { render: () => [imageLine], invalidate: () => {} };

		try {
			tui.start();
			const showFrom = writes.length;
			tui.showOverlay(imageComponent, {
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			await scheduler.settle(term);

			const paint = writes.slice(showFrom).join("");
			expect(TERMINAL.isImageLine(imageLine)).toBeTrue();
			// The compositor may frame a row with EL and CRLF, but the image line
			// itself must remain the exact contiguous payload returned by render().
			expect(paint).toContain(`\x1b[2K${imageLine}\r\n`);
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("positions and shows the hardware cursor for a focused fullscreen editor", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const editor = new MutableLinesComponent([`prompt>abc${CURSOR_MARKER}`]);

		try {
			tui.start();
			tui.showOverlay(editor, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
				mouseTracking: "motion",
			});
			await scheduler.settle(term);

			expect(term.getCursor()).toEqual({ row: 7, col: 10 });
			const paints = tui.fullRedraws;
			editor.setLines([`prompt>${CURSOR_MARKER}abc`]);
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.getCursor()).toEqual({ row: 7, col: 7 });
			expect(tui.fullRedraws).toBe(paints);
		} finally {
			tui.stop();
		}
	});

	it("enters the alt buffer on show, leaves it on hide, and emits no ED3 while modal", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.addChild(new MutableLinesComponent(rows("base-", 8)));

		try {
			tui.start();
			await scheduler.settle(term);

			const showFrom = writes.length;
			const handle = tui.showOverlay(new MutableLinesComponent(["MODAL-0", "MODAL-1"]), {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
				mouseTracking: "motion",
			});
			await scheduler.settle(term);

			const modalWrites = writes.slice(showFrom).join("");
			// Borrowed the alternate screen buffer …
			expect(modalWrites).toContain("\x1b[?1049h");
			// … re-pushed kitty keyboard flags in the same write: the mode stack
			// is per-screen, so without this Esc reverts to legacy bare \x1b
			// inside fullscreen overlays (settings Esc bug).
			expect(modalWrites).toContain("\x1b[?1049h\x1b[>1u");
			// … enabled any-motion tracking for click/scroll/hover support …
			expect(modalWrites).toContain("\x1b[?1003h"); // any-motion tracking drives hover
			expect(modalWrites).toContain("\x1b[?1006h");
			expect(modalWrites).not.toContain("\x1b[?1002h");
			// … and never erased scrollback (ED3) or otherwise touched the transcript.
			expect(modalWrites).not.toContain("\x1b[3J");
			expect(visible(term).some(line => line.includes("MODAL-0"))).toBeTrue();

			const hideFrom = writes.length;
			handle.hide();
			await scheduler.settle(term);

			const hideWrites = writes.slice(hideFrom).join("");
			expect(hideWrites).toContain("\x1b[?1049l");
			// The alt screen's kitty frame is popped before leaving it.
			expect(hideWrites).toContain("\x1b[<u\x1b[?1049l");
			// Mouse tracking is disabled again so the rest of the app keeps native
			// terminal selection.
			expect(hideWrites).toContain("\x1b[?1003l"); // motion tracking torn down too
			expect(hideWrites).toContain("\x1b[?1002l");
			// Transcript is back on the normal screen after leaving the alt buffer.
			expect(visible(term).some(line => line.includes("base-"))).toBeTrue();
			expect(visible(term).some(line => line.includes("MODAL-0"))).toBeFalse();
		} finally {
			tui.stop();
		}
	});

	it("leaves native text selection available for selection-first fullscreen overlays", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.addChild(new MutableLinesComponent(rows("base-", 8)));

		try {
			tui.start();
			await scheduler.settle(term);

			const showFrom = writes.length;
			const handle = tui.showOverlay(new MutableLinesComponent(["SELECTABLE PLAN TEXT"]), {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
				mouseTracking: false,
			});
			await scheduler.settle(term);

			const modalWrites = writes.slice(showFrom).join("");
			expect(modalWrites).toContain("\x1b[?1049h");
			expect(modalWrites).not.toContain("\x1b[?1000h");
			expect(modalWrites).not.toContain("\x1b[?1003h");
			expect(modalWrites).not.toContain("\x1b[?1006h");
			expect(visible(term).some(line => line.includes("SELECTABLE PLAN TEXT"))).toBeTrue();

			const hideFrom = writes.length;
			handle.hide();
			await scheduler.settle(term);

			const hideWrites = writes.slice(hideFrom).join("");
			expect(hideWrites).toContain("\x1b[?1049l");
			expect(hideWrites).not.toContain("\x1b[?1000l");
			expect(hideWrites).not.toContain("\x1b[?1003l");
			expect(hideWrites).not.toContain("\x1b[?1006l");
		} finally {
			tui.stop();
		}
	});

	it("switches exact mouse modes as nested fullscreen overlays change", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true, { renderScheduler: scheduler });

		try {
			tui.start();
			const drag = tui.showOverlay(new MutableLinesComponent(["DRAG"]), {
				fullscreen: true,
				mouseTracking: "drag",
			});
			await scheduler.settle(term);
			const dragEnter = writes.join("");
			expect(dragEnter).toContain("\x1b[?1049h\x1b[>1u\x1b[?1002h\x1b[?1006h");
			expect(dragEnter).not.toContain("\x1b[?1003h");

			const motionFrom = writes.length;
			const motion = tui.showOverlay(new MutableLinesComponent(["MOTION"]), {
				fullscreen: true,
				mouseTracking: "motion",
			});
			await scheduler.settle(term);
			const motionEnter = writes.slice(motionFrom).join("");
			expect(motionEnter).toContain("\x1b[?1002l");
			expect(motionEnter).toContain("\x1b[?1003h\x1b[?1006h");
			expect(motionEnter.indexOf("\x1b[?1002l")).toBeLessThan(motionEnter.indexOf("\x1b[?1003h"));
			expect(motionEnter).not.toContain("\x1b[?1049h");

			const resumeFrom = writes.length;
			motion.hide();
			await scheduler.settle(term);
			const resumeDrag = writes.slice(resumeFrom).join("");
			expect(resumeDrag).toContain("\x1b[?1003l");
			expect(resumeDrag).toContain("\x1b[?1002h\x1b[?1006h");
			expect(resumeDrag.indexOf("\x1b[?1003l")).toBeLessThan(resumeDrag.indexOf("\x1b[?1002h"));
			expect(resumeDrag).not.toContain("\x1b[?1049l");

			const exitFrom = writes.length;
			drag.hide();
			await scheduler.settle(term);
			const exit = writes.slice(exitFrom).join("");
			expect(exit).toContain("\x1b[?1000l\x1b[<u\x1b[?1049l");
		} finally {
			tui.stop();
		}
	});

	it("tears down drag tracking before leaving the alternate screen on stop", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		tui.start();
		tui.showOverlay(new MutableLinesComponent(["DRAG"]), {
			fullscreen: true,
			mouseTracking: "drag",
		});
		await scheduler.settle(term);

		const stopFrom = writes.length;
		tui.stop();
		const stopWrites = writes.slice(stopFrom).join("");
		expect(stopWrites).toContain("\x1b[?1000l\x1b[<u\x1b[?1049l");
	});
});
