import { shortenPath } from "@oh-my-pi/pi-tui/render";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { SessionInfo } from "../../session/session-listing";
import { normalizePromptPath } from "../../utils/prompt-path";

/** Shortest unique path suffixes, derived only from recorded working directories. */
export function sessionProjectLabels(sessions: readonly SessionInfo[]): Map<string, string> {
	const paths = new Map<string, string[]>();
	const counts = new Map<string, number>();
	for (const session of sessions) {
		const cwd = session.cwd;
		if (!cwd || paths.has(cwd)) continue;
		const display = replaceTabs(sanitizeText(shortenPath(normalizePromptPath(cwd)))).replace(/\n/g, " ");
		const parts = display.replace(/\/+$/, "").split("/");
		if (parts.length === 1 && parts[0] === "") parts[0] = "/";
		paths.set(cwd, parts);
		for (let depth = 1; depth <= parts.length; depth++) {
			const suffix = parts.slice(-depth).join("/");
			counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
		}
	}
	const labels = new Map<string, string>();
	if (sessions.some(session => !session.cwd)) labels.set("", "Not recorded");
	for (const [cwd, parts] of paths) {
		let label = replaceTabs(sanitizeText(shortenPath(normalizePromptPath(cwd)))).replace(/\n/g, " ");
		for (let depth = 1; depth <= parts.length; depth++) {
			const suffix = parts.slice(-depth).join("/");
			if (counts.get(suffix) === 1) {
				label = suffix;
				break;
			}
		}
		labels.set(cwd, label);
	}
	return labels;
}
