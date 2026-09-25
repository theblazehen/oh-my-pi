import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component, Focusable, MouseRoutable, SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	FullscreenChatLayout,
	FullscreenTranscriptAggregate,
} from "../../../src/modes/components/fullscreen-chat-layout";

class MutableLines implements Component {
	constructor(readonly lines: string[]) {}

	render(): readonly string[] {
		return [...this.lines];
	}
}

class PersistentMutableLines implements Component {
	readonly lines = ["initial"];

	render(): readonly string[] {
		return this.lines;
	}
}

class CountingBlock implements Component {
	renderCalls = 0;

	constructor(readonly lines: readonly string[]) {}

	render(): readonly string[] {
		this.renderCalls++;
		return this.lines;
	}
}

class FullComposeForbiddenTranscript extends TranscriptContainer {
	override render(): readonly string[] {
		throw new Error("fullscreen aggregate must use the block seam");
	}
}

class RecordingEditor implements Component, Focusable {
	readonly input: string[] = [];
	focused = false;
	useTerminalCursor = false;

	constructor(readonly lines: string[]) {}

	render(): readonly string[] {
		return [...this.lines];
	}

	handleInput(data: string): void {
		this.input.push(data);
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.useTerminalCursor = useTerminalCursor;
	}
}

class MouseTarget extends MutableLines implements MouseRoutable {
	readonly events: Array<{ event: SgrMouseEvent; line: number; col: number }> = [];

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.events.push({ event, line, col });
	}
}

