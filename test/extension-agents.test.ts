import { describe, expect, test } from "bun:test";
import { availableAgents, type ToolDescription } from "../src/extension/agents";

const task = (description: string, source = "builtin"): ToolDescription => ({ name: "task", description, sourceInfo: { source } });
const rendered = [
	"Spawn subagents.",
	"# Available Agents",
	"- `task:mid`: General-purpose mid tier",
	"- `discuss:steady` (READ-ONLY; investigation only, no edits): Read-only partner",
	"- `m1`: user-tagged model",
	"# Delegation",
	"- `not-an-agent`: listed under another heading",
].join("\n");

describe("available subagents from the task tool", () => {
	test("lists the names under Available Agents only, in order", () => {
		expect(availableAgents([task(rendered)])).toEqual({ kind: "listed", names: ["task:mid", "discuss:steady", "m1"] });
	});
	test("spawning disabled, an empty section, a missing section or no built-in task tool are unavailable, never guessed", () => {
		expect(availableAgents([task("# Available Agents\nAgent spawning is currently disabled.\n")]).kind).toBe("unavailable");
		expect(availableAgents([task("# Available Agents\n\n# Next")]).kind).toBe("unavailable");
		expect(availableAgents([task("- `task:mid`: no heading")]).kind).toBe("unavailable");
		expect(availableAgents([task(rendered, "extension")]).kind).toBe("unavailable");
		expect(availableAgents([]).kind).toBe("unavailable");
	});
});
