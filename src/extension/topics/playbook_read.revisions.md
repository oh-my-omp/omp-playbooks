---
title: Change requests
when: when a revision_requested notice arrives, or before revising a design
---
# Change requests

`playbook_read {op: "revisions", block?, after?}` returns the person's change requests for design blocks as `{revisions: [{seq, at, block, prompt}]}`. They are not part of a normal read.

- `block` limits the list to one design block; `after` returns only requests with a larger `seq`.
- Add `run` to read a Run's requests; a new Run does not inherit the Playbook's.
- A request asks you to revise that block's `design` (`playbook_edit`); a slot pick in a design arrives the same way.
