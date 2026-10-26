// The implicit end of every prompt Launch: the subagent that runs a block writes the block's status and
// completion report into the Playbook file itself, so its progress never depends on the coordinator.
import { tr } from "../i18n";
/**
 * Instructions appended to a prompt Launch's text. `file` is the document the Launch belongs to (the
 * template or a Run file); `blocks` are the Launch's tracked roots.
 */
export function launchFooter(file: string, blocks: readonly { readonly id: string; readonly title: string }[]): string {
	const names = blocks.map(block => `${block.id}「${block.title.trim() || "未命名"}」`).join("、");
	const englishNames = blocks.map(block => `${block.id} “${block.title.trim() || "Unnamed"}”`).join(", ");
	return tr([
		"---",
		"Execution record requirements (from the Playbook; not part of the task content above)",
		`You are executing blocks ${englishNames} in Playbook file ${file}.`,
		"1. Before starting work, use an editing tool to change these blocks' `status:` to `status: running` in that file.",
		"2. When work is complete, in the same edit change each block's `status:` to `done` and write a completion report below it:",
		"```yaml",
		"    status: done",
		"    report: |",
		"      - One completed item per line: what was actually done and where it was changed",
		"      - The last line must state the verification: what was run and what result was observed",
		"```",
		"   Write only what actually happened in the report. If the work could not be completed, change `status:` back to `todo` and state how far you got and what blocked you in the report.",
		"3. Change only the `status` and `report` of these blocks; keep YAML indentation and all other content unchanged.",
	].join("\n"), [
		"---",
		"执行记录要求（来自 Playbook，不属于上面的任务内容）",
		`你执行的是 Playbook 文件 ${file} 中的块 ${names}。`,
		"1. 开始工作前，用编辑工具把这些块在该文件里的 `status:` 改为 `status: running`。",
		"2. 工作结束后，在同一次编辑里把每个块的 `status:` 改为 `done`，并在它下面写入完成报告：",
		"```yaml",
		"    status: done",
		"    report: |",
		"      - 每行一件已完成的事：实际做了什么、改了哪里",
		"      - 最后一行写验证：运行了什么、看到了什么结果",
		"```",
		"   报告只写真实发生的事。没能完成时把 `status:` 改回 `todo`，在 report 里写明做到哪一步、卡在哪里。",
		"3. 只改这些块的 `status` 与 `report`；保持 YAML 的缩进与其他内容不变。",
	].join("\n"));
}
