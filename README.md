# omp-playbooks

English | [简体中文](README.zh-CN.md)

omp-playbooks keeps **design, execution prompts and orchestration code** in one Playbook that people and agents edit together. It consists of an omp extension and a Tern document service: the main session connects to the document service through the `playbook_*` tools, while a person reads the blocks as cards, edits them in place and asks for launches and design changes in the pane beside it.

Design and execution are separate. A design block covers one design or business unit; an execution block composes the requirements, design panels, context and earlier results it needs through references. One execution block can reference several design blocks; designs and tasks do not have to map one to one.

The Playbook file also carries its own execution state: every tracked block has a `status` (`todo`, `running`, `done`), and the subagent that executes a block writes that status and a completion `report` into the file itself.

| Party | Responsible here for |
|---|---|
| Person | Editing titles, execution bodies, requirements and picks in place; reading the rendered design; asking for design changes, launches and stops; ticking blocks done |
| omp main session (coordinator) | Revising designs itself; calling tools to compile prompts and create Launches; deciding how to launch and orchestrate subagents, stopping them on request, handling change notices and recording results |
| Document service | Storing the document, Runs, Launches and records; resolving references; drawing the pane and design components; locking, running deterministic checks and notifying the coordinator |
| Subagent | Executing the compiled prompt the coordinator hands it, then writing its blocks' `status` and `report` into the Playbook file; it owns none of this Playbook's tools or UI |

**Buttons are requests, not automatic executors.** "启动" (Launch) notifies the main session to execute; "打断执行" (stop) asks it to cancel the worker; a change request or a pick on a design hands the change to the main session. The extension never revises a design, starts or cancels a worker, or accepts a result on its own because a notice arrived.

## Install and open

