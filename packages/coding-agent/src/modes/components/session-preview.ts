import { type Component, Markdown, replaceTabs, ScrollView, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { SessionInfo } from "../../session/session-listing";
import { type SessionPreviewMessage, streamSessionPreview } from "../../session/session-preview";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";

/** Selected rollout preview; owns its reader and an independent viewport. */
export class SessionPreviewComponent implements Component {
	onRequestRender?: () => void;
	#controller?: AbortController;
	#session?: SessionInfo;
	#project = "Session preview";
	#scrollHeader = false;
	#content: Component[] = [];
	#messages: readonly SessionPreviewMessage[] = [];
	#state = "Choose a session to preview its recent messages.";
	#error = false;
	#width = -1;
	#dirty = true;
	#followLatest = true;
	#viewport = new ScrollView([], {
		height: 0,
		scrollbar: "always",
		theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
	});

	setSession(session?: SessionInfo, project = "Not recorded"): void {
		this.cancel();
		this.#session = session;
		this.#project = session ? project : "Session preview";
		this.#content = [];
		this.#messages = [];
		this.#error = false;
		this.#state = session ? "Reading recent messages…" : "No matching session. Change the search or scope.";
		this.#dirty = true;
		this.#followLatest = true;
		if (!session) return;
		const controller = new AbortController();
		this.#controller = controller;
		void this.#load(session.path, controller);
	}

	async #load(path: string, controller: AbortController): Promise<void> {
		try {
			for await (const update of streamSessionPreview(path, { signal: controller.signal })) {
				if (controller.signal.aborted || this.#controller !== controller) return;
				const changed =
					update.messages.length !== this.#messages.length ||
					update.messages.some((message, index) => message !== this.#messages[index]);
				if (changed) {
					const content: Component[] = [];
					for (const message of update.messages) {
						const label = message.role === "user" ? "You" : "Assistant";
						const timestamp = message.timestamp
							? ` · ${replaceTabs(sanitizeText(message.timestamp)).replace(/\n/g, " ")}`
							: "";
						content.push(new Text(theme.fg("accent", `${label}${timestamp}`), 0, 0));
						content.push(new Markdown(replaceTabs(sanitizeText(message.text)), 0, 0, getMarkdownTheme()));
						content.push(new Text("", 0, 0));
					}
					this.#content = content;
					this.#messages = update.messages;
					this.#dirty = true;
				}
				const partial =
					update.skippedRecords > 0
						? `Partial preview: ${update.skippedRecords} unreadable or oversized records skipped. `
						: "";
				const progress = update.complete
					? update.messages.length === 0
						? "No user or assistant text in this session."
						: "Recent messages"
					: "Reading older messages…";
				this.#state = `${partial}${progress}`;
				this.onRequestRender?.();
			}
		} catch (error) {
			if (controller.signal.aborted || this.#controller !== controller) return;
			this.#error = true;
			this.#state = `Unable to preview: ${replaceTabs(sanitizeText(error instanceof Error ? error.message : String(error)))}`;
			this.onRequestRender?.();
		}
	}

	cancel(): void {
		this.#controller?.abort();
		this.#controller = undefined;
	}

	dispose(): void {
		this.cancel();
		this.#content = [];
		this.#messages = [];
	}

	invalidate(): void {
		this.#dirty = true;
		for (const child of this.#content) child.invalidate?.();
	}

	handleInput(data: string): boolean {
		const handled = this.#viewport.handleScrollKey(data);
		if (handled) this.#followLatest = this.#viewport.getScrollOffset() === this.#viewport.getMaxScrollOffset();
		return handled;
	}

	scroll(delta: number): void {
		this.#viewport.scroll(delta);
		this.#followLatest = this.#viewport.getScrollOffset() === this.#viewport.getMaxScrollOffset();
	}

	render(width: number, height = 12): readonly string[] {
		if (width < 2 || height < 1) return [];
		const heading = this.#session?.title || this.#session?.firstMessage || this.#session?.id || "Choose a session";
		const project = theme.fg("accent", theme.bold(truncateToWidth(this.#project, width)));
		const header = theme.bold(truncateToWidth(replaceTabs(sanitizeText(heading)).replace(/\n/g, " ").trim(), width));
		const cwd = new Text(
			`Resume in: ${replaceTabs(sanitizeText(this.#session?.cwd || "Not recorded")).replace(/\n/g, " ")}`,
			0,
			0,
		).render(width - 1);
		const status = new Text(theme.fg(this.#error ? "error" : "muted", this.#state), 0, 0).render(width - 1);
		const chrome = [project, header, ...cwd, "", ...status, ""];
		// Extremely long paths still remain reachable via preview Home/scrolling
		// rather than being clipped away by a header taller than the terminal.
		const scrollHeader = chrome.length >= height;
		const previousDistance = this.#viewport.getMaxScrollOffset() - this.#viewport.getScrollOffset();
		if (this.#dirty || this.#width !== width || this.#scrollHeader !== scrollHeader || scrollHeader) {
			const lines: string[] = scrollHeader ? chrome.slice(1) : [];
			for (const child of this.#content) lines.push(...child.render(width - 1));
			this.#viewport.setLines(lines);
			this.#dirty = false;
			this.#width = width;
			this.#scrollHeader = scrollHeader;
		}
		const pinned = scrollHeader ? [project] : chrome;
		this.#viewport.setHeight(Math.max(0, height - pinned.length));
		this.#viewport.setScrollOffset(this.#viewport.getMaxScrollOffset() - (this.#followLatest ? 0 : previousDistance));
		return [...pinned, ...this.#viewport.render(width)].slice(0, height);
	}
}
