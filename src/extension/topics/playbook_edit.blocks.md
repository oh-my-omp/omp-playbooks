---
title: Adding, removing and ordering blocks
when: before op insert, insert_design, delete, move or title
---
# Blocks

| op | Arguments | Effect |
|---|---|---|
| `insert` | `{after?, title, body, agent?, isolated?}` | adds a task block → `{block}` |
| `insert_design` | `{after?, title, design}` | adds a design block whose requirement starts empty (the person writes it) → `{block}` |
| `delete` | `{block}` | removes a block |
| `move` | `{block, after}` | reorders; `after` is a block id, or `null` for the top |
| `title` | `{block, value}` | renames a block |

New blocks start `todo`. Write their text in the session's language with the Where/What/How outline.
