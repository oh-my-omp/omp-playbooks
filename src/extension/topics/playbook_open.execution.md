---
title: Running blocks, launch lifecycle and language
when: before running a block, answering a launch/stop/block_changed notice, or writing new Playbook text
---
# Running blocks

Order: write the YAML, open it with `playbook_open`, inspect via `playbook://` URLs and edit via `playbook_edit_content` / `playbook_edit_structure`, then run blocks from eval.

- **Prompt block:** `var worker = await playbook.agent({ blocks: ["b2"] })` returns once the subagent is started and bound. After it finishes, `await playbook.result(worker)` in a later eval records its final message on the block and closes the Launch. Or, in one blocking call, `await playbook.run({ blocks: ["b2"] })`.
- **Orchestration block:** `playbook_launch --json '{"blocks":["b<n>"]}'`, then an eval whose whole code is `await playbook.exec("l<n>")`.

In eval, `playbook` is provided automatically: the extension adds the `var playbook = …` first line to any JS cell that uses it, so do not write that line yourself.

| Helper | Behavior |
|---|---|
| `playbook.agent` | starts and binds the subagent, returns `{launch, blocks, id, handle}` without waiting. Keep it in a top-level `var` and wait with the top-level `wait` tool, so panel notices (stop requests, revision requests, block changes) still reach you while the subagent works |
| `playbook.result` | records the subagent's final message (or failure) on the given block, by default the Launch's only block, and closes the Launch that `playbook.agent` created |
| `playbook.run` | `agent` + `result` in one blocking call |
| `playbook.spawn` | adds a subagent to an open prompt Launch using its current baseline (after rebase, the rebased text); its result does not close the shared Launch unless `close: true` |
| `playbook.stop` | cancels every subagent this session started for that Launch and sets the Launch's running blocks back to `todo`; the pending `playbook.result` then records the failure and closes the Launch |
| `playbook.post`, `playbook.timeline`, `playbook.read` | timeline and block access |

Options left out come from the block's preset `agent`/`isolated`; pass `agent: "<name>"` (for example `"task:mid"`) when the default subagent is disabled and the block sets none. Inside an orchestration Launch, `playbook.context` names the current doc, run and launch.

Launch requests the person makes while you are in a turn (waiting included) are held and reach you together as one notice when the turn ends.

# Launch lifecycle and `block_changed`

A Launch freezes the compiled prompt of blocks of the Playbook (or Run) that subagents work from; a prompt Launch's text ends with instructions for the subagent to write each block's status and completion report into the file.

The person's later edits to a Launch's blocks arrive as `block_changed` notices with a diff against the current baseline. A notice never changes a running subagent's prompt: tell the subagent, rearrange the work, or accept the updated text as the new baseline with `playbook_launch` (`rebase_launch`), which subsequent `playbook.spawn` and `playbook.exec` calls use. Closing a Launch (`close_launch`) ends tracking without cancelling any running subagent.
