---
title: Where/What/How outline
when: before writing a task body or a design, or replacing a panel
---
# Where/What/How

Every card's text is written for the person: each task body (tracked or `task: false`) and each design has panels whose titles start with a role word. The role word stays English whatever language the rest is in.

| Panel | What it says |
|---|---|
| `## A Where · <title>` | object, location, scope, current state, evidence |
| `## B What · <title>` | goal, decision, expected result, boundaries |
| `## C How · <title>` | steps, verification, failure handling, rollback |

Every role has content and they come in that order. A role may span several panels (`## D How · <title>`); a lead or panels of no role may sit anywhere. Write a letter ID on every panel a task may reference (`((b3 | panel(A)))`).

An orchestration block is code and is exempt. The person's `requirement` and completion reports are free-form. `playbook_check` reports a text that breaks the outline as `outline`, and the pane lists what is missing.
