/**
 * Removal of DeepSeek DSML tool-call markup left in visible assistant text.
 *
 * DeepSeek models on OpenAI-compatible hosts sometimes emit their tool calls as
 * raw `<｜DSML｜…>` markup in `content`. A well-formed envelope is healed into a
 * structured call by `StreamMarkupHealing`, but a degraded model can drop the
 * opening `<｜DSML｜tool_calls>` / `<｜DSML｜invoke name="…">` tags (or the host
 * runs no healer at all). That markup must not stay in history: replaying it
 * teaches the model to keep writing tool calls as text (issue #10556). Callers
 * strip it before the message is committed and tell the model its call failed.
 */

import type { AssistantMessage, Model } from "../types";

// Structural DSML tags in either pipe spelling (fullwidth `｜` U+FF5C or ASCII),
// including doubled delimiters and the observed malformed ` calls` wrapper.
const DSML_TAG_PATTERN = /<\s*\/?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|invoke|parameter|calls)\b[^<>]*>?/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;
const CLOSING_TAG_PATTERN = /^<\s*\//;
const BLANK_LINE_PATTERN = /\r?\n[ \t]*\r?\n/;

/**
 * Remove the broken tool call from one stretch of unquoted text: everything from
 * the first DSML tag (or the tool-name line just before it) through the last.
 * The DSML scanner keeps a malformed call's closers, so its last closer marks
 * the end. When the closers never arrived, the dangling argument value runs to
 * the next blank line (or the end of the stretch); prose after that survives.
 */
function stripUnquoted(text: string): string {
	const tags = [...text.matchAll(DSML_TAG_PATTERN)];
	if (tags.length === 0) return text;
	const first = tags[0]!;
	const last = tags[tags.length - 1]!;
	let start = first.index;
	const nameLine = TRAILING_TOOL_NAME_LINE.exec(text.slice(0, start));
	if (nameLine) start = nameLine.index + nameLine[1]!.length;
	const lastEnd = last.index + last[0].length;
	let end = lastEnd;
	if (!CLOSING_TAG_PATTERN.test(last[0])) {
		const blankLine = text.slice(lastEnd).search(BLANK_LINE_PATTERN);
		end = blankLine === -1 ? text.length : lastEnd + blankLine;
	}
	const before = text.slice(0, start).trimEnd();
	const after = text.slice(end).trimStart();
	return before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : before + after;
}

/**
 * Whether DSML leak recovery applies to `model`: a DeepSeek-class model, or one
 * explicitly configured with the `dsml` stream healer (e.g. a `models.yml` entry
 * whose id the classifier cannot place). Other models never write DSML tool
 * calls, so DSML text from them is prose and is left alone.
 */
export function isDsmlLeakRecoveryTarget(model: Model): boolean {
	if (model.identity?.class === "deepseek") return true;
	const compat = model.compat;
	return (
		compat !== undefined && "streamMarkupHealingPattern" in compat && compat.streamMarkupHealingPattern === "dsml"
	);
}

/**
 * Strip leaked DSML tool-call markup from `text`, leaving quoted code intact.
 * Returns `undefined` when `text` carries no such markup.
 */
export function stripDsmlToolMarkup(text: string): string | undefined {
	if (!text.includes("DSML")) return undefined;
	let out = "";
	let cursor = 0;
	let changed = false;
	const flush = (end: number): void => {
		const segment = text.slice(cursor, end);
		const stripped = stripUnquoted(segment);
		if (stripped !== segment) changed = true;
		out += stripped;
	};
	for (const quoted of text.matchAll(QUOTED_CODE_PATTERN)) {
		flush(quoted.index);
		out += quoted[0];
		cursor = quoted.index + quoted[0].length;
	}
	flush(text.length);
	return changed ? out : undefined;
}

/**
 * Remove leaked DSML tool-call markup from an assistant message before commit,
 * including reasoning blocks and turns with valid structured calls. Rewritten
 * thinking with an opaque signature is discarded; OpenAI-compatible reasoning
 * field names are replay markers, not signatures, and survive cleanup.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let content: AssistantMessage["content"] | undefined;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index]!;
		if (block.type !== "text" && block.type !== "thinking") {
			content?.push(block);
			continue;
		}
		const stripped = stripDsmlToolMarkup(block.type === "text" ? block.text : block.thinking);
		if (stripped === undefined) {
			content?.push(block);
			continue;
		}
		content ??= message.content.slice(0, index);
		if (block.type === "text") {
			if (stripped.trim().length > 0) content.push({ ...block, text: stripped });
		} else {
			const signature = block.thinkingSignature;
			const reasoningField =
				(message.api === "openai-completions" || message.api === "openrouter") &&
				(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text");
			if ((!signature || reasoningField) && stripped.trim().length > 0) {
				content.push({ ...block, thinking: stripped });
			}
		}
	}
	if (content) message.content = content;
	return content !== undefined;
}
