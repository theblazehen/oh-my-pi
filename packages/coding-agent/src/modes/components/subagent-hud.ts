import { Container, type SgrMouseEvent, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatTaskId } from "../../task/render";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { renderTreeList } from "../../tui/tree-list";
import type { ObservableSession } from "../session-observer-registry";
import { theme } from "../theme/theme";

const VISIBLE_LIMIT = 8;

function runningSessions(sessions: ObservableSession[]): ObservableSession[] {
	return sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
}

export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = runningSessions(sessions);
	if (running.length === 0) return [];

	const dot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const displayId = formatTaskId(session.id);
				let line = `${dot} ${theme.fg("accent", theme.bold(displayId))}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				if (description) {
					const budget = Math.max(TRUNCATE_LENGTHS.SHORT, columns - visibleWidth(displayId) - 10);
					line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(replaceTabs(description), budget))}`;
				} else {
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview) {
						line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(taskPreview), TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Hub for full list`));
	}
	return [
		"",
		`${theme.bold(theme.fg("accent", "Subagents"))}  ${theme.fg("dim", "←←")}`,
		...rows.map(line => ` ${line}`),
	];
}

export interface SubagentHudCallbacks {
	onAgent: (id: string) => void;
	onManager: () => void;
}

/** Anchored subagent roster with click targets matching its physical render rows. */
export class SubagentHudComponent extends Container {
	#sessions: ObservableSession[] = [];
	#columns = 0;

	constructor(private readonly callbacks: SubagentHudCallbacks) {
		super();
	}

	update(sessions: ObservableSession[], columns: number): void {
		this.#sessions = runningSessions(sessions);
		this.#columns = columns;
		this.clear();
		const lines = renderSubagentHudLines(this.#sessions, this.#columns);
		if (lines.length > 0) this.addChild(new Text(lines.join("\n"), 1, 0));
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (!event.leftClick) return;
		if (line === 1) {
			this.callbacks.onManager();
			return;
		}
		const visible = this.#sessions.slice(0, VISIBLE_LIMIT);
		const index = line - 2;
		if (index >= 0 && index < visible.length) {
			this.callbacks.onAgent(visible[index].id);
			return;
		}
		if (index === visible.length && this.#sessions.length > VISIBLE_LIMIT) this.callbacks.onManager();
	}
}
