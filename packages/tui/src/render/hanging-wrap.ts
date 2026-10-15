import { visibleWidth, wrapTextWithAnsi } from "../utils";
import type { Theme } from "../theme/theme";

/** Wrap content under a distinct first-row prefix, preserving its column on continuation rows. */
export function wrapPrefixedLine(prefix: string, continuationPrefix: string, content: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const continuationWidth = visibleWidth(continuationPrefix);
	if (width <= Math.max(prefixWidth, continuationWidth)) return wrapTextWithAnsi(prefix + content, width);
	const rows = wrapTextWithAnsi(content, width - Math.max(prefixWidth, continuationWidth));
	return rows.map((row, index) => `${index === 0 ? prefix : continuationPrefix}${row}`);
}

/** Preserve a tree connector's ancestor guides while hanging a long node beneath its label. */
export function wrapTreeLine(line: string, width: number, theme: Theme): string[] | undefined {
	for (const connector of [theme.tree.branch, theme.tree.last]) {
		const marker = theme.fg("dim", connector);
		const index = line.indexOf(marker);
		if (index < 0) continue;
		const before = line.slice(0, index);
		if (!/^[ │]*$/.test(Bun.stripANSI(before))) continue;
		const end = index + marker.length + 1;
		if (line[end - 1] !== " ") continue;
		const connectorWidth = visibleWidth(connector);
		const guide =
			connector === theme.tree.last
				? " ".repeat(connectorWidth)
				: `${theme.fg("dim", theme.tree.vertical)}${" ".repeat(Math.max(0, connectorWidth - visibleWidth(theme.tree.vertical)))}`;
		return wrapPrefixedLine(line.slice(0, end), `${before}${guide} `, line.slice(end), width);
	}
	return undefined;
}
