import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	type MouseRoutable,
	matchesKey,
	type OverlayFocusOwner,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
	sliceWithWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

export interface FullscreenChatLayoutOptions {
	/** Aggregate containing the welcome/transcript and transient upper HUD rows. */
	transcript: Component;
	/** Active editor receiving input and cursor/focus state. */
	editor: Component;
	/** Component rendered in the pinned editor region. Defaults to `editor`. */
	editorHost?: Component;
	/** Recognizes transient focus targets rendered by `editorHost`. */
	isEditorHostFocusTarget?: (component: Component) => boolean;
	/** Pinned rows rendered immediately above the editor. */
	beforeEditor?: readonly Component[];
	/** Pinned rows rendered immediately below the editor. */
	afterEditor?: readonly Component[];
	/** Injectable terminal row source. */
	getTerminalRows?: () => number;
	requestRender?: () => void;
	/** Number of transcript rows moved by one wheel report. */
	wheelScrollRows?: number;
	/** Maximum number of rendered transcript physical rows retained by the viewport. */
	maxTranscriptRows?: number;
	/** Receives plain text when an application-owned drag selection is released. */
	copyText?: (text: string) => void;
}

/**
 * Aggregate for transcript producers that mutate a persistent rendered-row
 * array in place. Unlike Container, this always rebuilds its concatenation so
 * streaming rows cannot be hidden behind child-array reference equality.
 */
export class FullscreenTranscriptAggregate implements Component {
	constructor(readonly children: readonly Component[]) {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) lines.push(...child.render(width));
		return lines;
	}
}

interface SelectionPoint {
	row: number;
	col: number;
}

interface PinnedHitRange {
	component: Component;
	start: number;
	end: number;
	componentLineOffset: number;
}

interface RenderedComponents {
	lines: string[];
	counts: number[];
}

/**
 * Fullscreen chat viewport. All children are borrowed: this component lays them
 * out, but never disposes or reparents them.
 */
export class FullscreenChatLayout implements Component, Focusable, OverlayFocusOwner {
	#transcript: Component;
	#editor: Component;
	#editorHost: Component;
	#editorHostFollowsEditor: boolean;
	#isEditorHostFocusTarget: (component: Component) => boolean;
	#beforeEditor: readonly Component[];
	#afterEditor: readonly Component[];
	#scrollView = new ScrollView([], { height: 0, scrollbar: "never" });
	#followBottom = true;
	#getTerminalRows: () => number;
	#requestRender: () => void;
	#wheelScrollRows: number;
	#maxTranscriptRows: number;
	#copyText: (text: string) => void;
	#focused = false;
	#useTerminalCursor = false;
	#transcriptLines: readonly string[] = [];
	#previousDroppedRows = 0;
	#transcriptHeight = 0;
	#pinnedHitRanges: readonly PinnedHitRange[] = [];
	#selectionAnchor: SelectionPoint | undefined;
	#selectionFocus: SelectionPoint | undefined;
	#selectionDragged = false;

