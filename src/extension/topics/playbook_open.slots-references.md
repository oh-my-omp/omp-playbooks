---
title: Slots and references
when: before writing a {{…}} slot or a ((…)) reference to a block, result, file or GitHub issue
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

# References

A task body pulls other content in with `((target))` or `((target | selector, selector))`. A reference fits on one line; references in inline code or code fences are not expanded.

| Target | Example | Compiles to |
|---|---|---|
| Design block | `((b3))` | its requirement and design |
| Design part | `((b3 \| requirement))`, `((b3 \| design))`, `((b3 \| panel(A)))` | that part; `A` is a letter ID written in the panel's heading |
| Task block | `((b1))` | its body, expanded recursively; `lines(1..3)`, `section("Heading")` select |
| Block result | `((b3.result))` | the latest result recorded on that block |
| File | `((file:path \| lines(1..40)))` | text of a file relative to the Playbook |
| GitHub | `((https://github.com/o/r/issues/1))` | the issue/PR title, body or comments |

Write letter IDs on every panel a task may reference.

The pane draws every reference as a link named by its target (a block's title, an issue as `owner/repo#N`, a file by its path). `as("<name>")` in the expression names the link instead, as in `((b3 | as("<name>"), panel(A)))`; it never changes the compiled prompt.
