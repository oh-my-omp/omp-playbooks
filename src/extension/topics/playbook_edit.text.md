---
title: Changing a block's text
when: before op write, replace or panel
---
# Changing text

Your field is a task block's `body` or a design block's `design`. A design's `requirement` is the person's and never yours to change.

| op | Arguments | Effect |
|---|---|---|
| `write` | `{block, text}` | replaces your field whole |
| `replace` | `{block, find, replace}` | replaces `find`, which must occur exactly once in your field |
| `panel` | `{block, panel, text}` | replaces one panel addressed by the letter ID its heading writes; `text` is that whole panel, starting with `## <ID> Title` |

Write new text in the session's language (`tool://playbook_open/language`) and keep the Where/What/How outline (`tool://playbook_open/outline`). Text already in the file stays as written.
