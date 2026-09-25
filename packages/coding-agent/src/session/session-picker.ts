import {
	selectSession as selectTuiSession,
	type SessionPickerHost,
	type SessionPickerOptions,
} from "@oh-my-pi/pi-tui/apps/session-picker";
import { SessionPreviewComponent } from "../modes/components/session-preview";
import { HistoryStorage } from "./history-storage";
import { loadPinnedSessionIds } from "./session-pins";
import { FileSessionStorage } from "./session-storage";
import type { SessionInfo } from "./session-listing";
import { SessionManager } from "./session-manager";

export type SessionPicker = (
	sessions: SessionInfo[],
	options?: SessionPickerOptions<SessionInfo>,
) => Promise<SessionInfo | null>;

/** Share the coding agent's history, pin, deletion, and preview behavior across every session picker. */
export function selectSession(
	sessions: SessionInfo[],
	options?: SessionPickerOptions<SessionInfo>,
): Promise<SessionInfo | null> {
	const storage = new FileSessionStorage();
	const host: SessionPickerHost<SessionInfo> = {
		loadPinnedIds: loadPinnedSessionIds,
		loadHistoryMatcher: () => {
			const history = HistoryStorage.open();
			return query => history.matchingSessionIds(query);
		},
		deleteSession: async session => {
			await storage.deleteSessionWithArtifacts(session.path);
			return true;
		},
		loadAllSessions: () => SessionManager.listAllForPicker(storage),
		createPreview: () => new SessionPreviewComponent(),
	};
	return selectTuiSession(sessions, { preview: true, ...options }, host);
}
