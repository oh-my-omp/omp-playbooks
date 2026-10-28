---
title: Status, tracking and execution contract
when: before op status, task, agent or isolated
---
# Status and contract

| op | Arguments | Effect |
|---|---|---|
| `status` | `{block, value: todo\|running\|done}` | sets a block's status. The subagent that runs a block writes its own status; set it yourself only to correct one |
| `task` | `{block, value}` | `false` makes a task block untracked (no status, not launchable, not counted); `true` tracks it again from `todo` |
| `agent` | `{block, value: <agent name> \| null}` | sets or clears the subagent `playbook.agent`/`playbook.run` use for this task block by default |
| `isolated` | `{block, value: boolean \| null}` | sets or clears whether that subagent works in its own worktree |

`agent` and `isolated` apply to task blocks only; design blocks have none. Changing them does not change the compiled text.
