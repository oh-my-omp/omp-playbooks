---
title: References
when: before writing a ((…)) reference to a block, result, file or GitHub issue
---
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
