import type { Component } from "@oh-my-pi/pi-tui";
import { FullscreenChatLayout } from "../src/modes/components/fullscreen-chat-layout";

const WIDTH = 80;
const HEIGHT = 24;

class Lines implements Component {
	constructor(readonly lines: string[]) {}

	render(): readonly string[] {
		return this.lines;
	}
}

class FixtureEditor implements Component {
	#text = "";

	handleInput(data: string): void {
		this.#text += data;
	}

	render(): readonly string[] {
		return ["─".repeat(WIDTH), `> ${this.#text}█`, "─".repeat(WIDTH)];
	}
}

const state = Bun.argv[2] ?? "initial";
const transcript = new Lines(
	Array.from(
		{ length: 36 },
		(_, index) => `message ${String(index + 1).padStart(2, "0")}  deterministic fullscreen transcript row`,
	),
);
const editor = new FixtureEditor();
const layout = new FullscreenChatLayout({
	transcript,
	editor,
	beforeEditor: [new Lines(["working · fullscreen screenshot fixture"])],
	getTerminalRows: () => HEIGHT,
});

layout.render(WIDTH);
if (state === "scrolled" || state === "anchored") {
	layout.handleInput("\x1b[<64;1;1M");
	layout.handleInput("\x1b[<64;1;1M");
}
if (state === "anchored") {
	editor.handleInput("draft while scrolled up");
	transcript.lines.push("message 37  streamed while viewport remains anchored");
}
if (state === "follow") {
	editor.handleInput("draft after returning to bottom");
	layout.handleInput("\x1b[8^");
	transcript.lines.push("message 37  followed at transcript bottom");
}

const frame = layout.render(WIDTH);
process.stdout.write(`\x1b[2J\x1b[H${frame.join("\r\n")}`);
await Bun.sleep(2_000);
