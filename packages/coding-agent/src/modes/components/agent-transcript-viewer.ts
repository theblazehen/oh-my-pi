/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * Local transcripts keep a bounded, line-aligned byte window. The initial open
 * reads only the tail; app-owned scrolling pages older/newer bytes in from disk
 * and evicts the opposite edge. Unchanged file identity plus stable sentinels
 * still permits exactly-once tail appends. Rewrites, truncation, rotation, or
 * sentinel drift discard the window and reopen the current tail. Collab guests
 * retain their independent append-only host protocol.
 */
import * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Editor, matchesKey, routeSgrMouseInput, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { sanitizeErrorLine } from "./error-block";
import { formatContextUsage } from "./status-line/context-thresholds";

export interface AgentTranscriptViewerDeps {
	agentId: string;
	/** Persisted entry to reveal on first paint when opened from an activity row. */
	initialEntryId?: string;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress/cost snapshot source for the stats line. */
	observers?: SessionObserverRegistry;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;

const SENTINEL_BYTES = 4096;
/** One disk page. A single oversized JSONL record may exceed this soft target. */
const LOCAL_PAGE_BYTES = 512 * 1024;
/** Resident complete-line payload. The visible pair of pages may exceed this when one record itself is larger. */
const LOCAL_RESIDENT_BYTES = 4 * 1024 * 1024;
/** Start fetching before the viewport hits the hard edge, hiding most disk latency. */
const LOCAL_PAGE_PREFETCH_ROWS = 6;

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface LocalTranscriptPage {
	/** Inclusive byte offset, always at the start of a JSONL line. */
	start: number;
	/** Exclusive byte offset, always immediately after a newline. */
	end: number;
	bytes: Buffer;
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	/** Number of file bytes consumed by the append detector. */
	size: number;
	mtimeMs: number;
	/** End of the last complete JSONL line observed at the file tail. */
	completeEnd: number;
	/** Incomplete live-tail line. It is never counted against/evicted by the page budget. */
	pending: Buffer;
	/** Contiguous complete-line pages currently materialized for display. */
	pages: LocalTranscriptPage[];
	sentinels: LocalTranscriptSentinel[];
}

interface LocalTranscriptTail {
	page: LocalTranscriptPage | undefined;
	completeEnd: number;
	pending: Buffer;
}

function readFileRangeSync(file: string, offset: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		let total = 0;
		while (total < length) {
			const bytesRead = fs.readSync(fd, buffer, total, length - total, offset + total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		return total === length ? buffer : buffer.subarray(0, total);
	} finally {
		fs.closeSync(fd);
	}
}

async function readFileRange(file: string, offset: number, length: number): Promise<Buffer> {
	if (length <= 0) return Buffer.alloc(0);
	const handle = await fs.promises.open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		let total = 0;
		while (total < length) {
			const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		return total === length ? buffer : buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
}

function firstAndLastNewline(bytes: Buffer): { first: number; last: number } {
	return { first: bytes.indexOf(0x0a), last: bytes.lastIndexOf(0x0a) };
}

/**
 * Read the current tail without ever handing a headless JSONL fragment to the
 * parser. We normally hold one page; if the first complete record is larger
 * than a page, extend backward until its preceding newline is found. The same
 * exception is necessary for an incomplete live record, whose bytes must stay
 * available until a future append supplies its newline.
 */
function readLocalTail(file: string, size: number): LocalTranscriptTail {
	if (size <= 0) return { page: undefined, completeEnd: 0, pending: Buffer.alloc(0) };
	let start = Math.max(0, size - LOCAL_PAGE_BYTES);
	let bytes = readFileRangeSync(file, start, size - start);
	let aligned = start === 0 || readFileRangeSync(file, start - 1, 1)[0] === 0x0a;

	// At a non-aligned target, the first newline only terminates the headless
	// record. Extend until either that full oversized record is available or a
	// second newline leaves at least one complete aligned tail record to render.
	while (start > 0 && !aligned) {
		const { first, last } = firstAndLastNewline(bytes);
		if (first >= 0 && last > first) break;
		const previousStart = Math.max(0, start - LOCAL_PAGE_BYTES);
		bytes = Buffer.concat([readFileRangeSync(file, previousStart, start - previousStart), bytes]);
		start = previousStart;
		aligned = start === 0 || readFileRangeSync(file, start - 1, 1)[0] === 0x0a;
	}

	if (!aligned) {
		const firstNewline = bytes.indexOf(0x0a);
		if (firstNewline < 0) return { page: undefined, completeEnd: size, pending: Buffer.alloc(0) };
		start += firstNewline + 1;
		bytes = bytes.subarray(firstNewline + 1);
	}

	const lastNewline = bytes.lastIndexOf(0x0a);
	if (lastNewline < 0) {
		return { page: undefined, completeEnd: start, pending: Buffer.from(bytes) };
	}
	const completeEnd = start + lastNewline + 1;
	const pageBytes = Buffer.from(bytes.subarray(0, lastNewline + 1));
	return {
		page: pageBytes.byteLength > 0 ? { start, end: completeEnd, bytes: pageBytes } : undefined,
		completeEnd,
		pending: Buffer.from(bytes.subarray(lastNewline + 1)),
	};
}

/** Read the complete-line page immediately preceding an aligned byte offset. */
async function readPreviousLocalPage(file: string, end: number): Promise<LocalTranscriptPage | undefined> {
	if (end <= 0) return undefined;
	let start = Math.max(0, end - LOCAL_PAGE_BYTES);
	let bytes = await readFileRange(file, start, end - start);
	let aligned = start === 0 || (await readFileRange(file, start - 1, 1))[0] === 0x0a;
	while (start > 0 && !aligned) {
		const { first, last } = firstAndLastNewline(bytes);
		if (first >= 0 && last > first) break;
		const previousStart = Math.max(0, start - LOCAL_PAGE_BYTES);
		bytes = Buffer.concat([await readFileRange(file, previousStart, start - previousStart), bytes]);
		start = previousStart;
		aligned = start === 0 || (await readFileRange(file, start - 1, 1))[0] === 0x0a;
	}
	if (!aligned) {
		const firstNewline = bytes.indexOf(0x0a);
		if (firstNewline < 0) return undefined;
		start += firstNewline + 1;
		bytes = bytes.subarray(firstNewline + 1);
	}
	if (bytes.byteLength === 0) return undefined;
	if (bytes.byteLength !== end - start) return undefined;
	return { start, end, bytes: Buffer.from(bytes) };
}

/** Read the complete-line page immediately following an aligned byte offset. */
async function readNextLocalPage(
	file: string,
	start: number,
	completeEnd: number,
): Promise<LocalTranscriptPage | undefined> {
	if (start >= completeEnd) return undefined;
	let end = Math.min(completeEnd, start + LOCAL_PAGE_BYTES);
	let bytes = await readFileRange(file, start, end - start);
	while (end < completeEnd && bytes.lastIndexOf(0x0a) < 0) {
		const nextEnd = Math.min(completeEnd, end + LOCAL_PAGE_BYTES);
		bytes = Buffer.concat([bytes, await readFileRange(file, end, nextEnd - end)]);
		end = nextEnd;
	}
	if (end < completeEnd) {
		const lastNewline = bytes.lastIndexOf(0x0a);
		if (lastNewline < 0) return undefined;
		end = start + lastNewline + 1;
		bytes = bytes.subarray(0, lastNewline + 1);
	}
	if (bytes.byteLength === 0) return undefined;
	if (bytes.byteLength !== end - start) return undefined;
	return { start, end, bytes: Buffer.from(bytes) };
}

/** Split complete JSONL bytes into independently evictable, line-aligned pages. */
function splitCompleteLocalPages(start: number, bytes: Buffer): LocalTranscriptPage[] {
	const pages: LocalTranscriptPage[] = [];
	let pageStart = 0;
	while (pageStart < bytes.byteLength) {
		const targetEnd = Math.min(bytes.byteLength, pageStart + LOCAL_PAGE_BYTES);
		let pageEnd = targetEnd;
		if (targetEnd < bytes.byteLength) {
			const priorNewline = bytes.lastIndexOf(0x0a, targetEnd - 1);
			if (priorNewline >= pageStart) {
				pageEnd = priorNewline + 1;
			} else {
				const nextNewline = bytes.indexOf(0x0a, targetEnd);
				pageEnd = nextNewline >= 0 ? nextNewline + 1 : bytes.byteLength;
			}
		}
		const pageBytes = Buffer.from(bytes.subarray(pageStart, pageEnd));
		pages.push({ start: start + pageStart, end: start + pageEnd, bytes: pageBytes });
		pageStart = pageEnd;
	}
	return pages;
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

export class AgentTranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#followBottom = true;
	#editor: Editor | undefined;
	#notice: string | undefined;
	#expanded = false;

	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";
	#localPageToken = 0;
	#localPageLoadInFlight = false;
	/** Signed row adjustment applied after ScrollView receives rebuilt lines. */
	#rowsAddedAbove = 0;
	#rowAnchorWidth = 1;
	#lastContentWidth = 1;
	#viewportHeight = 10;
	// Remote transcript state (incremental; the host caps each read).
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#remoteError = "";
	#hasRemoteData = false;

	#model: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	#initialEntryId: string | undefined;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#initialEntryId = deps.initialEntryId;
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor and aborted-agent transcripts are read-only. */
	get #sendable(): boolean {
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#localPageToken++;
		this.#localPageLoadInFlight = false;
		this.#remoteToken++;
		this.#builder.dispose();
	}

	#stopPolling(): void {
		if (!this.#pollTimer) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Refresh the transcript from a local file or remote host. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#localState;
		if (state && this.#canAppendLocal(sessionFile, stat, state)) {
			if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
			if (stat.size > state.size) {
				this.#appendLocal(sessionFile, stat, state);
				return;
			}
		}
		this.#loadLocalTail(sessionFile, stat);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localPageToken++;
		this.#localPageLoadInFlight = false;
		this.#rowsAddedAbove = 0;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#followBottom = true;
		this.#rebuild([]);
	}

	#canAppendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(sessionFile, sentinel.offset, sentinel.bytes.byteLength);
			} catch (err) {
				// The file can be unlinked/rotated between statSync and this read.
				// Treat as not-appendable so #refresh falls back to a guarded tail load.
				logger.debug("transcript viewer: sentinel read failed", { err: String(err) });
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	#loadLocalTail(sessionFile: string, stat: fs.Stats): void {
		let tail: LocalTranscriptTail;
		let sentinels: LocalTranscriptSentinel[];
		try {
			tail = readLocalTail(sessionFile, stat.size);
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			// Leave #localState unchanged so a transient read error retries next poll.
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			return;
		}
		// Every byte up to the sampled stat must be represented by either the
		// complete-line cursor or its trailing pending fragment. A short read means
		// the file changed underneath us; keep the previous window and retry.
		if (tail.completeEnd + tail.pending.byteLength !== stat.size) return;
		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
		} catch {
			return;
		}
		if (
			post.dev !== stat.dev ||
			post.ino !== stat.ino ||
			post.size < stat.size ||
			(post.size === stat.size && post.mtimeMs !== stat.mtimeMs)
		)
			return;

		this.#localPageToken++;
		this.#localPageLoadInFlight = false;
		this.#rowsAddedAbove = 0;
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			completeEnd: tail.completeEnd,
			pending: tail.pending,
			pages: tail.page ? [tail.page] : [],
			sentinels,
		};
		this.#followBottom = true;
		this.#rebuildLocalWindow();
	}

	#appendLocal(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		const growth = stat.size - state.size;
		if (growth > LOCAL_PAGE_BYTES) {
			if (this.#followBottom) this.#loadLocalTail(sessionFile, stat);
			else this.#advanceParkedLocalTail(sessionFile, stat, state);
			return;
		}
		let chunk: Buffer;
		try {
			chunk = readFileRangeSync(sessionFile, state.size, growth);
		} catch (err) {
			logger.debug("transcript viewer: tail read failed", { err: String(err) });
			this.#loadLocalTail(sessionFile, stat);
			return;
		}
		if (chunk.byteLength !== growth) {
			this.#loadLocalTail(sessionFile, stat);
			return;
		}
		const combined = Buffer.concat([state.pending, chunk]);
		const lastNewline = combined.lastIndexOf(0x0a);
		const complete = lastNewline >= 0 ? Buffer.from(combined.subarray(0, lastNewline + 1)) : Buffer.alloc(0);
		const pending = Buffer.from(lastNewline >= 0 ? combined.subarray(lastNewline + 1) : combined);
		const oldCompleteEnd = state.completeEnd;
		const newCompleteEnd = oldCompleteEnd + complete.byteLength;
		let sentinels: LocalTranscriptSentinel[];
		try {
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			// File unlinked/rotated mid-poll: fall back to a guarded tail reload
			// instead of letting the open escape the poll timer.
			logger.debug("transcript viewer: sentinel recompute failed", { err: String(err) });
			this.#loadLocalTail(sessionFile, stat);
			return;
		}
		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
		} catch {
			return;
		}
		if (
			post.dev !== stat.dev ||
			post.ino !== stat.ino ||
			post.size < stat.size ||
			(post.size === stat.size && post.mtimeMs !== stat.mtimeMs)
		) {
			this.#loadLocalTail(sessionFile, post);
			return;
		}
		const windowAtTail = this.#localWindowEnd(state) === oldCompleteEnd;
		const nextState: LocalTranscriptState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			completeEnd: newCompleteEnd,
			pending,
			sentinels,
		};
		this.#localState = nextState;
		if (complete.byteLength === 0 || !windowAtTail) return;

		// A reader parked above the tail keeps its viewport stable. Once appending
		// would require front eviction, leave the completed bytes cold; paging down
		// can bring them in without moving the visible record.
		if (!this.#followBottom && this.#localResidentBytes(nextState.pages) + complete.byteLength > LOCAL_RESIDENT_BYTES)
			return;

		const lastPage = nextState.pages.at(-1);
		if (
			lastPage &&
			lastPage.end === oldCompleteEnd &&
			lastPage.bytes.byteLength + complete.byteLength <= LOCAL_PAGE_BYTES
		) {
			lastPage.end = newCompleteEnd;
			lastPage.bytes = Buffer.concat([lastPage.bytes, complete]);
		} else {
			nextState.pages.push(...splitCompleteLocalPages(oldCompleteEnd, complete));
		}

		if (this.#followBottom) {
			const evicted = this.#trimLocalPages("front", 1);
			if (evicted) {
				this.#rebuildLocalWindow();
				return;
			}
		}
		const previousModel = this.#model;
		const parsed = this.#extractMessages(parseSessionEntries(complete.toString("utf-8")));
		if (parsed.length > 0) {
			this.#append(parsed);
		} else if (this.#model !== previousModel) {
			this.deps.requestRender();
		}
	}

	/**
	 * Advance a parked reader after a burst without materializing every byte
	 * added since the previous poll. The resident pages (and therefore its
	 * viewport) stay intact, while the new complete-line boundary lets ordinary
	 * downward paging traverse the cold appended range later.
	 */
	#advanceParkedLocalTail(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let tail: LocalTranscriptTail;
		let sentinels: LocalTranscriptSentinel[];
		try {
			tail = readLocalTail(sessionFile, stat.size);
			sentinels = sentinelsFromFile(sessionFile, stat.size);
		} catch (err) {
			logger.debug("transcript viewer: bounded tail probe failed", { err: String(err) });
			return;
		}
		if (tail.completeEnd + tail.pending.byteLength !== stat.size) return;

		let post: fs.Stats;
		try {
			post = fs.statSync(sessionFile);
		} catch {
			return;
		}
		if (
			post.dev !== stat.dev ||
			post.ino !== stat.ino ||
			post.size < stat.size ||
			(post.size === stat.size && post.mtimeMs !== stat.mtimeMs)
		) {
			this.#loadLocalTail(sessionFile, post);
			return;
		}

		this.#localUnavailable = "";
		this.#localState = {
			...state,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			completeEnd: tail.completeEnd,
			pending: tail.pending,
			sentinels,
		};
	}

	#localWindowStart(state: LocalTranscriptState): number {
		return state.pages[0]?.start ?? state.completeEnd;
	}

	#localWindowEnd(state: LocalTranscriptState): number {
		return state.pages.at(-1)?.end ?? state.completeEnd;
	}

	#localResidentBytes(pages: readonly LocalTranscriptPage[]): number {
		let bytes = 0;
		for (const page of pages) bytes += page.bytes.byteLength;
		return bytes;
	}

	#trimLocalPages(edge: "front" | "back", minimumPages: number): boolean {
		const state = this.#localState;
		if (!state) return false;
		let resident = this.#localResidentBytes(state.pages);
		let evicted = false;
		while (resident > LOCAL_RESIDENT_BYTES && state.pages.length > minimumPages) {
			const page = edge === "front" ? state.pages.shift() : state.pages.pop();
			if (!page) break;
			resident -= page.bytes.byteLength;
			evicted = true;
		}
		return evicted;
	}

	#localEntries(state: LocalTranscriptState): SessionMessageEntry[] {
		this.#model = undefined;
		const entries: SessionMessageEntry[] = [];
		for (const page of state.pages) {
			try {
				entries.push(...this.#extractMessages(parseSessionEntries(page.bytes.toString("utf-8"))));
			} catch (err) {
				// Pages are newline aligned, but a malformed persisted record must not
				// tear down the fullscreen overlay or poison neighboring pages.
				logger.debug("transcript viewer: page parse failed", {
					err: String(err),
					start: page.start,
					end: page.end,
				});
			}
		}
		return entries;
	}

	#rebuildLocalWindow(anchorDirection: -1 | 0 | 1 = 0, requireVisibleAnchor = false): boolean {
		const state = this.#localState;
		if (!state) return false;
		const oldLines = this.#builder.isEmpty ? [] : this.#builder.container.render(this.#lastContentWidth);
		if (requireVisibleAnchor && oldLines.length === 0) return false;
		const oldOffset = this.#scrollView.getScrollOffset();
		this.#builder.rebuild(this.#localEntries(state));
		if (!this.#followBottom && anchorDirection !== 0 && oldLines.length > 0) {
			const newLines = this.#builder.isEmpty ? [] : this.#builder.container.render(this.#lastContentWidth);
			const delta = this.#anchorRowDelta(oldLines, newLines, oldOffset, anchorDirection, requireVisibleAnchor);
			if (delta === undefined) {
				this.deps.requestRender();
				return false;
			}
			this.#rowAnchorWidth = this.#lastContentWidth;
			this.#rowsAddedAbove += delta;
		}
		this.deps.requestRender();
		return true;
	}

	/**
	 * Locate an unchanged row inside the current viewport after a bounded-window
	 * rebuild. Its old/new index difference is the signed number of rows inserted
	 * above the anchor (or removed by front eviction). Applying that difference
	 * after ScrollView.setLines preserves the anchor despite setLines clamping.
	 */
	#anchorRowDelta(
		oldLines: readonly string[],
		newLines: readonly string[],
		oldOffset: number,
		direction: -1 | 1,
		requireVisibleAnchor: boolean,
	): number | undefined {
		const start = Math.max(0, Math.min(oldOffset, oldLines.length - 1));
		const matchEnd = Math.min(oldLines.length, start + Math.max(1, this.#viewportHeight));
		const candidateEnd = requireVisibleAnchor ? start + 1 : matchEnd;
		const viewportRows = new Set(oldLines.slice(start, candidateEnd));
		const occurrences = new Map<string, number[]>();
		for (let index = 0; index < newLines.length; index++) {
			const row = newLines[index]!;
			if (viewportRows.has(row)) {
				const indexes = occurrences.get(row);
				if (indexes) indexes.push(index);
				else occurrences.set(row, [index]);
			}
		}
		let bestDelta: number | undefined;
		let bestScore = 0;
		for (let oldIndex = start; oldIndex < candidateEnd; oldIndex++) {
			const indexes = occurrences.get(oldLines[oldIndex]!);
			if (!indexes) continue;
			for (const newIndex of indexes) {
				const delta = newIndex - oldIndex;
				if ((direction < 0 && delta < 0) || (direction > 0 && delta > 0)) continue;
				let score = 1;
				while (
					oldIndex + score < matchEnd &&
					newIndex + score < newLines.length &&
					oldLines[oldIndex + score] === newLines[newIndex + score]
				)
					score++;
				if (score > bestScore || (score === bestScore && Math.abs(delta) < Math.abs(bestDelta ?? Infinity))) {
					bestScore = score;
					bestDelta = delta;
				}
			}
		}
		return requireVisibleAnchor && bestScore < matchEnd - start ? undefined : bestDelta;
	}

	#maybeLoadLocalPage(direction: -1 | 1): void {
		if (this.#disposed || this.deps.remote || this.#localPageLoadInFlight) return;
		const state = this.#localState;
		if (!state) return;
		const offset = this.#scrollView.getScrollOffset();
		const maxOffset = this.#scrollView.getMaxScrollOffset();
		if (direction < 0 && (offset > LOCAL_PAGE_PREFETCH_ROWS || this.#localWindowStart(state) <= 0)) return;
		if (
			direction > 0 &&
			(maxOffset - offset > LOCAL_PAGE_PREFETCH_ROWS || this.#localWindowEnd(state) >= state.completeEnd)
		)
			return;

		const boundary = direction < 0 ? this.#localWindowStart(state) : this.#localWindowEnd(state);
		const completeEnd = state.completeEnd;
		const token = this.#localPageToken;
		this.#localPageLoadInFlight = true;
		void (
			direction < 0
				? readPreviousLocalPage(state.path, boundary)
				: readNextLocalPage(state.path, boundary, completeEnd)
		)
			.then(page => {
				if (!page || this.#disposed || token !== this.#localPageToken) return;
				const current = this.#localState;
				if (!current || current.path !== state.path || current.dev !== state.dev || current.ino !== state.ino)
					return;
				if (direction < 0 && this.#localWindowStart(current) !== boundary) return;
				if (direction > 0 && this.#localWindowEnd(current) !== boundary) return;

				let post: fs.Stats;
				try {
					post = fs.statSync(current.path);
				} catch {
					return;
				}
				if (!this.#canAppendLocal(current.path, post, current)) {
					this.#loadLocalTail(current.path, post);
					return;
				}

				if (direction < 0) {
					// `page.end === boundary`: the first byte already in the window is
					// never included twice, and readPreviousLocalPage drops its headless line.
					if (page.end !== boundary) return;
					const oldPages = [...current.pages];
					current.pages.unshift(page);
					const evictedBack = this.#trimLocalPages("back", 2);
					if (evictedBack && !this.#rebuildLocalWindow(direction, true)) {
						// Back eviction is normally far below an upward-scrolling viewport,
						// but retain the old bounded window if any visible row was in it.
						current.pages = oldPages;
						this.#builder.rebuild(this.#localEntries(current));
						return;
					}
					if (evictedBack) return;
				} else {
					if (page.start !== boundary || page.end > current.completeEnd) return;
					const oldPages = [...current.pages];
					current.pages.push(page);
					const evictedFront = this.#trimLocalPages("front", 2);
					if (evictedFront && !this.#rebuildLocalWindow(direction, true)) {
						// At least one current viewport row belonged to an eviction candidate.
						// Restore the bounded old window rather than silently jumping over it.
						current.pages = oldPages;
						this.#builder.rebuild(this.#localEntries(current));
						return;
					}
					if (evictedFront) return;
				}
				this.#rebuildLocalWindow(direction);
			})
			.catch((err: unknown) => {
				logger.debug("transcript viewer: page read failed", { err: String(err) });
			})
			.finally(() => {
				if (token === this.#localPageToken) {
					this.#localPageLoadInFlight = false;
					if (this.#initialEntryId && !this.#disposed) this.deps.requestRender();
				}
			});
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.deps.agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.deps.requestRender();
					}
					return;
				}
				if (result.error) {
					this.#remoteError = result.error;
					this.#hasRemoteData = true;
					this.#remoteUnavailable = false;
					this.#stopPolling();
					this.deps.requestRender();
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — drop the stale rendered rows
					// before restarting; otherwise the post-rotation fetch would stack
					// new content under the pre-rotation history.
					this.#remoteBytes = 0;
					this.#remoteError = "";
					this.#hasRemoteData = false;
					this.#model = undefined;
					this.#rebuild([]);
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				this.#remoteError = "";
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const completeChunk = result.text.slice(0, lastNewline + 1);
					this.#remoteBytes = fromByte + Buffer.byteLength(completeChunk, "utf-8");
					const previousModel = this.#model;
					const parsed = this.#extractMessages(parseSessionEntries(completeChunk));
					if (parsed.length > 0) {
						this.#append(parsed);
						return;
					}
					if (this.#model !== previousModel) {
						this.deps.requestRender();
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		const messages: SessionMessageEntry[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#builder.rebuild(entries);
		this.deps.requestRender();
	}

	#append(entries: SessionMessageEntry[]): void {
		this.#builder.append(entries);
		this.deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#syncFollow();
					this.#maybeLoadLocalPage(event.wheel < 0 ? -1 : 1);
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.deps.onHubClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			if (this.#editor && this.#editor.getText().trim() !== "") {
				this.#editor.setText("");
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		// Once the reader starts typing a message, the editor owns every key.
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.deps.requestRender();
		}
	}

	/** Returns true when the key was a scroll command. ScrollView owns the offset. */
	#handleScroll(data: string): boolean {
		let direction: -1 | 1;
		if (this.#scrollView.handleScrollKey(data)) {
			direction =
				matchesKey(data, "shift+up") ||
				matchesKey(data, "up") ||
				matchesKey(data, "pageUp") ||
				matchesKey(data, "home")
					? -1
					: 1;
			this.#syncFollow();
			this.#maybeLoadLocalPage(direction);
			this.deps.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
			direction = 1;
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
			direction = -1;
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
			direction = -1;
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
			direction = 1;
		} else {
			return false;
		}
		this.#syncFollow();
		this.#maybeLoadLocalPage(direction);
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		const state = this.#localState;
		const windowAtTail = !state || this.#localWindowEnd(state) >= state.completeEnd;
		this.#followBottom = windowAtTail && this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, trimmed);
			this.deps.requestRender();
			return;
		}
		const lifecycle = this.deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await lifecycle().ensureLive(id);
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.deps.requestRender();
		})();
		this.deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// `innerWidth` widths the editor/notice chrome (gutter-prefixed below).
		// `contentWidth` widths the transcript: ScrollView reserves the last column
		// for the scrollbar, and the transcript components carry their own 1-col left
		// gutter — so body rows are emitted WITHOUT an extra outer space, sharing that
		// gutter with the header/footer (which add one). Stacking both shifted the body
		// one column right of the title.
		const innerWidth = Math.max(20, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice
			? ` ${theme.fg("error", sanitizeErrorLine(this.#notice, innerWidth))}`
			: this.#remoteError && !this.#builder.isEmpty
				? ` ${theme.fg("error", sanitizeErrorLine(this.#remoteError, innerWidth))}`
				: undefined;
		const editorLines = this.#editor ? this.#editor.render(innerWidth) : [];

		// Chrome: top border + header rows + divider border + (notice) + editor + footer + bottom border.
		const chrome = headerLines.length + 2 + editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		const viewportHeight = Math.max(3, termHeight - chrome);
		this.#lastContentWidth = contentWidth;
		this.#viewportHeight = viewportHeight;

		const contentLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder(Math.max(10, contentWidth - 1)))}`]
			: this.#builder.container.render(contentWidth);
		// setLines/setHeight clamp their owned offset. Capture it first and apply
		// the signed prepend/front-eviction row delta only after both clamps.
		const anchoredOffset = this.#scrollView.getScrollOffset();
		this.#scrollView.setLines(contentLines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#initialEntryId) {
			const targetRow = this.#builder.rowForEntry(this.#initialEntryId);
			if (targetRow !== undefined) {
				this.#followBottom = false;
				this.#scrollView.setScrollOffset(Math.max(0, targetRow - 1));
				this.#initialEntryId = undefined;
			} else if (this.#localState && !this.deps.remote) {
				this.#followBottom = false;
				this.#scrollView.scrollToTop();
				if (this.#localWindowStart(this.#localState) > 0) this.#maybeLoadLocalPage(-1);
				else this.#initialEntryId = undefined;
			}
		} else if (this.#followBottom) {
			this.#scrollView.scrollToBottom();
		} else if (this.#rowsAddedAbove !== 0 && this.#rowAnchorWidth === contentWidth) {
			this.#scrollView.setScrollOffset(anchoredOffset + this.#rowsAddedAbove);
		}
		this.#rowsAddedAbove = 0;

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(` ${headerLine}`);
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		if (noticeLine) lines.push(noticeLine);
		for (const editorLine of editorLines) lines.push(` ${editorLine}`);
		lines.push(...footerLines);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Hub ${theme.sep.dot} ${this.deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(` ${statsLine}`);
		const hint = this.#editor
			? `Enter:send  Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → j/k:scroll  g/G:top/bottom`
			: `Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  j/k:scroll  g/G:top/bottom`;
		lines.push(` ${theme.fg("dim", hint)}`);
		return lines;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.deps.observers?.getSession(this.deps.agentId);
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : "";
			parts.push(theme.fg("dim", [toolStat, ...stats].filter(Boolean).join(theme.sep.dot)));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#placeholder(maxWidth: number): string {
		if (this.deps.remote) {
			if (this.#remoteError) return sanitizeErrorLine(this.#remoteError, maxWidth);
			if (this.#remoteUnavailable) return "Transcript lives on the host — not available.";
			return this.#hasRemoteData ? "No messages yet." : "Loading transcript from host…";
		}
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
