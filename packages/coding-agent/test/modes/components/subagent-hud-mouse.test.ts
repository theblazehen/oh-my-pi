import { beforeAll, describe, expect, it } from "bun:test";
import { FullscreenChatLayout } from "@oh-my-pi/pi-coding-agent/modes/components/fullscreen-chat-layout";
import { SubagentHudComponent } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";

function click(layout: FullscreenChatLayout, row: number): void {
	layout.handleInput(`\x1b[<0;2;${row + 1}M`);
	layout.handleInput(`\x1b[<0;2;${row + 1}m`);
}

describe("shared fullscreen subagent click routing", () => {
	beforeAll(initTheme);

	it("uses the upstream physical row map for wrapped HUD rows", () => {
		const focused: string[][] = [];
		const hud = new Container();
		hud.addChild(
			new SubagentHudComponent(
				["", "Subagents", "First lengthy description continued", "Second"],
				["First", "Second"],
			),
		);
		const layout = new FullscreenChatLayout({
			transcript: new Text("history"),
			editor: new Text("editor"),
			beforeEditor: [hud],
			getTerminalRows: () => 12,
			onClickCandidates: ids => focused.push(ids),
		});
		const lines = layout.render(20);
		const continuation = lines.findIndex(line => line.includes("continued"));
		const second = lines.findIndex(line => line.includes("Second"));
		expect(continuation).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(continuation);
		click(layout, continuation);
		click(layout, second);
		expect(focused).toEqual([["First"], ["Second"]]);
	});

	it("preserves target offsets when the pinned HUD is clipped at the top", () => {
		const focused: string[][] = [];
		const hud = new Container();
		hud.addChild(new SubagentHudComponent(["", "Subagents", "First", "Second", "Expand"], ["First", "Second"], 4));
		const layout = new FullscreenChatLayout({
			transcript: new Text("history"),
			editor: new Text("editor", 0, 0),
			beforeEditor: [hud],
			getTerminalRows: () => 3,
			onClickCandidates: ids => focused.push(ids),
		});
		const lines = layout.render(40);
		const second = lines.findIndex(line => line.includes("Second"));
		const toggle = lines.findIndex(line => line.includes("Expand"));
		expect(second).toBe(0);
		expect(toggle).toBe(1);
		click(layout, second);
		click(layout, toggle);
		expect(focused).toEqual([["Second"], [PINNED_HUD_TOGGLE_ID]]);
	});

	it("focuses a transcript card on click but copies a drag without focusing", () => {
		const focused: string[][] = [];
		const transcript = { render: () => ["agent output"], getClickFocusAgentIds: () => ["First"] };
		const copied: string[] = [];
		const layout = new FullscreenChatLayout({
			transcript,
			editor: new Text("editor"),
			getTerminalRows: () => 5,
			onClickCandidates: ids => focused.push(ids),
			copyText: text => copied.push(text),
		});
		const row = layout.render(40).findIndex(line => line.includes("agent output"));
		expect(row).toBeGreaterThanOrEqual(0);
		click(layout, row);
		layout.handleInput(`\x1b[<0;1;${row + 1}M`);
		layout.handleInput(`\x1b[<32;5;${row + 1}M`);
		layout.handleInput(`\x1b[<0;5;${row + 1}m`);
		expect(focused).toEqual([["First"]]);
		expect(copied).toEqual(["agent"]);
	});
});
