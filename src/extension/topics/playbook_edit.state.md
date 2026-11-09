---
title: Status, tracking and execution contract
when: before op status, task, agent or isolated
---
# Status and contract

| op | Effect |
|---|---|
| `status` | sets a block's status. The subagent that runs a block writes its own status; set it yourself only to correct one |
| `task` | `tracked: false` makes a task block untracked (no status, not launchable, not counted); `true` tracks it again from `todo` |
| `agent` | sets or clears (`clear`) the subagent `playbook.agent`/`playbook.run` use for this task block by default |
| `isolated` | sets or clears (`isolation`) whether that subagent works in its own worktree |

`agent` and `isolated` apply to task blocks only; design blocks have none. Changing them does not change the compiled text.
