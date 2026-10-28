---
title: Timeline records and update reminders
when: before op post or snooze
---
# Timeline

The execution log of the Playbook, or of Run `run`.

| op | Arguments | Effect |
|---|---|---|
| `read` | `{run?, after?}` | entries after a sequence number |
| `post` | `{run?, kind, text, block?, launch?, next?, quote?}` | writes a record |
| `snooze` | `{run, after}` | postpones a Run's update reminder by `after` seconds |

- `kind` is `update`, `result`, `failure` or `retrospective`. A `result` associated with a `block` is what `((b<n>.result))` reads.
- `next` is the seconds until the next update, only for a Run's `update`. A `retrospective` is only allowed in a finished Run.
- Posting a result or failure does not close a Launch.
