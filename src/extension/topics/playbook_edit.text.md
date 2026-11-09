---
title: Changing a block's text
when: before op write, replace or panel
---
# Changing text

Your field is a task block's `body` or a design block's `design`. A design's `requirement` is the person's and never yours to change.

| op | Effect |
|---|---|
| `write` | replaces your field whole |
| `replace` | replaces `find`, which must occur exactly once in your field |
| `panel` | replaces one panel addressed by the letter ID its heading writes; `text` is that whole panel, starting with `## <ID> Title` |

Write new text in the session's language (`xd://playbook_open/language`) and keep the Where/What/How outline (`xd://playbook_open/outline`). Text already in the file stays as written.
