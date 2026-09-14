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
import { renderClickTargets, type RenderedClickTargets, routeViewportClick, type ViewportClickSpan } from "../composer";
import type { TranscriptBlockSource } from "./transcript-container";

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
	/** Resident row budget; a single complete block may exceed it. */
	maxTranscriptRows?: number;
	/** Receives plain text when an application-owned drag selection is released. */
	copyText?: (text: string) => void;
	/** Uses the same registry and toggle resolution as inline click capture. */
	onClickCandidates?: (candidates: string[]) => void;
}

interface FullscreenTranscriptBlockRender {
	identity: Component;
	lines: readonly string[];
	/** Adjacent non-empty blocks with the same group receive one blank separator. */
	separatorGroup?: Component;
}

interface LocatedFullscreenTranscriptBlock {
	identity: Component;
	source?: TranscriptBlockSource;
	localOrdinal: number;
}

function isTranscriptBlockSource(component: Component): component is TranscriptBlockSource {
	const source = component as Partial<TranscriptBlockSource>;
	return (
		typeof source.getTranscriptBlockCount === "function" &&
		typeof source.getTranscriptBlockIdentity === "function" &&
		typeof source.renderTranscriptBlock === "function"
	);
}

/**
 * Borrowed composition of upstream transcript sources and ordinary chrome.
 * Resolves identities from their owner on demand; never registers blocks or
 * changes their lifecycle. Both this composition and a bare transcript use the
 * same complete-block source contract in the fullscreen viewport.
 */
export class FullscreenTranscriptAggregate implements TranscriptBlockSource {
	constructor(readonly children: readonly Component[]) {}

	getTranscriptBlockCount(): number {
		let count = 0;
		for (const child of this.children) {
			count += isTranscriptBlockSource(child) ? child.getTranscriptBlockCount() : 1;
		}
		return count;
	}

	getTranscriptBlockIdentity(ordinal: number): Component | undefined {
		return this.#locateBlock(ordinal)?.identity;
	}

	renderTranscriptBlock(ordinal: number, width: number): readonly string[] {
		const located = this.#locateBlock(ordinal);
		if (!located) return [];
		return located.source
			? located.source.renderTranscriptBlock(located.localOrdinal, width)
			: located.identity.render(width);
	}

	getTranscriptBlockSeparatorGroup(ordinal: number): Component | undefined {
		const located = this.#locateBlock(ordinal);
		return located?.source?.getTranscriptBlockSeparatorGroup
			? located.source.getTranscriptBlockSeparatorGroup(located.localOrdinal)
			: located?.source;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) lines.push(...child.render(width));
		return lines;
	}

	#locateBlock(ordinal: number): LocatedFullscreenTranscriptBlock | undefined {
		if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
		let remaining = ordinal;
		for (const child of this.children) {
			if (isTranscriptBlockSource(child)) {
				const count = child.getTranscriptBlockCount();
				if (remaining < count) {
					const identity = child.getTranscriptBlockIdentity(remaining);
					return identity ? { identity, source: child, localOrdinal: remaining } : undefined;
				}
				remaining -= count;
				continue;
			}
			if (remaining === 0) return { identity: child, localOrdinal: 0 };
			remaining--;
		}
		return undefined;
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


interface ResidentTranscriptBlock extends FullscreenTranscriptBlockRender {
	ordinal: number;
	/** First resident row, including this block's separator when present. */
	startRow: number;
	separatorRows: 0 | 1;
	/** Separator plus complete contribution; zero for an empty contribution. */
	rowCount: number;
}

interface ResidentRowAnchor {
	identity: Component;
	rowInContribution: number;
	separator: boolean;
}

type PendingPagedJump = "start" | "end";

/**
 * Fullscreen chat viewport. All children are borrowed: this component lays them
 * out, but never disposes or reparents them.
 */
