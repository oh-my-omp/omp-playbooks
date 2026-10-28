---
title: Running blocks from eval
when: before running a block with a subagent, or answering a launch or stop request
---
# Running blocks

Order: write the YAML, `playbook_open` it, `playbook_read`/`playbook_edit` blocks, then run blocks from eval.

- **Prompt block:** `var worker = await playbook.agent({ blocks: ["b2"] })` returns once the subagent is started and bound. After it finishes, `await playbook.result(worker)` in a later eval records its final message on the block and closes the Launch. Or, in one blocking call, `await playbook.run({ blocks: ["b2"] })`.
- **Orchestration block:** `playbook_launch {op: "launch"}`, then an eval whose whole code is `await playbook.exec("l<n>")`.

In eval, `playbook` is provided automatically: the extension adds the `var playbook = …` first line to any JS cell that uses it, so do not write that line yourself.

| Helper | Behavior |
|---|---|
| `playbook.agent({run?, blocks, agent?, isolated?, label?, schema?})` | → `{launch, blocks, id, handle}` without waiting. Keep it in a top-level `var` and wait with the top-level `wait` tool, so panel notices (stop requests, revision requests, block changes) still reach you while the subagent works |
| `playbook.result(worker, {block?, close?})` | records the subagent's final message (or failure) on the given block, by default the Launch's only block, and closes the Launch that `playbook.agent` created |
| `playbook.run({...})` | `agent` + `result` in one blocking call |
| `playbook.spawn(launch, {...})` | adds a subagent to an open prompt Launch using its current baseline (after rebase, the rebased text); its result does not close the shared Launch unless `{close: true}` |
| `playbook.stop(launch)` | cancels every subagent this session started for that Launch and sets the Launch's running blocks back to `todo`; the pending `playbook.result` then records the failure and closes the Launch |
| `playbook.post({run?, kind, text, block?, launch?})`, `playbook.timeline({run?, after?})`, `playbook.read({run?, block?})` | timeline and block access |

Options left out come from the block's preset `agent`/`isolated`; pass `agent: "<name>"` (for example `"task:mid"`) when the default subagent is disabled and the block sets none. Inside an orchestration Launch, `playbook.context` is `{doc, run, launch}`.

Launch requests the person makes while you are in a turn (waiting included) are held and reach you together as one notice when the turn ends.
