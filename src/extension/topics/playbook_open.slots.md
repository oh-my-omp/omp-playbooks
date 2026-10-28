---
title: Slots
when: before writing a value the person picks, or a {{name}} or {{bN.name}} use
---
# Slots

A slot is a value the person picks. A ```` ```slot <name> ```` fence declares it:

```text
= <current value>
* <recommended option> | note
- <option> | note
~ <option offered earlier> | note
```

Write `{{<name>}}` in the same text (prose, list items, kv values, table cells, flow node labels) where the value goes. In any other block write `{{b<n>.<name>}}` for slot `<name>` declared in block `b<n>`: declare a choice once and use it everywhere this way.

- The pane draws each use as the current value the person can switch; a pick is written where the slot is declared (a design's slot goes to you as a change request).
- Compiling replaces each use with the value and drops the fence. A `{{b<n>.<name>}}` whose block declares no such slot fails compilation (`UnknownSlot`).
- A slot's own name never starts with `b<n>.`.
- Uses inside inline code or code fences stay as written.