You need [Bun](https://bun.sh), omp and Tern. The process that loads the extension must find `tern` on `PATH`; the environment that starts the document service must be able to run `bun`. GitHub issue/PR references also need an authenticated `gh`.

The repository is [oh-my-omp/omp-playbooks](https://github.com/oh-my-omp/omp-playbooks); the installed omp package name and the Tern plugin ID are both `omp-playbooks`, which the upgrade and uninstall commands below use.

```sh
omp plugin install 'https://github.com/oh-my-omp/omp-playbooks.git#main'
```

When the extension loads it checks for Tern and links the package's `tern-plugin/` into Tern; it skips this when the same directory is already linked. The link points at the omp install directory itself. The Tern daemon reloads plugin files edited in place, but an upgrade replaces the whole install directory, which leaves the daemon on a missing link target or an old version. The extension therefore compares the version in `tern-plugin/plugin.toml` with the version the daemon loaded, runs `tern plugin reload` when they differ, and reports the outcome in the main session. If the versions still differ after the reload it only warns and does not abort the install; the next extension load compares again.

**Pulling the repository or restarting a session does not update the installed plugin copy.** If an older version is installed, update it first:

```sh
omp plugin upgrade omp-playbooks
```

After updating, start a new omp session; running extensions and document services are not hot-swapped. Wind down any work in progress, then close the old document-service pane and let the new session open it again. `playbook_open` reuses an existing service, so it cannot be used to force a switch to the new one. After every push to `main`, CI increments the last version component in both `package.json` and `tern-plugin/plugin.toml`, so the version tells old and new code apart.

To uninstall, remove both sides:

```sh
omp plugin uninstall omp-playbooks
tern plugin unlink omp-playbooks
```

There are three ways to open a file:

- **From the main session:** write the YAML file first, then call `playbook_open {doc: "/absolute/path/playbook.yaml"}`. With no service running, the extension starts one to the right of the current omp pane; this requires omp to run in a Tern pane managed by the session daemon, with `TERN_PANE` in its environment. With a service already running it only connects: it opens no extra pane and does not move focus.
- **From Tern:** focus a `.yaml` or `.yml` file pane and choose "Playbook: 打开" in the command palette. It shows the existing service, or starts one beside the pane. This does not start omp or set up a coordinator connection.
- **Starting the service from source:** install dependencies in the repository, then run the commands below in a Tern pane. The main session still has to call `playbook_open` to receive requests.

```sh
bun install
bun src/service/main.ts /absolute/path/playbook.yaml
```

One file has one live service and one coordinator connection. Another main session gets `Busy` while the original coordinator is still connected. When the original session ends, the document pane stays and its status strip shows "协调者离线 · 选择协调者" (coordinator offline · choose a coordinator); a new session can take over, or the person picks one from the pane (see [Pane layout](#pane-layout)). An omp without `TERN_PANE` can still connect to a service that is **already running**, but cannot create a pane beside itself from there.

Main-session commands:

- `/playbook-show [file path]`: jump to the pane of a connected document.
- `/playbook-add [file path]`: pick recent session messages, the Playbook itself or a Run, a record kind and optionally a block, and add them to that execution log.

These commands and the `playbook_*` tools are registered only in the main session; subagents do not see them.

## The file and its blocks

Save the following as `playbook.yaml` and it can be opened; it needs no network, external files or `am` CLI:

````yaml
title: 缓存方案
blocks:
  - id: b1
    title: 执行通则
    body: |
      ## A Where · 适用范围
      本 Playbook 的所有执行块。

      ## B What · 约束
      只读检查，不修改任何文件。

      ## C How · 做法
      发现需要改动时停下，把要改什么写进完成报告。
    task: false
  - id: b2
    title: 缓存设计
    requirement: |
      数据重启后不能丢。请求路径要简单。
    design: |
      ## A Where · 请求路径
      ```flow LR
      Client -> Gateway -> [(Cache)]: read
      ```

      ## B What · 结论
      ```callout ok 使用持久化缓存
      明确持久化策略，不把“用了 Redis”当成数据不会丢的保证。
      ```

      ## C How · 落地与验证
      开启 AOF 持久化；重启缓存实例后读回重启前写入的键。
    status: todo
  - id: b3
    title: 检查方案
    body: |
      ## A Where · 检查对象
      ((b2 | requirement, panel(B)))

      ## B What · 产出
      用 {{检查方式}} 列出三个需要验证的边界。

      ```slot 检查方式
      = 清单
      * 清单 | 每条一行
      - 表格 | 边界、风险、验证方法三列
      ```

      ## C How · 做法
      ((b1))
    status: todo
````

| Block | File fields | Purpose and where it is edited |
|---|---|---|
| Design block | `requirement`, `design`, `status` | A person edits the requirement in place; the main session edits the rendered design. Cannot be launched |
| Execution block | `body`, `status`; optional `report`, `agent`, `isolated` | A person or the main session edits the body; it can be referenced as context or launched. `agent` and `isolated` are its execution contract: the agent its subagent uses by default, and whether that worker gets its own worktree |
| Orchestration block | Also `body`, whose whole content is one `js` or `py` code fence | Orchestration code run by the coordinator, not treated as an ordinary worker prompt; it can only be launched alone |
| Untracked execution block | `body`, `task: false`; optional `agent`, `isolated` | Shared context such as general rules: it has no status or report, is not counted and cannot be launched, but can be referenced |

Every block needs `id`, `title` and the matching content fields, plus either `status` or `task: false`. IDs are positive integers such as `b1`, `b2` and must be unique. The YAML **has no `kind`**; the type follows from the fields. Mixing `body` with `requirement`/`design`, missing fields and unknown fields are rejected. `agent` (a string that is not blank after trimming) and `isolated` (a boolean) are allowed only on execution blocks; when unset they do not appear in the file. `task` may only be `false`, only on an execution block, and such a block has no `status` or `report`. A design block is never `running` and has no `report`. Use `|` for multi-line content; an empty requirement or design is an empty string or an empty block scalar.

`status` is execution state, not design approval, and is never derived from checks, subagent return values or Launch records. `report` is the completion report: the subagent writes it when it sets its block to `done`, and the pane shows it read-only. Files that still use the old `done:` field are rejected; replace `done: false` with `status: todo` and `done: true` with `status: done`.

### Where/What/How

A card's text is written for a person, so every task body (tracked or `task: false`) and every design follows Where/What/How: `## ` panels whose titles start with the role word.

| Role | Heading | What its panels say |
|---|---|---|
| Where | `## A Where · 现状` | object, location, scope, current state, evidence |
| What | `## B What · 决定` | goal, decision, expected result, boundaries |
| How | `## C How · 处置` | steps, verification, failure handling, rollback |

Every role has content and the roles come in that order. A role may span several panels (`## D How · 验收与回退`); a lead and panels of no role may sit anywhere. The role word is case-sensitive and ends at the title's end, a space or a separator (`·`, `:`, `：`, `|`, `-`, `—`); a role panel may not be `bare`, since its heading would not show. An empty text counts as not yet written. An orchestration block is code and is exempt; so are the person's `requirement` and completion reports. An open card lists what breaks the outline under its text, and `playbook_check` reports it as `outline`; neither blocks a launch.

### Pane layout

The pane shows the Playbook file itself in one column; Runs are not shown there. The document title sits on top (double-click to edit), followed by one card per block in file order, and a dock at the bottom.

- **Card header:** a number (`--` for untracked blocks, then `01`, `02`… for tracked ones), the title, a status icon (empty ring `todo`, spinner `running`, check `done`) and a chevron. Clicking the title or the chevron opens or folds the card; double-clicking the title edits it.
- **Status icon:** clicking it toggles `done` and `todo` and notifies the coordinator with `status_changed`. Ticking a block done does not touch its report.
- **Open card:** "⋯" opens a menu with "粘贴剪贴板图片" (paste clipboard image) and "删除此块" (delete this block). The body is drawn with the components below. An execution block's foot shows "SUBAGENT" (its `agent`) and "独立 WORKTREE" (double-click toggles `isolated`), then the launch button. A `done` block shows a folded "完成报告" (completion report) instead; click to unfold.
- **SUBAGENT dropdown:** clicking it lists "默认" (unset: omp's default subagent) and the subagent types the coordinator's omp session can launch right now; picking one writes `agent`. The list is asked from the coordinator each time the dropdown opens: the extension reads it from the session's built-in `task` tool, which has already removed disabled agents and applied the spawn policy. Offline, or when the session cannot list them, the dropdown says so and offers only "默认". A saved name the session no longer lists stays shown as the current setting and is never rewritten for you; omp still checks the name again at launch.
- **Launch button:** "启动" (Launch) sends `launch_requested` for this block; until the coordinator creates a Launch from it, the button reads "已请求启动" (launch requested) and cannot be clicked again. While the block is `running` the button reads "打断执行" (stop): with an open Launch it sends `stop_requested` to the coordinator; with none, nothing is executing and the block simply goes back to `todo`.
- **Launching several blocks:** ⌘-click card titles to select tracked execution blocks; the dock shows "一起启动 N 块" (launch N together) and "取消" (clear). The blocks are combined into one Launch in document order; an orchestration block can only be launched alone.
- **Dock status strip:** "协调者在线" (coordinator online; click to focus the coordinator's pane) or "协调者离线 · 选择协调者", and "N / M 已完成" (done count over tracked blocks).
- **Choosing a coordinator:** while offline, clicking the status opens a list of the omp panes in this Tern window (every session the window holds), asked of Tern (`tern inspect`) each time it opens. A pane whose omp session runs this version of omp-playbooks can be chosen; other omp panes are listed but disabled, and an omp session that was already running before omp-playbooks was upgraded has to be restarted first. Choosing one makes that session connect to this Playbook right away, through the socket the extension keeps for its pane, exactly as `playbook_open` would, and posts a notice in its transcript without starting a turn; a session may coordinate several Playbooks. Then this Playbook pane moves to become the right half of that omp pane (`tern move … right-of …`), however deeply either was nested. "新建会话" (new session) opens omp in a new pane on the left of the Playbook pane, started with an initialization prompt telling it to `playbook_open` this file; the status turns online when it has done so. A failed connection and a failed move are reported separately: if the connection fails nothing moves; if only the move fails, the coordinator is still online.

Requests that need the coordinator (launch, stop with an open Launch, change requests, picks on a design) are refused with a notice while it is offline.

### How a person edits

Every edit is in place: double-click the text and edit it. `Enter`, `Esc`, the "退出编辑" (done editing) button beside the field, or any other action commits; `Shift+Enter` is a new line in multi-line text. An edit is written only when the field still holds the text you started from; if the coordinator or the file changed it meanwhile, the edit is refused with a notice and you edit the latest content again.

| Part | What a person can do |
|---|---|
| Execution body, requirement | Double-click a paragraph, heading, list item, `//` comment, `kv` key or value, panel heading or callout text to edit just that part. Components that are not edited part by part (code, tables, non-chain `flow`, `er`, …) are edited as their whole fence source. An empty field shows "// 双击写正文" or "// 双击写需求" (double-click to write) |
| Numbered list in a body | Click an item's grip to pick it up, then click the row where it goes; the list is renumbered. Clicking the grip again puts it back. Tern has no drag and drop, so this is pick-and-place |
| Chain `flow` in a body | A flow that is one path (`A -> B -> C`, no groups or change markers) is drawn as a column of nodes. Click a node to show "+ 下方节点" (add below) and "删除" (delete); double-click to rename. A flow keeps at least two nodes; other flows stay drawings |
| Slot | A `{{name}}` shows its current value; click it to pick another option or type your own. In an execution body or a requirement the pick is written to the slot's `=` line; in a design it is sent as a change request |
| Image | `Ctrl+V` in the pane (or "⋯ → 粘贴剪贴板图片") reads the image on the system clipboard, keeps its bytes unchanged as `<file>.assets/<sha256>.<ext>` next to the Playbook, and writes `![图片](<file>.assets/…)` on a line of its own: at the caret of the multi-line text being edited, otherwise at the end of the open card's body (a design card: its requirement). Change the caption like any text. PNG, JPEG, GIF, WebP and AVIF up to 5 MiB; with no image on the clipboard nothing is written and a notice says so |
| Design | Read-only for a person. Double-click the "//" line under the design, write what should change and how, and `Enter` sends it as a change request; the main session revises `design` and does not touch `requirement` |

Editing a block that the coordinator holds takes it back: the coordinator's lock is released and it receives `interrupted`.

A submitted change request goes into an append-only log. It records **the person's change requests**, not design snapshots, design diffs or AI replies; an ordinary block read does not include it.

```json
{"op":"revisions","block":"b2","after":0}
```

The above are `playbook_read` arguments; querying a Run's log also needs `run`. `after` is a record sequence number; records with a larger number are returned. A new Run does not inherit the template's change history.

## Execution: the Playbook, Runs, Launches

| Object | Start and end | What never happens automatically |
|---|---|---|
| The Playbook (template) | The YAML file. It has its own execution log and Launches; the pane's launches run it directly | Launching changes nothing but the blocks the subagent itself marks |
| Run | `playbook_run start` copies the Playbook into a separate file, setting every tracked block to `status: todo` without a report. After it finishes, its blocks can no longer be edited through tools | Starting a Run starts no agent; finishing a Run does not require every block to be done; changing the Playbook does not update existing Runs |
| Launch | Compiles execution blocks of the Playbook or of a Run, freezes the prompt/orchestration code and creates a record; closed explicitly, by `playbook.result` when it finishes up, or when its Run finishes | `launch`/`bind` start no worker; writing a result with `playbook_timeline` does not close the Launch; a close record does not cancel the worker |

Runs are for repeating the same Playbook with fresh state through the coordinator tools; pass the returned Run ID (for example `r1`) as `run`. Operations without `run` act on the Playbook file itself.

Every prompt Launch ends with execution-record instructions the document service appends after the compiled prompt: the subagent is told which file and blocks it is executing, to set their `status:` to `running` before it starts, and when it finishes to set `status: done` and write a `report: |` with one line per thing it actually did and a last line on verification; if it cannot finish it sets `todo` and reports where it stopped. It changes only those fields. Orchestration Launches get no such text: the orchestration code or the coordinator sets status there.

A subagent receives the frozen text, not the UI, a live design page or any implicit Playbook context.

### Stopping

"打断执行" sends `stop_requested` with the block's open Launches and their bound agents. The coordinator runs `await playbook.stop("l3")` in JS eval: it cancels every subagent this session started for that Launch with `playbook.agent`/`playbook.spawn` and sets the Launch's blocks that are still `running` back to `todo`; a pending `playbook.result` then records the failure and closes the Launch. A worker started some other way is stopped by the coordinator its own way, followed by `playbook_edit {op:"status", block, value:"todo"}`.

### Changes during execution

The document service recompiles the affected active Launches and compares them with their baseline; when the compiled text changes or compilation fails, it notifies the coordinator after about two seconds of coalescing. A person's content edits, edits on disk and the coordinator's design revisions can all trigger the notice; titles, `status`, `report` and the coordinator's own edits to an execution body do not trigger the same content-change notice. Active means not closed and belonging to the currently connected coordinator session; a new session that takes over the document does not take over the old session's Launches.

The notice does not change a running worker's prompt. The coordinator decides whether to tell the worker, rearrange the work, or call `playbook_launch rebase` to accept the current compilation as the new baseline. `rebase` appends the current compilation as the new baseline and keeps the originally frozen snapshot in the Launch record; a later `playbook.spawn`, and `playbook.exec` of an orchestration block, use the latest baseline. A closed Launch can no longer be bound or rebased.

### Records and files

For `playbook.yaml`:

| File | Content |
|---|---|
| `playbook.yaml` | The Playbook: blocks, status and reports |
| `playbook.yaml.log.jsonl` | The Playbook's own timeline and Launch records |
| `playbook.yaml.revisions.jsonl` | The Playbook's change-request history |
| `playbook.yaml.pb.jsonl` | Service ID allocation records |
| `playbook.runs/r1.yaml` | The Run's blocks and run metadata |
| `playbook.runs/r1.jsonl` | The Run's timeline and Launch records |
| `playbook.runs/r1.revisions.jsonl` | The Run's change-request history |

For a `.yml` file the Run directory keeps the suffix, for example `example.yml.runs/`. Finishing a Run closes its Launch records, releases locks and saves the finish time; it does not write back to the Playbook and does not replace stopping agents that are still running. Logs that still contain the old `done_changed` record are rejected.

The timeline accepts `update`, `result`, `failure` and `retrospective`. A retrospective is written only after a Run finishes; `update_every` and `next` apply only to Runs. Both are positive integer seconds; when they come due it is only a notice, and no update is generated automatically. A result can be read through that block's `.result` reference only when it is associated with a `block`.

The service checks the file on disk about once a second and reads it again right before writing back, so status and report changes a subagent writes are merged with edits made in the pane or by the coordinator rather than overwritten; committed edits are written back about a second later. Direct edits to the YAML content fields are loaded too, designs included; the editing split in the pane is not a file-system permission. Invalid YAML shows the parse error and keeps the last valid content; write-back resumes once the file is valid again. Blocks of a finished Run are protected only on the tool paths; the files on disk are not immutable.

## References and compilation

Execution bodies use `((target))` or `((target | selector, selector))`. Several selected results are joined with blank lines in the order written. A reference must fit on one line; references inside inline code or code fences are not expanded. Slots are resolved when compiling: every `{{name}}` of a declared slot becomes its current value and the `slot` fence is dropped.

| Target | Example | What it compiles to |
|---|---|---|
| Design block | `((b2))` | The raw requirement and design, wrapped in `<requirement>` and `<design>`; an empty requirement emits no `<requirement>` |
| Design field/panel | `((b2 \| requirement, panel(B)))` | The raw requirement and the full explicit `## B …` panel, panel heading included; an empty requirement emits nothing |
| Execution block | `((b1))` | The body, expanded recursively; `lines(1..3)` and `section("标题")` select from the source before expansion |
| Block result | `((b3.result))` | The latest `result` record associated with that block in the same Playbook or Run; `lines` and `section` also work, with no recursive expansion |
| Local text file | `((file:notes.md \| section("背景")))` | Text fetched relative to the Playbook's directory; `lines` also works, with no recursive expansion |
| GitHub issue/PR | `((https://github.com/owner/repo/issues/1 \| title, body))` | The issue/PR title, body or discussion comments; needs an authenticated `gh` |

Rules and limits:

- Design blocks support `requirement`, `design` and `panel(A)`; a panel needs a single uppercase-letter ID written in its heading, such as `## B What · 结论`. Automatically displayed numbers are not referenceable IDs. `((…))` inside requirements and designs stays as written: it is not fetched or expanded.
- `lines` is a 1-based closed range written `lines(1..3)`; `section` excludes the selected heading and includes its subsections. Neither works on design blocks.
- GitHub supports only standard `https://github.com/<owner>/<repo>/issues/<n>` or `/pull/<n>` URLs. `comments`, `comments(1..2)` and `comments(-1)` select discussion comments in time order; a PR does not include its diff, files, reviews or inline review comments. Arbitrary web URLs are not supported.
- External text is wrapped in `<external source="…" fetched="…">`, showing when it was fetched. A fetch is a copy, not a live sync; for the latest content use `playbook_compile {op:"refetch"}`.
- `file:` allows `../` and has **no** directory sandbox or secret scanning like the design images/`src=` have; reference only files you are willing to hand to a subagent.
- A missing block, panel, result or section, out-of-range lines, a failed fetch or a reference cycle fails compilation. A block reference chain is at most 8 levels deep, root included.

`playbook_compile` only shows the compiled result; it starts no work.

## Bodies, designs and components

Execution bodies and designs are drawn with the same component parser. The component format follows [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html), but **parsing and rendering are implemented in this repository; it does not call that project's CLI and is not an embedded browser page**. Paragraphs, headings, lists and `//` comment lines are drawn as native text, formulas go to Tern's native Markdown nodes, diagram components become static SVG, and the rest use native TSP nodes.

### Header and panels

- The optional header must start on the first line, opened and closed with `---`; it supports only line-by-line `key: value`, not full YAML.
- Panels are drawn in one column, in the order written. `title` and `subtitle` are shown; without a header `title`, if the first non-empty body line is `# Title`, it becomes the header title and is removed from the body; writing prose before the heading does not trigger this. `template` (`sheet`/`doc`) and `cols` (1–6) are validated for format compatibility but do not change the layout.
- `## A Title {bare meta="note"}` starts a panel. `bare` drops the panel heading (not on a Where/What/How panel) and `meta` shows extra text. `span` and `rows` are validated but do not change the layout.
- `lang` is ignored; `theme`, `mode` and `style` are ignored with a warning; other header keys are shown as text metadata.
- A panel ID is a single uppercase letter and must be unique. The native text labels of some components support inline code, bold, italic and strikethrough; flow and ER labels show as plain text, and sequence labels have these marks removed and show as plain text. Do not treat component labels as a full Markdown renderer.
- A line starting with `//` is a comment line: it is drawn in the muted comment style and is still part of the text the agent receives.

### Supported syntax

| Component | Fence opening line and body |
|---|---|
| `slot` | `slot 名称`; one `= current value` line, then options `* recommended \| note`, `- option \| note` and `~ option offered earlier \| note`; written `{{名称}}` where the value goes (prose, list items, `kv` values, flow nodes, where the node must be bracketed, such as `({{名称}})`). The fence itself is not drawn. A custom value that is none of the options is kept as a `~` option |
| `flow` | `flow LR`; `Client -> [API] -> [(Cache)]: read`; direction `TB/LR/BT/RL`, default `TB`; `-->` dashed, `{Choice}` diamond, `(Reply)` rounded. A single path is drawn as an editable node column, see [How a person edits](#how-a-person-edits) |
| `er` | `er LR`; one entity per line, indented fields such as `id uuid PK`, `user_id uuid FK -> User`; relations such as `User 1--* Order: owns` |
| `sequence` | `sequence num`; `participants: Client, API`, `Client -> API: request`, `API --> Client: reply`; supports `note API: text` and `== phase ==` |
| `tree` | `tree list`; indentation means parent/child, `name \| note`; without `list` the layout is chosen automatically |
| `timeline` | `timeline h` or `timeline v`; `09:00 \| start \| note`, `*` before the time highlights it |
| `limits` | `limits`; `Latency \| 13 / 20 \| ms \| p95` or `Workers \| max 8 \| count` |
| `annot` | `annot`; body `结果可能[过期]{!读取前刷新}`, `# Title \| side note`, `> caption` |
| `kv` | `kv cols=2`; `存储: Redis`, `*不变量: 一个源头` is a full-width item |
| `callout` | `callout warn 缓存失效`; the body is Markdown; types `info/ok/warn/err`; drawn as a comment |
| `diff` | `diff file=src/value.ts title="变更"`; paste a unified diff as the body, it is not loaded from `file`; supports `start`, `hl` |
| `html` | `html`; structured tags such as `<section><h3>方案</h3><p><strong>结论</strong></p></section>`, converted to TSP; no web page runs |
| `svg` | `svg`; a complete, static, safe `<svg>`, preferably with an explicit `viewBox` or `width`/`height` |
| Code | Other language fences such as `ts title="片段" start=18 hl=19`; write the code in the body, or read a file with `ts src=sample.ts lines=1-2 hl=2` |
| Table | Markdown tables; standalone lowercase status words `ok`, `no`, `warn` in data cells (optionally followed by a space and a note) show status icons |
| Image | `![caption](image.png)` on its own line reads a local image file |

`flow`, `er` and `tree` support the change markers `+ `, `- ` and `~ ` and offer "变更/之前/之后" (changes/before/after) views. `~` marks a modified declaration without storing both versions; a changed flow edge or ER relation is written as one removal and one addition. A tree parent or ER entity marked as added or removed passes the marker to its children.

### Not browser features

- `html` drops ordinary `class/style/id` and similar attributes; links show as text and address, buttons have no action; scripts, styles and embedded pages are removed. It is not a renderer for arbitrary HTML/CSS pages, interactive forms or web apps.
- `svg` rejects scripts, events, `foreignObject`, external links and external CSS resources. SVG embedded in HTML is cleaned of unsafe content with a warning. What SVG can actually draw is still up to Tern.
- Mermaid fences show as plain code here and are not turned into diagrams. `flow/er/sequence` have their own syntax; Mermaid DSL cannot be pasted in directly.
- Images load only from inside the Playbook directory; remote URLs or data URLs show only their caption/address with a warning. Images and `src=` both check the real path, so `../` or symbolic links cannot escape the directory.
- Embedded local files are capped at 5 MiB; code `src=` also has a 2 MiB cap and binary/credential-path/secret-content checks. `lines=1-2` is written differently from the reference form `lines(1..2)`; `hl` uses displayed line numbers. For `src=` the whole file is scanned for secrets before the lines are cut.
- A single fence body over 1000 lines is not drawn; code and diffs over 200 lines are an error, over 40 lines a warning. Errors and warnings both show line numbers, and only errors fail the `draft` check. An empty body or design is not treated as an error by this.

## Coordinator tools

These are tool arguments, not shell commands. `doc` can be omitted only when exactly one document is connected; `run` is omitted to act on the Playbook file itself. All input is strictly validated and extra fields are rejected. A plain `playbook_read` **has no `op: "read"`**.

| Tool | Arguments |
|---|---|
| `playbook_open` | `{doc}` |
| `playbook_read` | `{doc?, run?, block?}`; history `{doc?, run?, op:"revisions", block?, after?}`. Blocks carry `status` and `report`, or `task: false` |
| `playbook_edit` | `{doc?, run?, op:"title", block, value}`; `status` takes `{block, value}` with `todo`, `running` or `done`; `task` takes `{block, value}` with `false` (untracked) or `true` (tracked, `todo`); `replace` takes `{block, find, replace}`; `write` takes `{block, text}`; `panel` takes `{block, panel, text}`; `insert` takes `{after?, title, body, agent?, isolated?}`; `insert_design` takes `{after?, title, design}`; `delete` takes `{block}`; `move` takes `{block, after}` with `after` a block ID or `null` (to the top); `agent` takes `{block, value}` with a string or `null` (clear); `isolated` takes `{block, value}` with a boolean or `null`; each also passes `op` |
| `playbook_compile` | `{doc?, run?, op:"compile", blocks:[…]}`; refetch `{doc?, run?, op:"refetch", targets:[…]}` |
| `playbook_check` | `{doc?, run?, op:"inspect", blocks:[…]}`; report `{doc?, run?, op:"report", blocks:[…], version, result}` |
| `playbook_run` | `{doc?, op:"start", name, update_every?}`, `{doc?, op:"finish", run}`, `{doc?, op:"list"}` |
| `playbook_timeline` | `{doc?, op:"read", run?, after?}`; `{doc?, op:"post", run?, kind, text, block?, launch?, next?, quote?}`; `{doc?, op:"snooze", run, after}` |
| `playbook_launch` | `{doc?, op:"launch", run?, blocks:[…]}` → `{launch, kind, text, agent?, isolated?}`; `{doc?, op:"bind", launch, agent}`; `{doc?, op:"info" or "rebase" or "close", launch}` |

`write/replace` in `playbook_edit` change only an execution body or a design, never a requirement; the `find` of `replace` must occur exactly once. The `text` of `panel` must be the whole replacement panel, starting with `## <ID> Title`, and works on execution bodies and designs. `insert` and `insert_design` create a `todo` block; `insert_design` always starts with an empty requirement for a person to fill in. `task` applies only to execution blocks. `move` records nothing when the position does not change. `agent` and `isolated` apply only to execution blocks; changing them does not change the compiled text or trigger a change-during-execution notice, and `launch` returns one only when every root block presets the same value. When editing an existing block, one call takes the lock, edits and releases it.

### Running one execution block

With the file above, the main session calls in order:

1. `playbook_open {doc: "/absolute/path/playbook.yaml"}`.
2. `playbook_compile {op: "compile", blocks: ["b3"]}`: check the expanded rules, requirement, panel B and slot value, followed by the execution-record instructions.
3. In the main session's **JS eval**, start the worker:

```js
var worker = await playbook.agent({
  blocks: ["b3"], agent: "task:mid", label: "检查缓存方案"
});
```

`playbook.agent` returns as soon as the worker is started and bound. `worker` is a top-level variable that later eval cells can still use; wait for the worker with omp's `wait` tool, and the main session keeps handling requests and change notices from the pane meanwhile. The subagent sets b3 to `running`, and when it finishes to `done` with its report. Then send another eval:

```js
return await playbook.result(worker);
```

It records the worker's final message as a result on b3 (a Launch with a single block is associated automatically) and closes this Launch. When nothing needs answering in between, one blocking call `await playbook.run({ blocks: ["b3"], agent: "task:mid" })` starts, waits, records and closes in one go. A person's "启动" in the pane arrives as `launch_requested`, and the notice gives the same calls.

To execute the Playbook again from a clean state without touching the file, call `playbook_run {op: "start", name: "检查缓存方案"}`, take the returned Run ID and pass it as `run` to the calls above; finish with `playbook_run {op:"finish", run}`.

`task:mid` must be an agent available in the current omp; the extension neither provides nor configures it. A call without `agent` uses the block's preset `agent`, and with no preset either, omp's default agent; when the default is disabled, `agent` must be given or preset on the block. `isolated` follows the same order: explicit argument, then the block's preset, then nothing.

The `playbook` object in JS eval is injected by the extension; do not add an import line yourself. Helpers:

| Method | Behavior |
|---|---|
| `playbook.run({run?, blocks, …})` | `playbook.agent` plus `playbook.result`: creates a Launch, starts and binds one worker, waits, records the result and closes the Launch |
| `playbook.agent({run?, blocks, …})` | Creates a Launch, starts and binds a worker, returns `{launch, blocks, id, handle, …}` without waiting; `agent` and `isolated` left out come from the blocks' presets; on an orchestration block it closes the Launch it just created and throws |
| `playbook.result(worker, {block?, close?})` | Waits and writes `result`, associated with the Launch's only block when `block` is not given; a wait error, including a cancellation by `playbook.stop`, writes `failure` and throws. Afterwards it closes the Launch as `close` says, by default when the worker was created by `playbook.agent` |
| `playbook.spawn(launch, {…})` | Adds a worker to an open prompt Launch, using its latest baseline (the new text after `rebase`); the worker does not own the Launch, so its `result` does not close it by default; a closed Launch is refused |
| `playbook.stop(launch, {doc?})` | Cancels every worker this eval kernel started for the Launch and sets its blocks that are still `running` back to `todo`; returns `{cancelled}`; throws when this session started no worker for it |
| `playbook.read({run?, block?})` | Reads blocks; there is no history helper, so history still uses the `playbook_read` tool |
| `playbook.post({run?, kind, text, …})` | Writes a record |
| `playbook.timeline({run?, after?})` | Reads the timeline |
| `playbook.context` | `{doc, run?, launch}` during orchestration (no `run` for the Playbook itself); empty in an ordinary eval |

The helpers never set `status` or finish a Run on their own; the subagent writes its own status. For parallel work, start workers with several `playbook.agent` calls, keep each in a top-level variable and `result` each one later; for several workers on one Launch, add them with `playbook.spawn` and pass `{close: true}` to the one that finishes up, or call `playbook_launch {op:"close"}`. A cell containing `playbook.run/result` with no explicit `timeout` gets `timeout: 0`.

### Orchestration blocks

The block below can be added under `blocks` in the example file; use a `js`/`py` fence of exactly three backticks, with no other prose in the body:

````yaml
  - id: b4
    title: 编排检查
    body: |
      ```js
      var worker = await playbook.agent({ blocks: ["b3"], agent: "task:mid" });
      var result = await playbook.result(worker);
      await tool.playbook_launch({ doc: playbook.context.doc, op: "close", launch: playbook.context.launch });
      return result;
      ```
    status: todo
````

Call `playbook_launch {op:"launch", blocks:["b4"]}` (add `run` to launch it in a Run) to get the Launch ID; below it is assumed to be `l2`, use the actual returned value. Then send an eval whose **entire code is just this one line**:

```js
await playbook.exec("l2")
```

`exec` is an entry point that the extension intercepts and replaces the whole cell with; it is not an ordinary helper, and no code may come before or after it. With several documents connected, write `await playbook.exec("l2", "/absolute/path/playbook.yaml")`. What runs is the orchestration code in the Launch's current baseline (the code frozen at launch until a `rebase`), with `timeout: 0` forced; the JS helpers default to that Launch's document and Run. Raw `tool.playbook_*` calls do not inherit those defaults: with several documents connected pass `doc` explicitly, and for Run operations also pass `run` as the tool arguments require.

Python orchestration sets the **Python variables** `PLAYBOOK_DOC`, `PLAYBOOK_RUN` (`None` for the Playbook itself) and `PLAYBOOK_LAUNCH`, not environment variables, and does not inject the JS `playbook` helpers; use the `tool` and `agent` interfaces of Python eval directly, which needs omp's Python backend.

## Checks are not completion or approval

`playbook_check inspect` returns the deterministic checks `compile`, `render_error` and `render_pending`; execution blocks also check `empty_expansion`, execution bodies and designs check `draft`, and non-orchestration bodies and designs check `outline` (Where/What/How). The pane does not show checks; it shows component errors and what breaks the outline in place. Checks do not prove a business design correct; apart from Launch constraints such as compile failures, a failed check does not gate a launch.

`jev` is a separately reported model judgment:

- `playbook_check inspect` returns `{blocks, source, compiled, view, findings, version}` and **currently returns no question definitions**.
- The current fixed question is `missing`: does the full compiled prompt mention logs, discussions, files or earlier results whose content it does not include? The main session can answer it in eval with an available `judge`.
- The report shape is `result: {kind:"answers", answers:{missing: P(yes)}}`, with the probability in 0–1; `P(yes) >= 0.5` counts as failed. With no judge available, report `{kind:"judge_unavailable"}`, which counts as not judged, not as passed.
- The report must carry the latest `version` for the same document, the same Run and the same ordered block list. Stale reports are ignored; a change to the input invalidates the old judgment.

There is no design-approval state and no automatic transition from checks to `done`.

## Development checks

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
