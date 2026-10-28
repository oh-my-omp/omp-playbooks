---
title: File format and block kinds
when: before writing a Playbook YAML file or adding a block
---
# Playbook file format

A Playbook is a YAML prompt document the user and you edit together; a document service shows it in a Tern pane beside this session, one card per block.

`title: <text>` and `blocks:`, a list of blocks of two kinds. Write each text field as a YAML block scalar (`|`).

- **Task block** `{id: b<n>, title, body, status: todo}`: a prompt that runs. `body` is Markdown and may reference other blocks and files (`tool://playbook_open/references`).
- **Orchestration block**: a task block whose body is exactly one ```` ```js ```` or ```` ```py ```` fenced block; it runs as code (`tool://playbook_open/execution`).
- **Untracked task block**: write `task: false` instead of `status` on a block that is not a piece of work (an overview, shared rules others reference). It has no status or report, cannot be launched and is left out of the done count.
- **Design block** `{id: b<n>, title, requirement, design, status: todo}`: one design or business unit, status `todo` or `done`. `requirement` is the person's, written only by them. `design` is yours, written in answer-me-with-html draft format: optional `---` frontmatter (`template` sheet|doc, `title`, `subtitle`, `cols`); a lead; `## A Panel title {span=2 meta="…"}` panels; Markdown with tables (status words ok/no/warn), `$…$`/`$$` math and `![alt](path)` images; fences `flow`, `er`, `sequence`, `tree`, `timeline`, `limits`, `annot`, `kv`, `callout`, `slot`, `diff`, `html`, `svg`, and code blocks with `src=`/`lines=`/`hl=`; `flow`/`er`/`tree` lines may start with `+ ` `- ` `~ ` change markers. It is drawn in the pane and never expands `((…))`. Design blocks cannot be launched.

Task bodies use the same panels and fences and are drawn the same way. Every card's text follows the outline in `tool://playbook_open/outline`.

`status` is `todo`, `running` or `done`. The subagent that runs a block writes `status: running` when it starts and `status: done` with a `report: |` completion report when it finishes (its launch prompt tells it how), so you never write them for it.