	constructor(options: FullscreenChatLayoutOptions) {
		this.#transcript = options.transcript;
		this.#editor = options.editor;
		this.#editorHost = options.editorHost ?? options.editor;
		this.#editorHostFollowsEditor = options.editorHost === undefined;
		this.#isEditorHostFocusTarget = options.isEditorHostFocusTarget ?? (() => false);
		this.#beforeEditor = options.beforeEditor ?? [];
		this.#afterEditor = options.afterEditor ?? [];
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows || 40);
		this.#requestRender = options.requestRender ?? (() => {});
		this.#wheelScrollRows =
			options.wheelScrollRows !== undefined && Number.isFinite(options.wheelScrollRows)
				? Math.max(1, Math.trunc(options.wheelScrollRows))
				: 2;
		this.#maxTranscriptRows =
			options.maxTranscriptRows !== undefined && Number.isFinite(options.maxTranscriptRows)
				? Math.max(1, Math.trunc(options.maxTranscriptRows))
				: 10_000;
		this.#copyText = options.copyText ?? (() => {});
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		const editor = this.#editorFocusable();
		if (editor) editor.focused = focused;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		this.#editorFocusable()?.setUseTerminalCursor?.(useTerminalCursor);
	}

	setEditor(editor: Component): void {
		const previousEditor = this.#editorFocusable();
		if (previousEditor) previousEditor.focused = false;
		this.#editor = editor;
		if (this.#editorHostFollowsEditor) this.#editorHost = editor;
		const focusable = this.#editorFocusable();
		if (focusable) {
			focusable.focused = this.#focused;
			focusable.setUseTerminalCursor?.(this.#useTerminalCursor);
		}
		this.#requestRender();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this || (component !== this.#editor && this.#isEditorHostFocusTarget(component));
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * this.#wheelScrollRows);
					this.#syncFollowBottom();
					this.#requestRender();
					return true;
				}
				if (this.#selectionAnchor && this.#handleSelectionMouse(event)) return true;
				if (this.#routePinnedMouse(event)) return true;
				return this.#handleSelectionMouse(event);
			})
		) {
			return;
		}

		if (this.#handleScrollKey(data)) {
			this.#requestRender();
			return;
		}
		this.#editor.handleInput?.(data);
	}

	render(width: number): readonly string[] {
		const requestedRows = this.#getTerminalRows();
		const terminalRows = Number.isFinite(requestedRows) ? Math.max(0, Math.trunc(requestedRows)) : 0;
		const beforeEditor = this.#renderAll(this.#beforeEditor, width);
		const editor = [...this.#editorHost.render(width)];
		const afterEditor = this.#renderAll(this.#afterEditor, width);
		const pinned = [...beforeEditor.lines, ...editor, ...afterEditor.lines];
		const transcriptHeight = Math.max(0, terminalRows - pinned.length);

		const renderedTranscript = [...this.#transcript.render(width)];
		const droppedRows = Math.max(0, renderedTranscript.length - this.#maxTranscriptRows);
		const transcriptLines = renderedTranscript.slice(droppedRows);
		const previousOffset = this.#scrollView.getScrollOffset();
		const newlyDroppedRows = Math.max(0, droppedRows - this.#previousDroppedRows);
		this.#scrollView.setLines(transcriptLines);
		this.#scrollView.setHeight(transcriptHeight);
		if (!this.#followBottom && newlyDroppedRows > 0) {
			this.#scrollView.setScrollOffset(previousOffset - newlyDroppedRows);
		}
		if (this.#followBottom) this.#scrollView.scrollToBottom();
		this.#transcriptLines = transcriptLines;
		this.#previousDroppedRows = droppedRows;
		this.#transcriptHeight = transcriptHeight;
		this.#pinnedHitRanges = this.#buildPinnedHitRanges(terminalRows, beforeEditor, editor.length, afterEditor);

		if (terminalRows === 0) return [];
		if (pinned.length >= terminalRows) return pinned.slice(-terminalRows);
		const transcriptFrame = [...this.#scrollView.render(width)];
		this.#applySelectionHighlight(transcriptFrame);
		const frame = [...transcriptFrame, ...pinned];
		while (frame.length < terminalRows) frame.unshift("");
		return frame;
	}

	#renderAll(components: readonly Component[], width: number): RenderedComponents {
		const lines: string[] = [];
		const counts: number[] = [];
		for (const component of components) {
			const rendered = component.render(width);
			counts.push(rendered.length);
			lines.push(...rendered);
		}
		return { lines, counts };
	}

	#handleSelectionMouse(event: SgrMouseEvent): boolean {
		const point = this.#transcriptPoint(event);
		if (event.leftClick) {
			if (!point) return false;
			this.#selectionAnchor = point;
			this.#selectionFocus = point;
			this.#selectionDragged = false;
			this.#requestRender();
			return true;
		}
		if (event.motion && event.buttonId === 0 && this.#selectionAnchor) {
			if (this.#transcriptHeight > 0 && event.row <= 0) this.#scrollView.scroll(-1);
			else if (this.#transcriptHeight > 0 && event.row >= this.#transcriptHeight - 1) this.#scrollView.scroll(1);
			this.#syncFollowBottom();
			const movedPoint = this.#transcriptPoint(event);
			if (movedPoint) {
				this.#selectionFocus = movedPoint;
				this.#selectionDragged ||= this.#comparePoints(this.#selectionAnchor, movedPoint) !== 0;
			}
			this.#requestRender();
			return true;
		}
		if (event.release && event.buttonId === 0 && this.#selectionAnchor) {
			if (point) {
				this.#selectionFocus = point;
				this.#selectionDragged ||= this.#comparePoints(this.#selectionAnchor, point) !== 0;
			}
			if (this.#selectionDragged && this.#selectionFocus) {
				const text = this.#selectedText(this.#selectionAnchor, this.#selectionFocus);
				if (text.length > 0) this.#copyText(text);
			}
			this.#selectionAnchor = undefined;
			this.#selectionFocus = undefined;
			this.#selectionDragged = false;
			this.#requestRender();
			return true;
		}
		return false;
	}

	#transcriptPoint(event: SgrMouseEvent): SelectionPoint | undefined {
		if (event.row < 0 || event.row >= this.#transcriptHeight) return undefined;
		const row = this.#scrollView.getScrollOffset() + event.row;
		if (row < 0 || row >= this.#transcriptLines.length) return undefined;
		return { row, col: Math.max(0, event.col) };
	}

	#selectedText(a: SelectionPoint, b: SelectionPoint): string {
		const [start, end] = this.#comparePoints(a, b) <= 0 ? [a, b] : [b, a];
		const lines: string[] = [];
		for (let row = start.row; row <= end.row; row++) {
			const line = this.#transcriptLines[row] ?? "";
			const from = row === start.row ? start.col : 0;
			const to = row === end.row ? end.col + 1 : visibleWidth(line);
			lines.push(stripVTControlCharacters(sliceWithWidth(line, from, Math.max(0, to - from)).text));
		}
		return lines.join("\n");
	}

	#applySelectionHighlight(lines: string[]): void {
		if (!this.#selectionAnchor || !this.#selectionFocus) return;
		const [start, end] =
			this.#comparePoints(this.#selectionAnchor, this.#selectionFocus) <= 0
				? [this.#selectionAnchor, this.#selectionFocus]
				: [this.#selectionFocus, this.#selectionAnchor];
		const offset = this.#scrollView.getScrollOffset();
		for (let screenRow = 0; screenRow < lines.length; screenRow++) {
			const row = offset + screenRow;
			if (row < start.row || row > end.row) continue;
			const line = lines[screenRow] ?? "";
			const from = row === start.row ? start.col : 0;
			const to = row === end.row ? end.col + 1 : visibleWidth(line);
			const before = sliceWithWidth(line, 0, from).text;
			const selected = sliceWithWidth(line, from, Math.max(0, to - from)).text;
			const after = sliceWithWidth(line, to, Math.max(0, visibleWidth(line) - to)).text;
			lines[screenRow] = `${before}\x1b[7m${selected}\x1b[27m${after}`;
		}
	}

	#routePinnedMouse(event: SgrMouseEvent): boolean {
		const hit = this.#pinnedHitRanges.find(range => event.row >= range.start && event.row < range.end);
		if (!hit) return false;
		const target = hit.component as Partial<MouseRoutable>;
		if (typeof target.routeMouse !== "function") return false;
		target.routeMouse(event, hit.componentLineOffset + event.row - hit.start, event.col);
		return true;
	}

	#buildPinnedHitRanges(
		terminalRows: number,
		before: RenderedComponents,
		editorRows: number,
		after: RenderedComponents,
	): readonly PinnedHitRange[] {
		const components = [...this.#beforeEditor, this.#editorHost, ...this.#afterEditor];
		const lengths = [...before.counts, editorRows, ...after.counts];
		const pinnedRows = before.lines.length + editorRows + after.lines.length;
		const clipped = Math.max(0, pinnedRows - terminalRows);
		const screenBase = Math.max(0, terminalRows - pinnedRows);
		const ranges: PinnedHitRange[] = [];
		let aggregateStart = 0;
		for (let index = 0; index < components.length; index++) {
			const length = lengths[index] ?? 0;
			const visibleStart = Math.max(aggregateStart, clipped);
			const visibleEnd = Math.min(aggregateStart + length, pinnedRows);
			if (visibleStart < visibleEnd) {
				ranges.push({
					component: components[index]!,
					start: screenBase + visibleStart - clipped,
					end: screenBase + visibleEnd - clipped,
					componentLineOffset: visibleStart - aggregateStart,
				});
			}
			aggregateStart += length;
		}
		return ranges;
	}

	#comparePoints(a: SelectionPoint, b: SelectionPoint): number {
		return a.row === b.row ? a.col - b.col : a.row - b.row;
	}

	#handleScrollKey(data: string): boolean {
		if (matchesKey(data, "shift+up")) {
			this.#scrollView.scroll(-5);
		} else if (matchesKey(data, "shift+down")) {
			this.#scrollView.scroll(5);
		} else if (matchesKey(data, "shift+pageUp")) {
			this.#scrollView.page(-1);
		} else if (matchesKey(data, "shift+pageDown")) {
			this.#scrollView.page(1);
		} else if (matchesKey(data, "ctrl+home")) {
			this.#scrollView.scrollToTop();
		} else if (matchesKey(data, "ctrl+end")) {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollowBottom();
		return true;
	}

	#syncFollowBottom(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#editorFocusable(): (Component & Focusable) | undefined {
		return "focused" in this.#editor ? (this.#editor as Component & Focusable) : undefined;
	}
}