function visibleTranscript(frame: readonly string[]): string[] {
	return frame.slice(0, -2).map(line => line.slice(0, 2));
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("FullscreenChatLayout", () => {
	it("keeps complete blocks accessible without rewinding native retirement", () => {
		const transcript = new TranscriptContainer();
		let allocation = 1;
		const block = {
			setTranscriptAllocation(rows: number) {
				allocation = rows;
			},
			render() {
				return ["", ...["first", "second", "third"].slice(0, allocation), ""];
			},
		};
		transcript.addChild(block);
		const batch = transcript.peekFlushBatch(80);
		expect(batch).toBeDefined();
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		block.setTranscriptAllocation(1);
		expect(transcript.renderTranscriptBlock(0, 80)).toEqual(["first", "second", "third"]);
		expect(transcript.getTranscriptBlockIdentity(0)).toBe(block);
		const layout = new FullscreenChatLayout({
			transcript,
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 4,
		});
		expect(layout.render(80)).toEqual(["first", "second", "third", "editor"]);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
	});

	it("shows transcript rows appended through a persistent child array reference", () => {
		const transcript = new PersistentMutableLines();
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate([transcript]),
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 4,
		});

		expect(layout.render(20)).toContain("initial");
		transcript.lines.push("streamed");
		expect(layout.render(20)).toContain("streamed");
	});

	it("pages hundreds of nested blocks without full composition or physical-row cutoffs", () => {
		const transcript = new FullComposeForbiddenTranscript();
		const first = new CountingBlock([
			"\x1b[31mFIRST-MARKER\x1b[0m",
			...Array.from({ length: 24 }, (_, index) => `first-body-${index}`),
			"\x1b[31mFIRST-END\x1b[0m",
		]);
		const blocks = [first];
		transcript.addChild(first);
		for (let index = 1; index < 300; index++) {
			const block = new CountingBlock([`block-${index}`]);
			blocks.push(block);
			transcript.addChild(block);
		}
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate([transcript]),
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 7,
			maxTranscriptRows: 20,
		});
		const plainTranscript = (frame: readonly string[]) =>
			frame.slice(0, -1).map(line => stripVTControlCharacters(line));
		const totalRenderCalls = () => blocks.reduce((total, block) => total + block.renderCalls, 0);

		const initial = plainTranscript(layout.render(60));
		expect(initial).toContain("block-299");
		expect(first.renderCalls).toBe(0);
		expect(totalRenderCalls()).toBeLessThan(40);

		layout.handleInput("\x1b[7^");
		const home = plainTranscript(layout.render(60));
		expect(home[0]).toBe("FIRST-MARKER");
		expect(first.renderCalls).toBe(1);

		let sawFirstEnd = false;
		let sawMiddle = false;
		let reachedTail = false;
		for (let page = 0; page < 200; page++) {
			const callsBefore = totalRenderCalls();
			layout.handleInput("\x1b[6;2~");
			const frame = plainTranscript(layout.render(60));
			expect(totalRenderCalls() - callsBefore).toBeLessThan(50);
			sawFirstEnd ||= frame.includes("FIRST-END");
			sawMiddle ||= frame.includes("block-150");
			if (frame.includes("block-299")) {
				reachedTail = true;
				break;
			}
		}
		expect(sawFirstEnd).toBe(true);
		expect(sawMiddle).toBe(true);
		expect(reachedTail).toBe(true);

		layout.handleInput("\x1b[8^");
		expect(plainTranscript(layout.render(60))).toContain("block-299");
		const appended = new CountingBlock(["LIVE-APPEND"]);
		blocks.push(appended);
		transcript.addChild(appended);
		expect(plainTranscript(layout.render(60))).toContain("LIVE-APPEND");

		layout.handleInput("\x1b[1;2A");
		const parked = plainTranscript(layout.render(60));
		const parkedAppend = new CountingBlock(["PARKED-APPEND"]);
		blocks.push(parkedAppend);
		transcript.addChild(parkedAppend);
		expect(plainTranscript(layout.render(60))).toEqual(parked);
	});

	it("joins stripped nested contributions with exactly one separator", () => {
		const transcript = new FullComposeForbiddenTranscript();
		transcript.addChild(new CountingBlock(["", "nested-a", ""]));
		transcript.addChild(new CountingBlock(["", "  "]));
		transcript.addChild(new CountingBlock(["", "nested-b", ""]));
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate([new CountingBlock(["ordinary"]), transcript]),
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 7,
		});

		expect(layout.render(40).slice(0, 4)).toEqual(["ordinary", "nested-a", "", "nested-b"]);
	});

	it("keeps a parked nested block anchored when ordinary aggregate children shift ordinals", () => {
		const transcript = new FullComposeForbiddenTranscript();
		for (let index = 0; index < 80; index++) transcript.addChild(new CountingBlock([`nested-${index}`]));
		const ordinary = new CountingBlock(["ordinary"]);
		const aggregateChildren: Component[] = [ordinary, transcript];
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate(aggregateChildren),
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 6,
		});

		layout.render(40);
		layout.handleInput("\x1b[5;2~");
		const parked = layout.render(40).slice(0, -1);
		aggregateChildren.unshift(new CountingBlock(["inserted-before"]));
		expect(layout.render(40).slice(0, -1)).toEqual(parked);
		aggregateChildren.shift();
		expect(layout.render(40).slice(0, -1)).toEqual(parked);
	});

	it("fills the terminal and pins lower chrome and editor at the bottom", () => {
		const transcript = new MutableLines(["t0", "t1"]);
		const editor = new RecordingEditor(["edit"]);
		const layout = new FullscreenChatLayout({
			transcript,
			editor,
			beforeEditor: [new MutableLines(["hud"])],
			getTerminalRows: () => 6,
		});

		const frame = layout.render(20);
		expect(frame).toHaveLength(6);
		expect(frame.slice(-2)).toEqual(["hud", "edit"]);
		expect(frame.slice(0, 4).map(line => line.slice(0, 2))).toEqual(["t0", "t1", "", ""]);
		expect(layout.ownsOverlayFocusTarget(editor)).toBe(false);
	});

	it("scrolls only the transcript and preserves its offset as content grows", () => {
		const transcript = new MutableLines(Array.from({ length: 8 }, (_, index) => `t${index}`));
		const editor = new RecordingEditor(["editor-a", "editor-b"]);
		const layout = new FullscreenChatLayout({ transcript, editor, getTerminalRows: () => 6 });

		expect(visibleTranscript(layout.render(20))).toEqual(["t4", "t5", "t6", "t7"]);
		layout.handleInput("\x1b[1;2A");
		expect(visibleTranscript(layout.render(20))).toEqual(["t0", "t1", "t2", "t3"]);
		expect(layout.render(20).slice(-2)).toEqual(["editor-a", "editor-b"]);

		transcript.lines.push("t8", "t9");
		expect(visibleTranscript(layout.render(20))).toEqual(["t0", "t1", "t2", "t3"]);
	});

	it("follows appended content at bottom and Ctrl+End restores follow", () => {
		const transcript = new MutableLines(Array.from({ length: 8 }, (_, index) => `t${index}`));
		const editor = new RecordingEditor(["editor-a", "editor-b"]);
		const layout = new FullscreenChatLayout({ transcript, editor, getTerminalRows: () => 6 });

		transcript.lines.push("t8");
		expect(visibleTranscript(layout.render(20))).toEqual(["t5", "t6", "t7", "t8"]);
		layout.handleInput("\x1b[1;2A");
		transcript.lines.push("t9");
		expect(visibleTranscript(layout.render(20))).toEqual(["t0", "t1", "t2", "t3"]);

		layout.handleInput("\x1b[8^");
		expect(visibleTranscript(layout.render(20))).toEqual(["t6", "t7", "t8", "t9"]);
		transcript.lines.push("t10");
		expect(visibleTranscript(layout.render(20))).toEqual(["t7", "t8", "t9", "t1"]);
	});

	it("keeps a real streaming assistant visible while pinned HUD rows mutate", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new UserMessageComponent(
				Array.from(
					{ length: 12 },
					(_, index) => `History row ${index}: establish enough transcript to scroll.`,
				).join("\n\n"),
			),
		);
		const hud = new MutableLines(["status: starting", "todo: inspect"]);
		const editor = new RecordingEditor(["> "]);
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate([transcript]),
			editor,
			beforeEditor: [hud],
			getTerminalRows: () => 9,
		});
		const initialTranscript = transcript.render(32);
		expect(initialTranscript.length).toBeGreaterThan(6);
		expect(
			layout
				.render(32)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
		).toContain("History row 11");

		const assistant = new AssistantMessageComponent();
		transcript.addChild(assistant);

		const updates = ["STREAM-ONE", "STREAM-ONE\n\nSTREAM-TWO", "STREAM-ONE\n\nSTREAM-TWO\n\nSTREAM-THREE-LATEST"];
		for (const [index, text] of updates.entries()) {
			assistant.updateContent(assistantMessage(text));
			hud.lines.splice(0, hud.lines.length, `status: pass ${index + 1}`, `todo: ${3 - index} remaining`);

			const currentTranscript = transcript.render(32).map(line => stripVTControlCharacters(line));
			const frame = layout.render(32).map(line => stripVTControlCharacters(line));
			const latest = text.split("\n").at(-1)!;
			// First distinguish stale component/container output from viewport-follow failure.
			expect(currentTranscript.join("\n")).toContain(latest);
			expect(frame.slice(0, -3).join("\n")).toContain(latest);
			expect(frame.slice(-3)).toEqual([`status: pass ${index + 1}`, `todo: ${3 - index} remaining`, "> "]);
		}
	});

	it("preserves follow state and application offset across terminal resizes", () => {
		let rows = 6;
		const transcript = new MutableLines(Array.from({ length: 10 }, (_, index) => `t${index}`));
		const editor = new RecordingEditor(["editor-a", "editor-b"]);
		const layout = new FullscreenChatLayout({ transcript, editor, getTerminalRows: () => rows });

		expect(visibleTranscript(layout.render(20))).toEqual(["t6", "t7", "t8", "t9"]);
		layout.handleInput("\x1b[1;2A");
		rows = 8;
		expect(
			layout
				.render(20)
				.slice(0, 6)
				.map(line => line.slice(0, 2)),
		).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);

		layout.handleInput("\x1b[8^");
		rows = 5;
		expect(
			layout
				.render(20)
				.slice(0, 3)
				.map(line => line.slice(0, 2)),
		).toEqual(["t7", "t8", "t9"]);
	});

	it("keeps ordinary editor keys delegated while consuming dedicated scroll input", () => {
		const transcript = new MutableLines(Array.from({ length: 8 }, (_, index) => `t${index}`));
		const editor = new RecordingEditor(["editor-a", "editor-b"]);
		const layout = new FullscreenChatLayout({ transcript, editor, getTerminalRows: () => 6 });
		layout.render(20);

		layout.handleInput("x");
		layout.handleInput("\x1b[A");
		layout.handleInput("\x1b[H");
		layout.handleInput("\x1b[F");
		layout.handleInput("\x1b[5~");
		layout.handleInput("\x1b[6~");
		layout.handleInput("\x1b[1;2A");
		layout.handleInput("\x1b[<64;1;1M");

		expect(editor.input).toEqual(["x", "\x1b[A", "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~"]);
		expect(visibleTranscript(layout.render(20))).toEqual(["t0", "t1", "t2", "t3"]);
	});

	it("pages the transcript with shifted PageUp/PageDown and scrolls it with the mouse wheel", () => {
		const transcript = new MutableLines(Array.from({ length: 12 }, (_, index) => `t${index}`));
		const editor = new RecordingEditor(["editor-a", "editor-b"]);
		const layout = new FullscreenChatLayout({ transcript, editor, getTerminalRows: () => 6 });

		expect(visibleTranscript(layout.render(20))).toEqual(["t8", "t9", "t1", "t1"]);
		layout.handleInput("\x1b[5;2~");
		expect(visibleTranscript(layout.render(20))).toEqual(["t5", "t6", "t7", "t8"]);
		layout.handleInput("\x1b[6;2~");
		expect(visibleTranscript(layout.render(20))).toEqual(["t8", "t9", "t1", "t1"]);
		layout.handleInput("\x1b[<64;1;1M");
		expect(visibleTranscript(layout.render(20))).toEqual(["t6", "t7", "t8", "t9"]);
		layout.handleInput("\x1b[<65;1;1M");
		expect(visibleTranscript(layout.render(20))).toEqual(["t8", "t9", "t1", "t1"]);
		expect(editor.input).toEqual([]);
	});

	it("uses the configured mouse wheel row count", () => {
		const transcript = new MutableLines(Array.from({ length: 12 }, (_, index) => `t${index}`));
		const layout = new FullscreenChatLayout({
			transcript,
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 5,
			wheelScrollRows: 2,
		});

		layout.render(20);
		layout.handleInput("\x1b[<64;1;1M");
		expect(
			layout
				.render(20)
				.slice(0, 4)
				.map(line => line.slice(0, 2)),
		).toEqual(["t6", "t7", "t8", "t9"]);
	});

	it("highlights a drag and copies plain transcript text only on release", () => {
		const copied: string[] = [];
		const transcript = new MutableLines(["\x1b[31mab界d\x1b[0m", "second"]);
		const layout = new FullscreenChatLayout({
			transcript,
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 4,
			copyText: text => copied.push(text),
		});

		layout.render(20);
		layout.handleInput("\x1b[<0;2;1M");
		layout.handleInput("\x1b[<32;4;2M");
		const highlighted = layout.render(20);
		expect(highlighted[0]).toContain("\x1b[7m");
		expect(highlighted[1]).toContain("\x1b[7m");
		expect(copied).toEqual([]);

		layout.handleInput("\x1b[<0;4;2m");
		expect(copied).toEqual(["b界d\nseco"]);
		expect(layout.render(20).join("")).not.toContain("\x1b[7m");
	});

	it("cancels a drag when paging evicts its anchor and remains usable", () => {
		const copied: string[] = [];
		const editor = new RecordingEditor(["editor"]);
		let renderRequests = 0;
		const layout = new FullscreenChatLayout({
			transcript: new FullscreenTranscriptAggregate(
				Array.from({ length: 80 }, (_, index) => new CountingBlock([`block-${index}`])),
			),
			editor,
			getTerminalRows: () => 5,
			maxTranscriptRows: 8,
			copyText: text => copied.push(text),
			requestRender: () => renderRequests++,
		});

		layout.render(20);
		layout.handleInput("\x1b[<0;1;4M");
		const selectedFrame = layout.render(20);
		expect(selectedFrame.join("")).toContain("\x1b[7m");
		for (let step = 0; step < 9; step++) {
			const requestsBefore = renderRequests;
			layout.handleInput("\x1b[<32;1;1M");
			expect(renderRequests).toBe(requestsBefore + 1);
		}

		const frame = layout.render(20);
		expect(frame.join("")).not.toContain("\x1b[7m");
		layout.handleInput("\x1b[<0;1;1m");
		layout.handleInput("x");
		expect(copied).toEqual([]);
		expect(editor.input.at(-1)).toBe("x");
		expect(layout.render(20)).toContain("editor");
	});

	it("does not copy a click and never starts selection in pinned chrome", () => {
		const copied: string[] = [];
		const layout = new FullscreenChatLayout({
			transcript: new MutableLines(["transcript"]),
			editor: new RecordingEditor(["editor"]),
			beforeEditor: [new MutableLines(["hud"])],
			getTerminalRows: () => 4,
			copyText: text => copied.push(text),
		});

		layout.render(20);
		layout.handleInput("\x1b[<0;2;1M");
		layout.handleInput("\x1b[<0;2;1m");
		layout.handleInput("\x1b[<0;2;3M");
		layout.handleInput("\x1b[<32;5;3M");
		layout.handleInput("\x1b[<0;5;3m");
		expect(copied).toEqual([]);
	});

	it("retains a complete oversized ordinary block and preserves its scrolled position", () => {
		const transcript = new MutableLines(Array.from({ length: 7 }, (_, index) => `t${index}`));
		const layout = new FullscreenChatLayout({
			transcript,
			editor: new RecordingEditor(["editor"]),
			getTerminalRows: () => 4,
			maxTranscriptRows: 5,
			wheelScrollRows: 1,
		});

		expect(layout.render(20).slice(0, 3)).toEqual(["t4", "t5", "t6"]);
		layout.handleInput("\x1b[<64;1;1M");
		expect(layout.render(20).slice(0, 3)).toEqual(["t3", "t4", "t5"]);
		transcript.lines.push("t7");
		expect(layout.render(20).slice(0, 3)).toEqual(["t3", "t4", "t5"]);
		layout.handleInput("\x1b[1;5H");
		expect(layout.render(20).slice(0, 3)).toEqual(["t0", "t1", "t2"]);
	});

	it("routes exact pinned render rows to MouseRoutable components", () => {
		const first = new MouseTarget(["first-0", "first-1"]);
		const second = new MouseTarget(["second"]);
		const layout = new FullscreenChatLayout({
			transcript: new MutableLines(["transcript"]),
			editor: new RecordingEditor(["editor"]),
			beforeEditor: [first, second],
			getTerminalRows: () => 5,
		});

		layout.render(20);
		layout.handleInput("\x1b[<0;7;3M");
		layout.handleInput("\x1b[<0;8;4M");
		expect(first.events.map(({ line, col }) => ({ line, col }))).toEqual([{ line: 1, col: 6 }]);
		expect(second.events.map(({ line, col }) => ({ line, col }))).toEqual([{ line: 0, col: 7 }]);
	});

	it("forwards focus and terminal cursor state to the active editor", () => {
		const editor = new RecordingEditor(["editor"]);
		const layout = new FullscreenChatLayout({
			transcript: new MutableLines([]),
			editor,
			getTerminalRows: () => 2,
		});

		layout.focused = true;
		layout.setUseTerminalCursor(true);
		expect(editor.focused).toBe(true);
		expect(editor.useTerminalCursor).toBe(true);

		layout.focused = false;
		layout.setUseTerminalCursor(false);
		expect(editor.focused).toBe(false);
		expect(editor.useTerminalCursor).toBe(false);
	});

	it("transfers focus and cursor state when replacing its borrowed editor", () => {
		const first = new RecordingEditor(["first"]);
		const second = new RecordingEditor(["second"]);
		const layout = new FullscreenChatLayout({
			transcript: new MutableLines([]),
			editor: first,
			getTerminalRows: () => 2,
		});

		layout.focused = true;
		layout.setUseTerminalCursor(true);
		layout.setEditor(second);
		layout.handleInput("z");
		expect(layout.render(20)).toEqual(["", "second"]);
		expect(first.input).toEqual([]);
		expect(first.focused).toBe(false);
		expect(second.input).toEqual(["z"]);
		expect(second.focused).toBe(true);
		expect(second.useTerminalCursor).toBe(true);
		expect(layout.ownsOverlayFocusTarget(first)).toBe(false);
		expect(layout.ownsOverlayFocusTarget(second)).toBe(false);
	});

	it("renders a separate editor host while delegating input and preserving its transient focus targets", () => {
		const editor = new RecordingEditor(["unhosted editor"]);
		const editorHost = new MutableLines(["hosted editor"]);
		const transientChild = new MutableLines(["autocomplete"]);
		const layout = new FullscreenChatLayout({
			transcript: new MutableLines([]),
			editor,
			editorHost,
			isEditorHostFocusTarget: component => component === transientChild,
			getTerminalRows: () => 2,
		});

		layout.handleInput("x");
		expect(layout.render(20)).toEqual(["", "hosted editor"]);
		expect(editor.input).toEqual(["x"]);
		expect(layout.ownsOverlayFocusTarget(editor)).toBe(false);
		expect(layout.ownsOverlayFocusTarget(transientChild)).toBe(true);
		expect(layout.ownsOverlayFocusTarget(editorHost)).toBe(false);
	});
});
