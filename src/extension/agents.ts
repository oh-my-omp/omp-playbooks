// The subagent types this omp session can launch. omp exposes no list to extensions; the built-in task
// tool's description is the one public place where the session renders it, already filtered by the
// session's disabled agents, spawn policy and plan mode. This module reads that rendering and nothing
// else: when the format is not there, the answer is "unavailable", never a guess. omp still decides
// again at launch.
import type { AgentAnswer } from "../domain/protocol";

/** What `pi.getAllTools()` returns for a tool, as far as this reader needs. */
export interface ToolDescription {
	readonly name: string;
	readonly description: string;
	readonly sourceInfo: { readonly source: string };
}

const HEADING = "# Available Agents";

/** The agent names under the built-in task tool's `# Available Agents` heading. */
export function availableAgents(tools: readonly ToolDescription[]): AgentAnswer {
	const task = tools.filter(tool => tool.name === "task" && tool.sourceInfo.source === "builtin");
	if (task.length !== 1) return { kind: "unavailable", reason: "本会话没有内置的 task 工具，无法列出 subagent" };
	const lines = task[0]!.description.split("\n");
	const start = lines.findIndex(line => line.trim() === HEADING);
	if (start < 0) return { kind: "unavailable", reason: "omp 的 task 工具说明里没有 Available Agents 一节，无法列出 subagent" };
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#\s/.test(line)) break;
		if (line.trim() === "Agent spawning is currently disabled.") return { kind: "unavailable", reason: "本会话禁止启动 subagent" };
		const name = /^- `([^`]+)`/.exec(line)?.[1]?.trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names.length > 0 ? { kind: "listed", names } : { kind: "unavailable", reason: "本会话没有可启动的 subagent" };
}