export class FullscreenChatLayout implements Component, Focusable, OverlayFocusOwner {
	#transcriptPager: TranscriptBlockSource;
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
	#transcriptHeight = 0;
	#residentBlocks: ResidentTranscriptBlock[] = [];
	#residentStartOrdinal = 0;
	#residentEndOrdinal = 0;
	#residentWidth = -1;
	#residentEvictionEdge: "head" | "tail" = "head";
	#pagedInitialized = false;
	#pendingPagedJump: PendingPagedJump | undefined;
	#pinnedHitRanges: readonly PinnedHitRange[] = [];
	#pinnedClickSpans: readonly ViewportClickSpan[] = [];
	#onClickCandidates: ((candidates: string[]) => void) | undefined;
	#selectionAnchor: SelectionPoint | undefined;
	#selectionFocus: SelectionPoint | undefined;
	#selectionDragged = false;

	constructor(options: FullscreenChatLayoutOptions) {
		this.#transcriptPager = isTranscriptBlockSource(options.transcript)
			? options.transcript
			: new FullscreenTranscriptAggregate([options.transcript]);
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
		this.#onClickCandidates = options.onClickCandidates;
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
					this.#scrollTranscript(event.wheel * this.#wheelScrollRows);
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
		const beforeEditor = renderClickTargets(this.#beforeEditor, width);
		const editor = [...this.#editorHost.render(width)];
		const afterEditor = renderClickTargets(this.#afterEditor, width);
		const pinned = [...beforeEditor.lines, ...editor, ...afterEditor.lines];
		const transcriptHeight = Math.max(0, terminalRows - pinned.length);

		this.#scrollView.setHeight(transcriptHeight);
		this.#transcriptHeight = transcriptHeight;
		this.#renderPagedTranscript(width);
		this.#pinnedHitRanges = this.#buildPinnedHitRanges(terminalRows, beforeEditor, editor.length, afterEditor);

		if (terminalRows === 0) return [];
		if (pinned.length >= terminalRows) return pinned.slice(-terminalRows);
		const transcriptFrame = [...this.#scrollView.render(width)];
		this.#applySelectionHighlight(transcriptFrame);
		const frame = [...transcriptFrame, ...pinned];
		while (frame.length < terminalRows) frame.unshift("");
		return frame;
	}

	#renderPagedTranscript(width: number): void {
		const pager = this.#transcriptPager;
		const count = pager.getTranscriptBlockCount();
		let rendered = false;

		if (this.#pendingPagedJump === "start") {
			this.#replaceResidentFromStart(pager, count, width);
			this.#followBottom = false;
			this.#scrollView.scrollToTop();
			this.#pendingPagedJump = undefined;
			rendered = true;
		} else if (this.#pendingPagedJump === "end") {
			this.#replaceResidentFromTail(pager, count, width);
			this.#followBottom = true;
			this.#pendingPagedJump = undefined;
			rendered = true;
		} else if (!this.#pagedInitialized) {
			this.#replaceResidentFromTail(pager, count, width);
			rendered = true;
		} else if (
			this.#followBottom &&
			(this.#residentEndOrdinal !== count || !this.#residentIdentitiesMatch(pager, count))
		) {
			this.#replaceResidentFromTail(pager, count, width);
			rendered = true;
		} else if (!this.#residentIdentitiesMatch(pager, count)) {
			this.#reconcileResidentIdentities(pager, count, width);
			rendered = true;
		}

		if (!rendered) {
			this.#refreshResidentBlocks(pager, width);
		}
		this.#residentWidth = width;
		this.#pagedInitialized = true;
		this.#trimResidentBlocks(this.#residentEvictionEdge);
		if (this.#followBottom) this.#scrollView.scrollToBottom();
	}

	#replaceResidentFromTail(pager: TranscriptBlockSource, count: number, width: number): void {
		this.#residentEvictionEdge = "head";
		const targetRows = this.#pageTargetRows();
		const blockLimit = this.#pageTargetBlocks();
		const reversed: ResidentTranscriptBlock[] = [];
		let rows = 0;
		let ordinal = count;
		let lowerGroup: Component | undefined;
		while (ordinal > 0 && rows < targetRows && reversed.length < blockLimit) {
			ordinal--;
			const block = this.#renderResidentBlock(pager, ordinal, width);
			if (!block) continue;
			if (block.lines.length > 0) {
				rows +=
					block.lines.length + (block.separatorGroup !== undefined && block.separatorGroup === lowerGroup ? 1 : 0);
				lowerGroup = block.separatorGroup;
			}
			reversed.push(block);
		}
		reversed.reverse();
		this.#commitResidentBlocks(reversed, ordinal, count, false);
	}

	#replaceResidentFromStart(pager: TranscriptBlockSource, count: number, width: number): void {
		this.#residentEvictionEdge = "tail";
		const targetRows = this.#pageTargetRows();
		const blockLimit = this.#pageTargetBlocks();
		const blocks: ResidentTranscriptBlock[] = [];
		let rows = 0;
		let ordinal = 0;
		let previousGroup: Component | undefined;
		while (ordinal < count && rows < targetRows && blocks.length < blockLimit) {
			const block = this.#renderResidentBlock(pager, ordinal, width);
			ordinal++;
			if (!block) continue;
			if (block.lines.length > 0) {
				rows +=
					block.lines.length +
					(block.separatorGroup !== undefined && block.separatorGroup === previousGroup ? 1 : 0);
				previousGroup = block.separatorGroup;
			}
			blocks.push(block);
		}
		this.#commitResidentBlocks(blocks, 0, ordinal, false);
	}

	#refreshResidentBlocks(pager: TranscriptBlockSource, width: number): void {
		const blocks: ResidentTranscriptBlock[] = [];
		for (let ordinal = this.#residentStartOrdinal; ordinal < this.#residentEndOrdinal; ordinal++) {
			const block = this.#renderResidentBlock(pager, ordinal, width);
			if (block) blocks.push(block);
		}
		this.#commitResidentBlocks(blocks, this.#residentStartOrdinal, this.#residentEndOrdinal, !this.#followBottom);
	}

	#reconcileResidentIdentities(pager: TranscriptBlockSource, count: number, width: number): void {
		const visibleAnchor = this.#captureResidentRowAnchor(this.#scrollView.getScrollOffset());
		let anchorOrdinal: number | undefined;
		if (visibleAnchor) {
			for (let ordinal = 0; ordinal < count; ordinal++) {
				if (pager.getTranscriptBlockIdentity(ordinal) === visibleAnchor.identity) {
					anchorOrdinal = ordinal;
					break;
				}
			}
		}
		const oldBlockCount = Math.max(1, this.#residentEndOrdinal - this.#residentStartOrdinal);
		const oldAnchorIndex = visibleAnchor
			? Math.max(
					0,
					this.#residentBlocks.findIndex(block => block.identity === visibleAnchor.identity),
				)
			: 0;
		let start =
			anchorOrdinal === undefined
				? Math.min(this.#residentStartOrdinal, Math.max(0, count - oldBlockCount))
				: Math.max(0, anchorOrdinal - oldAnchorIndex);
		const end = Math.min(count, start + oldBlockCount);
		start = Math.max(0, end - oldBlockCount);
		const blocks: ResidentTranscriptBlock[] = [];
		for (let ordinal = start; ordinal < end; ordinal++) {
			const block = this.#renderResidentBlock(pager, ordinal, width);
			if (block) blocks.push(block);
		}
		this.#commitResidentBlocks(blocks, start, end, true);
	}

	#residentIdentitiesMatch(pager: TranscriptBlockSource, count: number): boolean {
		if (this.#residentStartOrdinal < 0 || this.#residentEndOrdinal > count) return false;
		if (this.#residentBlocks.length !== this.#residentEndOrdinal - this.#residentStartOrdinal) return false;
		for (const block of this.#residentBlocks) {
			if (pager.getTranscriptBlockIdentity(block.ordinal) !== block.identity) return false;
		}
		return true;
	}

	#renderResidentBlock(
		pager: TranscriptBlockSource,
		ordinal: number,
		width: number,
	): ResidentTranscriptBlock | undefined {
		const identity = pager.getTranscriptBlockIdentity(ordinal);
		if (!identity) return undefined;
		return {
			identity,
			lines: pager.renderTranscriptBlock(ordinal, width),
			separatorGroup: pager.getTranscriptBlockSeparatorGroup
				? pager.getTranscriptBlockSeparatorGroup(ordinal)
				: pager,
			ordinal,
			startRow: 0,
			separatorRows: 0,
			rowCount: 0,
		};
	}

	#commitResidentBlocks(
		blocks: ResidentTranscriptBlock[],
		startOrdinal: number,
		endOrdinal: number,
		preserveViewport: boolean,
	): void {
		const topAnchor = preserveViewport
			? this.#captureResidentRowAnchor(this.#scrollView.getScrollOffset())
			: undefined;
		const selectionAnchor = this.#selectionAnchor
			? this.#captureResidentRowAnchor(this.#selectionAnchor.row)
			: undefined;
		const selectionFocus = this.#selectionFocus
			? this.#captureResidentRowAnchor(this.#selectionFocus.row)
			: undefined;
		const lines: string[] = [];
		let previousGroup: Component | undefined;
		for (const block of blocks) {
			block.startRow = lines.length;
			block.separatorRows = 0;
			if (block.lines.length === 0) {
				block.rowCount = 0;
				continue;
			}
			if (block.separatorGroup !== undefined && block.separatorGroup === previousGroup) {
				lines.push("");
				block.separatorRows = 1;
			}
			for (const line of block.lines) lines.push(line);
			block.rowCount = lines.length - block.startRow;
			previousGroup = block.separatorGroup;
		}
		this.#residentBlocks = blocks;
		this.#residentStartOrdinal = startOrdinal;
		this.#residentEndOrdinal = endOrdinal;
		this.#transcriptLines = lines;
		this.#scrollView.setLines(lines);
		if (topAnchor) {
			const restored = this.#restoreResidentRowAnchor(topAnchor);
			if (restored !== undefined) this.#scrollView.setScrollOffset(restored);
		}
		if (this.#selectionAnchor && selectionAnchor) {
			const restored = this.#restoreResidentRowAnchor(selectionAnchor);
			if (restored === undefined) this.#clearSelection();
			else this.#selectionAnchor = { ...this.#selectionAnchor, row: restored };
		}
		if (this.#selectionFocus && selectionFocus) {
			const restored = this.#restoreResidentRowAnchor(selectionFocus);
			if (restored === undefined) this.#clearSelection();
			else this.#selectionFocus = { ...this.#selectionFocus, row: restored };
		}
	}

	#captureResidentRowAnchor(row: number): ResidentRowAnchor | undefined {
		for (const block of this.#residentBlocks) {
			if (block.rowCount > 0 && row >= block.startRow && row < block.startRow + block.rowCount) {
				return {
					identity: block.identity,
					rowInContribution: Math.max(0, row - block.startRow - block.separatorRows),
					separator: row < block.startRow + block.separatorRows,
				};
			}
		}
		return undefined;
	}

	#restoreResidentRowAnchor(anchor: ResidentRowAnchor): number | undefined {
		const block = this.#residentBlocks.find(candidate => candidate.identity === anchor.identity);
		if (!block || block.rowCount === 0) return undefined;
		if (anchor.separator) return block.startRow;
		return (
			block.startRow + block.separatorRows + Math.min(anchor.rowInContribution, Math.max(0, block.lines.length - 1))
		);
	}

