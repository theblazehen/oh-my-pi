import { coerceServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { SessionEntry, SessionHeader } from "./session-entries";
import {
	DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS,
	type SessionHistoryCredentialPinSeed,
	type SessionHistoryHotWindow,
	type SessionHistoryHotWindowLimits,
	type SessionHistoryPrefixState,
} from "./session-history-worker-protocol";
import { getLatestTodoPhasesFromEntries } from "../tools/todo";
import { loadSessionFile } from "./session-loader";
import { migrateToCurrentVersion } from "./session-migrations";
import { addUsage, emptyUsageStatistics, entryUsage } from "./session-usage";

const MAX_PREVIOUS_COMPACTION_SEGMENTS = 2;

function normalizeLimits(limits: SessionHistoryHotWindowLimits): SessionHistoryHotWindowLimits {
	const bytes = Number.isFinite(limits.maxResidentBytes)
		? Math.max(0, Math.trunc(limits.maxResidentBytes))
		: DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS.maxResidentBytes;
	const segments = Number.isFinite(limits.maxPreviousCompactionSegments)
		? Math.max(0, Math.min(MAX_PREVIOUS_COMPACTION_SEGMENTS, Math.trunc(limits.maxPreviousCompactionSegments)))
		: DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS.maxPreviousCompactionSegments;
	return { maxResidentBytes: bytes, maxPreviousCompactionSegments: segments };
}

/** Serialized journal footprint of one logical entry, including its newline. */
function journalBytes(entry: SessionEntry): number {
	return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
}

function activePath(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
	const leaf = leafId === null ? undefined : entries.find(entry => entry.id === leafId);
	if (!leaf) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const reversed: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		reversed.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	reversed.reverse();
	return reversed;
}

interface WindowSelection {
	startIndex: number;
	pinnedStartIndex: number;
	latestCompactionIndex: number;
	residentJournalBytes: number;
	previousCompactionSegmentsIncluded: number;
}

function selectResidentWindow(path: readonly SessionEntry[], limits: SessionHistoryHotWindowLimits): WindowSelection {
	if (path.length === 0) {
		return {
			startIndex: 0,
			pinnedStartIndex: 0,
			latestCompactionIndex: -1,
			residentJournalBytes: 0,
			previousCompactionSegmentsIncluded: 0,
		};
	}

	const sizes = path.map(journalBytes);
	let latestCompactionIndex = -1;
	for (let index = path.length - 1; index >= 0; index--) {
		if (path[index]?.type === "compaction") {
			latestCompactionIndex = index;
			break;
		}
	}

	if (latestCompactionIndex < 0) {
		let startIndex = path.length;
		let residentJournalBytes = 0;
		for (let index = path.length - 1; index >= 0; index--) {
			const nextBytes = sizes[index]!;
			// Always retain the leaf, even when one entry alone exceeds the cap.
			if (startIndex < path.length && residentJournalBytes + nextBytes > limits.maxResidentBytes) break;
			startIndex = index;
			residentJournalBytes += nextBytes;
		}
		return {
			startIndex,
			pinnedStartIndex: startIndex,
			latestCompactionIndex,
			residentJournalBytes,
			previousCompactionSegmentsIncluded: 0,
		};
	}

	const latestCompaction = path[latestCompactionIndex]!;
	let pinnedStartIndex = latestCompactionIndex;
	if (latestCompaction.type === "compaction") {
		for (let index = 0; index < latestCompactionIndex; index++) {
			if (path[index]?.id === latestCompaction.firstKeptEntryId) {
				pinnedStartIndex = index;
				break;
			}
		}
	}

	// Usage records immediately preceding the first kept message belong to
	// the same effective transcript window as that message (session-stats).
	while (pinnedStartIndex > 0) {
		const previous = path[pinnedStartIndex - 1]!;
		if (
			previous.type === "message" ||
			previous.type === "custom_message" ||
			previous.type === "branch_summary" ||
			previous.type === "compaction" ||
			previous.type === "reset_boundary"
		)
			break;
		pinnedStartIndex--;
	}

	// The entire effective context is correctness-pinned, even above the cap.
	let startIndex = pinnedStartIndex;
	let residentJournalBytes = 0;
	for (let index = startIndex; index < path.length; index++) residentJournalBytes += sizes[index]!;

	let previousCompactionSegmentsIncluded = 0;
	while (previousCompactionSegmentsIncluded < limits.maxPreviousCompactionSegments) {
		let previousCompactionIndex = -1;
		for (let index = startIndex - 1; index >= 0; index--) {
			if (path[index]?.type === "compaction") {
				previousCompactionIndex = index;
				break;
			}
		}
		if (previousCompactionIndex < 0) break;

		let segmentBytes = 0;
		for (let index = previousCompactionIndex; index < startIndex; index++) segmentBytes += sizes[index]!;
		if (residentJournalBytes + segmentBytes > limits.maxResidentBytes) break;

		startIndex = previousCompactionIndex;
		residentJournalBytes += segmentBytes;
		previousCompactionSegmentsIncluded++;
	}

	return {
		startIndex,
		pinnedStartIndex,
		latestCompactionIndex,
		residentJournalBytes,
		previousCompactionSegmentsIncluded,
	};
}

function prefixCredentialPins(entries: readonly SessionEntry[]): SessionHistoryCredentialPinSeed[] {
	const pins = new Map<string, SessionHistoryCredentialPinSeed>();
	for (const entry of entries) {
		if (entry.type === "credential_pin") {
			pins.set(entry.provider, {
				provider: entry.provider,
				hash: entry.hash,
				lastUsedAt: new Date(entry.timestamp).getTime(),
			});
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const pin = pins.get(entry.message.provider);
			if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
		}
	}
	return [...pins.values()];
}

/** Derive exactly the control state contributed by omitted active-path ancestors. */
function derivePrefixState(entries: readonly SessionEntry[]): SessionHistoryPrefixState {
	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let hasThinkingLevelChange = false;
	let serviceTier: SessionHistoryPrefixState["serviceTier"];
	let hasServiceTierChange = false;
	const models: Record<string, string> = {};
	let hasExplicitDefaultModel = false;
	const injectedTtsrRules = new Set<string>();
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	let lastModelChangeRole: string | undefined;
	let cacheResetPending = false;
	let lastAssistantModel: string | undefined;

	for (const entry of entries) {
		if (entry.type === "thinking_level_change") {
			hasThinkingLevelChange = true;
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			cacheResetPending = true;
			const role = entry.role ?? "default";
			lastModelChangeRole = role;
			if (entry.model) {
				models[role] = entry.model;
				if (role === "default") hasExplicitDefaultModel = true;
			}
		} else if (entry.type === "service_tier_change") {
			hasServiceTierChange = true;
			serviceTier = coerceServiceTierByFamily(entry.serviceTier);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			if (!hasExplicitDefaultModel) models.default = `${entry.message.provider}/${entry.message.model}`;
			lastAssistantModel = `${entry.message.provider}/${entry.message.model}`;
			cacheResetPending = false;
		} else if (entry.type === "compaction") {
			cacheResetPending = true;
		} else if (entry.type === "ttsr_injection") {
			for (const name of entry.injectedRules) injectedTtsrRules.add(name);
		} else if (entry.type === "mode_change") {
			if ((entry.mode === "plan") !== (mode === "plan")) cacheResetPending = true;
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	return {
		thinkingLevel,
		configuredThinkingLevel,
		hasThinkingLevelChange,
		serviceTier,
		hasServiceTierChange,
		models,
		hasExplicitDefaultModel,
		injectedTtsrRules: [...injectedTtsrRules],
		mode,
		modeData,
		lastModelChangeRole,
		cacheResetPending,
		lastAssistantModel,
		credentialPins: prefixCredentialPins(entries),
		todoPhases: getLatestTodoPhasesFromEntries(entries),
	};
}

function resolveLabels(
	entries: readonly SessionEntry[],
	residentEntries: readonly SessionEntry[],
): Record<string, string> {
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		if (entry.label) labels.set(entry.targetId, entry.label);
		else labels.delete(entry.targetId);
	}
	const resolved: Record<string, string> = {};
	for (const entry of residentEntries) {
		const label = labels.get(entry.id);
		if (label) resolved[entry.id] = label;
	}
	return resolved;
}

/**
 * Parse and migrate one complete journal inside the disposable worker, then
 * return only its bounded active-path window and compact aggregate state.
 * Persisted blob references intentionally remain unresolved.
 */
export async function scanSessionHistoryHotWindow(
	filePath: string,
	requestedLimits: SessionHistoryHotWindowLimits = DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS,
): Promise<SessionHistoryHotWindow> {
	const loaded = await loadSessionFile(filePath);
	if (loaded.invalidHeader) {
		throw new Error(
			`Cannot resume session "${filePath}": the session header is missing or malformed. The file was not modified.`,
		);
	}
	const fileEntries = loaded.entries;
	if (fileEntries.length === 0 || fileEntries[0]?.type !== "session") {
		throw new Error(`Session history is empty or invalid: ${filePath}`);
	}
	const migrationRequired = migrateToCurrentVersion(fileEntries);

	const header = fileEntries[0] as SessionHeader;
	const entries = fileEntries.slice(1) as SessionEntry[];
	return {
		...buildSessionHistoryHotWindow(header, entries, requestedLimits),
		migrationRequired,
		malformedRecords: loaded.malformedRecords,
	};
}

/** Select a window without resolving blobs or copying entry payloads. */
export function buildSessionHistoryHotWindow(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	requestedLimits: SessionHistoryHotWindowLimits = DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS,
	leafId: string | null = entries.at(-1)?.id ?? null,
	residentFloorId?: string,
): SessionHistoryHotWindow {
	const path = activePath(entries, leafId);
	const limits = normalizeLimits(requestedLimits);
	const selection = selectResidentWindow(path, limits);
	// Maintenance may shrink a hot window, but must not resurrect unresolved
	// cold payloads merely because pruning freed some of its byte allowance.
	const residentFloor = residentFloorId ? path.findIndex(entry => entry.id === residentFloorId) : -1;
	if (residentFloor > selection.startIndex && residentFloor <= selection.pinnedStartIndex) {
		selection.startIndex = residentFloor;
		selection.residentJournalBytes = path
			.slice(residentFloor)
			.reduce((bytes, entry) => bytes + journalBytes(entry), 0);
		selection.previousCompactionSegmentsIncluded = path
			.slice(residentFloor, selection.pinnedStartIndex)
			.filter(entry => entry.type === "compaction").length;
	}
	const residentEntries = path.slice(selection.startIndex);
	const prefixEntries = path.slice(0, selection.startIndex);
	const originalLeafId = path.at(-1)?.id ?? null;

	const fullUsage = emptyUsageStatistics();
	let compactionCount = 0;
	let hasAssistantHistory = false;
	for (const entry of entries) {
		const usage = entryUsage(entry);
		addUsage(fullUsage, usage);
		if (usage && entry.type === "message" && entry.message.role === "toolResult") {
			fullUsage.subagentCost += usage.cost.total;
		}
		if (entry.type === "compaction") compactionCount++;
		if (entry.type === "message" && entry.message.role === "assistant") hasAssistantHistory = true;
	}

	let lastModelChangeRole: string | undefined;
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type === "model_change") {
			lastModelChangeRole = entry.role ?? "default";
			break;
		}
	}

	const latestCompaction = selection.latestCompactionIndex >= 0 ? path[selection.latestCompactionIndex] : undefined;
	const latestCompactionId = latestCompaction?.type === "compaction" ? latestCompaction.id : null;
	const effectiveContextStartId = path[selection.pinnedStartIndex]?.id ?? null;
	const fullEntryCount = entries.length;
	const residentEntryCount = residentEntries.length;
	const coldEntryCount = fullEntryCount - residentEntryCount;
	const effectiveContextComplete = latestCompactionId !== null || selection.startIndex === 0;

	return {
		header,
		residentEntries,
		originalLeafId,
		totalEntryCount: entries.length + 1,
		fullEntryCount,
		migrationRequired: false,
		residentEntryCount,
		coldEntryCount,
		hasColdEntries: coldEntryCount > 0,
		residentJournalBytes: selection.residentJournalBytes,
		fullUsage,
		compactionCount,
		hasAssistantHistory,
		lastModelChangeRole,
		latestCompactionId,
		effectiveContextStartId,
		residentStartId: residentEntries[0]?.id ?? null,
		previousCompactionSegmentsIncluded: selection.previousCompactionSegmentsIncluded,
		effectiveContextComplete,
		omittedUncompactedEntryCount: latestCompactionId === null ? selection.startIndex : 0,
		prefixState: derivePrefixState(prefixEntries),
		resolvedLabels: resolveLabels(entries, residentEntries),
		blobRefsResolved: false,
	};
}
