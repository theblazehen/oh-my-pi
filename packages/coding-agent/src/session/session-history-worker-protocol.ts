import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "../tools/todo";
import type { SessionEntry, SessionHeader, UsageStatistics } from "./session-entries";

/** Selector used when the shared CLI module is the Bun worker entrypoint. */
export const SESSION_HISTORY_WORKER_ARG = "__omp_worker_session_history";

/** Conservative defaults for the long-lived process's resident history. */
export const DEFAULT_SESSION_HISTORY_HOT_WINDOW_LIMITS: SessionHistoryHotWindowLimits = {
	maxResidentBytes: 16 * 1024 * 1024,
	maxPreviousCompactionSegments: 2,
};

export interface SessionHistoryHotWindowLimits {
	/** Journal-byte budget. The latest effective compacted context may exceed it for correctness. */
	maxResidentBytes: number;
	/** Display-only compaction segments preceding the effective context; clamped to 0..2. */
	maxPreviousCompactionSegments: number;
}

export interface SessionHistoryCredentialPinSeed {
	provider: string;
	hash: string;
	lastUsedAt: number;
}

/**
 * State accumulated on the active path before the first resident entry.
 * Session context/index construction applies this seed before walking resident
 * entries, so cold control rows keep their original semantics.
 */
export interface SessionHistoryPrefixState {
	thinkingLevel?: string;
	configuredThinkingLevel?: string;
	hasThinkingLevelChange: boolean;
	serviceTier?: ServiceTierByFamily;
	hasServiceTierChange: boolean;
	models: Record<string, string>;
	hasExplicitDefaultModel: boolean;
	injectedTtsrRules: string[];
	mode: string;
	modeData?: Record<string, unknown>;
	lastModelChangeRole?: string;
	/** Transcript cache-reset state at the resident boundary. */
	cacheResetPending: boolean;
	/** Last assistant model before the resident boundary. */
	lastAssistantModel?: string;
	credentialPins: SessionHistoryCredentialPinSeed[];
	/** Latest todo state only, not the omitted tool transcript. */
	todoPhases?: TodoPhase[];
}

/** Bounded, migrated result returned from the disposable history worker. */
export interface SessionHistoryHotWindow {
	/** Malformed records skipped by the isolated loader; requires a canonical rewrite. */
	malformedRecords?: number;
	header: SessionHeader;
	/** Active-path entries only, preserving their original IDs and parent IDs. */
	residentEntries: SessionEntry[];
	/** Original active leaf even when its ancestors are cold. */
	originalLeafId: string | null;
	/** Header plus every logical journal entry. */
	totalEntryCount: number;
	/** Every non-header journal entry, including inactive branches. */
	fullEntryCount: number;
	/** True when the worker migrated legacy rows; callers must full-load and rewrite before bounded use. */
	migrationRequired: boolean;
	residentEntryCount: number;
	coldEntryCount: number;
	hasColdEntries: boolean;
	residentJournalBytes: number;
	fullUsage: UsageStatistics;
	compactionCount: number;
	hasAssistantHistory: boolean;
	lastModelChangeRole?: string;
	/** Latest effective compaction on the active path, if any. */
	latestCompactionId: string | null;
	/** First entry required by the latest effective compacted context. */
	effectiveContextStartId: string | null;
	residentStartId: string | null;
	previousCompactionSegmentsIncluded: number;
	/**
	 * False only when an uncompacted branch exceeded the byte budget. Callers
	 * must hydrate or compact before using that truncated branch as LLM context.
	 */
	effectiveContextComplete: boolean;
	omittedUncompactedEntryCount: number;
	prefixState: SessionHistoryPrefixState;
	/** Latest resolved non-empty labels whose targets remain resident. */
	resolvedLabels: Record<string, string>;
	/** Blob payloads remain persisted refs; the receiving manager resolves only this bounded result. */
	blobRefsResolved: false;
}

export type SessionHistoryWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "scan"; id: string; filePath: string; limits: SessionHistoryHotWindowLimits };

export type SessionHistoryWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "result"; id: string; result: SessionHistoryHotWindow }
	| { type: "error"; id: string; error: SessionHistoryWorkerError };

export interface SessionHistoryWorkerError {
	name: string;
	message: string;
	stack?: string;
}
