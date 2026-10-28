---
title: Launch lifecycle
when: before op launch, bind, info, rebase or close, or after a block_changed notice
---
# Launches

A Launch is the frozen prompt of blocks of the Playbook (or of Run `run`) that subagents work from. A prompt Launch's text ends with the instructions for its subagent to write the blocks' status and report into the file.

| op | Arguments | Effect |
|---|---|---|
| `launch` | `{run?, blocks}` | → `{launch, kind, text, agent?, isolated?}`; starts no subagent. `agent`/`isolated` appear when every block presets the same value |
| `bind` | `{launch, agent}` | records which subagent works from it |
| `info` | `{launch}` | → the full record |
| `rebase` | `{launch}` | accepts the current text as the new baseline, which `playbook.spawn` and `playbook.exec` then use |
| `close` | `{launch}` | ends it; it does not cancel a subagent |

Prefer `playbook.agent`/`playbook.run` in eval (`tool://playbook_open/execution`): they also start and bind the subagent, apply the blocks' contract, and `playbook.result` closes the Launch `playbook.agent` created.

The person's later edits to a Launch's blocks arrive as `block_changed` notices. A notice never changes a running subagent's prompt: tell the subagent, rearrange the work, or `rebase`.
