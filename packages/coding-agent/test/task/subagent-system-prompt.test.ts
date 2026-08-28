import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import "../../src/config/prompt-templates";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

describe("subagent system prompt", () => {
	it("treats inherited trajectory as history while retaining smart nested delegation", () => {
		const out = prompt.render(subagentSystemPromptTemplate, { agent: "Execute the assigned work." });

		expect(out).toContain("history and evidence, not your live control state");
		expect(out).toContain("do not resume the parent agent's todos, checkpoints, pending tool calls");
		expect(out).toContain("perform its coherent core work directly");
		expect(out).toContain("genuinely independent sub-work");
		expect(out).toContain("Never spawn one child and wait for it to perform your primary assignment");
	});

	it("revokes native output labels when caller schema overrides the agent", () => {
		const out = prompt.render(subagentSystemPromptTemplate, {
			agent: 'Use incremental yield with type: ["findings"].',
			outputSchemaOverridesAgent: true,
			outputSchema: {
				properties: {
					issue_key: { type: "string" },
					verdict: { enum: ["clean", "blockers"] },
				},
			},
		});

		expect(out).toContain("Caller schema overrides agent-native output instructions");
		expect(out).toContain("Ignore ROLE-provided output/yield labels");
		expect(out).toContain("omit `type` and terminal-yield the full `result.data` object");
	});
});