	#clearSelection(): void {
		this.#selectionAnchor = undefined;
		this.#selectionFocus = undefined;
		this.#selectionDragged = false;
	}

	#loadResidentPage(direction: -1 | 1): void {
		const pager = this.#transcriptPager;
		if (!this.#pagedInitialized || this.#residentWidth < 0) return;
		const count = pager.getTranscriptBlockCount();
		const targetRows = this.#pageTargetRows();
		const blockLimit = this.#pageTargetBlocks();
		if (direction < 0) {
			this.#residentEvictionEdge = "tail";
			if (this.#residentStartOrdinal <= 0) return;
			const reversed: ResidentTranscriptBlock[] = [];
			let rows = 0;
			let ordinal = this.#residentStartOrdinal;
			let lowerGroup = this.#residentBlocks.find(block => block.lines.length > 0)?.separatorGroup;
			while (ordinal > 0 && rows < targetRows && reversed.length < blockLimit) {
				ordinal--;
				const block = this.#renderResidentBlock(pager, ordinal, this.#residentWidth);
				if (!block) continue;
				if (block.lines.length > 0) {
					rows +=
						block.lines.length +
						(block.separatorGroup !== undefined && block.separatorGroup === lowerGroup ? 1 : 0);
					lowerGroup = block.separatorGroup;
				}
				reversed.push(block);
			}
			reversed.reverse();
			this.#commitResidentBlocks([...reversed, ...this.#residentBlocks], ordinal, this.#residentEndOrdinal, true);
			this.#trimResidentBlocks("tail");
			return;
		}
		if (this.#residentEndOrdinal >= count) return;
		this.#residentEvictionEdge = "head";
		const appended: ResidentTranscriptBlock[] = [];
		let rows = 0;
		let ordinal = this.#residentEndOrdinal;
		let previousGroup: Component | undefined;
		for (let i = this.#residentBlocks.length - 1; i >= 0; i--) {
			const candidate = this.#residentBlocks[i]!;
			if (candidate.lines.length > 0) {
				previousGroup = candidate.separatorGroup;
				break;
			}
		}
		while (ordinal < count && rows < targetRows && appended.length < blockLimit) {
			const block = this.#renderResidentBlock(pager, ordinal, this.#residentWidth);
			ordinal++;
			if (!block) continue;
			if (block.lines.length > 0) {
				rows +=
					block.lines.length +
					(block.separatorGroup !== undefined && block.separatorGroup === previousGroup ? 1 : 0);
				previousGroup = block.separatorGroup;
			}
			appended.push(block);
		}
		this.#commitResidentBlocks([...this.#residentBlocks, ...appended], this.#residentStartOrdinal, ordinal, true);
		this.#trimResidentBlocks("head");
	}

	#trimResidentBlocks(preferredEdge: "head" | "tail"): void {
		const rowLimit = Math.min(this.#maxTranscriptRows, Math.max(64, this.#transcriptHeight * 8));
		const blockLimit = Math.max(128, this.#transcriptHeight * 16);
		while (
			(this.#transcriptLines.length > rowLimit || this.#residentBlocks.length > blockLimit) &&
			this.#residentBlocks.length > 1
		) {
			const offset = this.#scrollView.getScrollOffset();
			const visibleEnd = offset + this.#transcriptHeight;
			const head = this.#residentBlocks[0]!;
			const tail = this.#residentBlocks.at(-1)!;
			const canDropHead = head.rowCount === 0 || head.startRow + head.rowCount <= offset;
			const canDropTail = tail.rowCount === 0 || tail.startRow >= visibleEnd;
			if (preferredEdge === "head" && canDropHead) {
				this.#commitResidentBlocks(
					this.#residentBlocks.slice(1),
					this.#residentStartOrdinal + 1,
					this.#residentEndOrdinal,
					true,
				);
				continue;
			}
			if (preferredEdge === "tail" && canDropTail) {
				this.#commitResidentBlocks(
					this.#residentBlocks.slice(0, -1),
					this.#residentStartOrdinal,
					this.#residentEndOrdinal - 1,
					true,
				);
				continue;
			}
			break;
		}
	}

	#pageTargetRows(): number {
		return Math.min(this.#maxTranscriptRows, Math.max(16, this.#transcriptHeight * 2));
	}

	#pageTargetBlocks(): number {
		return Math.max(32, this.#transcriptHeight * 4);
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
			if (this.#transcriptHeight > 0 && event.row <= 0) this.#scrollTranscript(-1);
			else if (this.#transcriptHeight > 0 && event.row >= this.#transcriptHeight - 1) this.#scrollTranscript(1);
			this.#syncFollowBottom();
			if (!this.#selectionAnchor) {
				this.#requestRender();
				return true;
			}
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
			else if (point && this.#onClickCandidates) {
				const block = this.#residentBlocks.find(block => point.row >= block.startRow + block.separatorRows && point.row < block.startRow + block.rowCount);
				const target = block?.identity as Partial<{ getClickFocusAgentIds(): string[] }> | undefined;
				const candidates = target?.getClickFocusAgentIds?.();
				if (candidates?.length) this.#onClickCandidates(candidates);
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
		if (event.leftClick && this.#onClickCandidates) {
			const candidates = routeViewportClick(this.#pinnedClickSpans, event.row);
			if (candidates.length > 0) {
				this.#onClickCandidates(candidates);
				return true;
			}
		}
		const hit = this.#pinnedHitRanges.find(range => event.row >= range.start && event.row < range.end);
		if (!hit) return false;
		const target = hit.component as Partial<MouseRoutable>;
		if (typeof target.routeMouse !== "function") return false;
		target.routeMouse(event, hit.componentLineOffset + event.row - hit.start, event.col);
		return true;
	}

	#buildPinnedHitRanges(
		terminalRows: number,
		before: RenderedClickTargets,
		editorRows: number,
		after: RenderedClickTargets,
	): readonly PinnedHitRange[] {
		const components = [...this.#beforeEditor, this.#editorHost, ...this.#afterEditor];
		const lengths = [...before.counts, editorRows, ...after.counts];
		const pinnedRows = before.lines.length + editorRows + after.lines.length;
		const clipped = Math.max(0, pinnedRows - terminalRows);
		const screenBase = Math.max(0, terminalRows - pinnedRows);
		this.#pinnedClickSpans = [
			...before.spans,
			...after.spans.map(span => ({ ...span, start: span.start + before.lines.length + editorRows, end: span.end + before.lines.length + editorRows })),
		].filter(span => span.end > clipped).map(span => {
			const visibleStart = Math.max(span.start, clipped);
			return {
				start: screenBase + visibleStart - clipped,
				end: screenBase + span.end - clipped,
				candidates: local => span.candidates(local + visibleStart - span.start),
			};
		});
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
			this.#scrollTranscript(-5);
		} else if (matchesKey(data, "shift+down")) {
			this.#scrollTranscript(5);
		} else if (matchesKey(data, "shift+pageUp")) {
			this.#scrollTranscript(-Math.max(1, this.#transcriptHeight - 1));
		} else if (matchesKey(data, "shift+pageDown")) {
			this.#scrollTranscript(Math.max(1, this.#transcriptHeight - 1));
		} else if (matchesKey(data, "ctrl+home")) {
			this.#pendingPagedJump = "start";
			this.#followBottom = false;
			return true;
		} else if (matchesKey(data, "ctrl+end")) {
			this.#pendingPagedJump = "end";
			this.#followBottom = true;
			return true;
		} else {
			return false;
		}
		this.#syncFollowBottom();
		return true;
	}

	#scrollTranscript(delta: number): void {
		if (this.#pagedInitialized && delta !== 0) {
			const threshold = Math.max(this.#transcriptHeight, Math.abs(delta));
			if (delta < 0 && this.#residentStartOrdinal > 0 && this.#scrollView.getScrollOffset() <= threshold) {
				this.#loadResidentPage(-1);
			} else if (
				delta > 0 &&
				this.#residentEndOrdinal < this.#transcriptPager.getTranscriptBlockCount() &&
				this.#scrollView.getMaxScrollOffset() - this.#scrollView.getScrollOffset() <= threshold
			) {
				this.#loadResidentPage(1);
			}
		}
		this.#scrollView.scroll(delta);
	}

	#syncFollowBottom(): void {
		this.#followBottom =
			this.#residentEndOrdinal >= this.#transcriptPager.getTranscriptBlockCount() &&
			this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#editorFocusable(): (Component & Focusable) | undefined {
		return "focused" in this.#editor ? (this.#editor as Component & Focusable) : undefined;
	}
}
