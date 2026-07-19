import { beforeAll, describe, expect, it } from "bun:test";
import { SubagentHudComponent } from "@oh-my-pi/pi-coding-agent/modes/components/subagent-hud";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";

function session(id: string): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		status: "active",
		detached: true,
		lastUpdate: 0,
	};
}

function mouse(overrides: Partial<SgrMouseEvent> = {}): SgrMouseEvent {
	return {
		button: 0,
		buttonId: 0,
		col: 0,
		row: 0,
		release: false,
		wheel: null,
		motion: false,
		shift: false,
		alt: false,
		ctrl: false,
		leftClick: true,
		...overrides,
	};
}

describe("subagent HUD mouse routing", () => {
	beforeAll(initTheme);

	it("maps physical agent rows to their session ids", () => {
		const focused: string[] = [];
		const component = new SubagentHudComponent({ onAgent: id => focused.push(id), onManager: () => {} });
		component.update([session("First"), session("Second")], 100);

		component.routeMouse(mouse(), 2, 5);
		component.routeMouse(mouse(), 3, 5);

		expect(focused).toEqual(["First", "Second"]);
	});

	it("opens the manager from the header and overflow summary", () => {
		let opened = 0;
		const component = new SubagentHudComponent({ onAgent: () => {}, onManager: () => opened++ });
		component.update(
			Array.from({ length: 9 }, (_, index) => session(`Agent${index}`)),
			100,
		);

		component.routeMouse(mouse(), 1, 0);
		component.routeMouse(mouse(), 10, 0);

		expect(opened).toBe(2);
	});

	it("ignores release, drag, non-left, blank, and out-of-range events", () => {
		const actions: string[] = [];
		const component = new SubagentHudComponent({
			onAgent: id => actions.push(id),
			onManager: () => actions.push("manager"),
		});
		component.update([session("First")], 100);

		component.routeMouse(mouse({ release: true, leftClick: false }), 2, 0);
		component.routeMouse(mouse({ button: 32, motion: true, leftClick: false }), 2, 0);
		component.routeMouse(mouse({ button: 2, buttonId: 2, leftClick: false }), 2, 0);
		component.routeMouse(mouse(), 0, 0);
		component.routeMouse(mouse(), 3, 0);

		expect(actions).toEqual([]);
	});
});
