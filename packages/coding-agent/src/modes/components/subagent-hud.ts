/**
 * Anchored subagent HUD.
 *
 * The fork introduced this module for the pinned roster that dispatches clicks
 * through `SubagentHudComponent.routeMouse`; upstream grew the same component,
 * its pinned layout and its renderer in `../interactive-mode`. The merged tree
 * keeps the single upstream implementation there and exposes it under this
 * entry point, so both the mode and its tests resolve to one component and the
 * roster keeps working in fullscreen (pinned rows) and inline (click-to-focus).
 */
export {
	layoutPinnedHud,
	nextSubagentPreviewTickMs,
	type PinnedHudLayout,
	renderSubagentHudLines,
	SubagentHudComponent,
	type SubagentHudCallbacks,
} from "../interactive-mode";
