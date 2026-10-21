# Tern Playbooks

English | [简体中文](README.zh-CN.md)

Tern Playbooks keeps **design, execution prompts and orchestration code** in one Playbook that people and agents edit together. It consists of an omp extension and a Tern document service: the main session connects to the document service through the `playbook_*` tools, while a person reads the cards, edits content and submits change requests in the pane beside it.

Design and execution are separate. A design block covers one design or business unit; an execution block composes the requirements, design panels, context and earlier results it needs through references. One execution block can reference several design blocks; designs and tasks do not have to map one to one.

| Party | Responsible here for |
|---|---|
| Person | Editing requirements, execution bodies and titles directly; viewing the rendered design; submitting design change prompts and requesting launches or checks by hand |
| omp main session (coordinator) | Revising designs itself; calling tools to create Runs and compile prompts; deciding how to launch and orchestrate subagents, handle change notices and record results |
| Document service | Storing documents, Runs, Launches and records; resolving references; drawing cards and design components; locking, running deterministic checks and notifying the coordinator |
| Subagent | Executing the compiled prompt the coordinator hands it; it owns none of this Playbook's tools or UI |

**Buttons are requests, not automatic executors.** "Submit change" hands the change prompt to the main session; "Launch" notifies the main session to execute; "Check" asks the main session to add the model judgment. The extension never revises a design, starts a worker or accepts a result on its own because a notice arrived.

## Install and open

You need [Bun](https://bun.sh), omp and Tern. The process that loads the extension must find `tern` on `PATH`; the environment that starts the document service must be able to run `bun`. GitHub issue/PR references also need an authenticated `gh`.

The repository is [oh-my-omp/omp-playbooks](https://github.com/oh-my-omp/omp-playbooks); the installed omp package name and the Tern plugin ID are still `tern-playbooks`, and the upgrade and uninstall commands below use that name.

```sh
omp plugin install 'https://github.com/oh-my-omp/omp-playbooks.git#main'
```

When the extension loads it checks for Tern and links the package's `tern-plugin/` into Tern; it skips this when the same directory is already linked. The link points at the omp install directory itself. The Tern daemon reloads plugin files edited in place, but an upgrade replaces the whole install directory, which leaves the daemon on a missing link target or an old version. The extension therefore compares the version in `tern-plugin/plugin.toml` with the version the daemon loaded, runs `tern plugin reload` when they differ, and reports the outcome in the main session. If the versions still differ after the reload it only warns and does not abort the install; the next extension load compares again.

**Pulling the repository or restarting a session does not update the installed plugin copy.** If an older version is installed, update it first:

```sh
omp plugin upgrade tern-playbooks
```

After updating, start a new omp session; running extensions and document services are not hot-swapped. Wind down any work in progress, then close the old document-service pane and let the new session open it again. `playbook_open` reuses an existing service, so it cannot be used to force a switch to the new one. After every push to `main`, CI increments the last version component in both `package.json` and `tern-plugin/plugin.toml`, so the version tells old and new code apart.

To uninstall, remove both sides:

```sh
omp plugin uninstall tern-playbooks
tern plugin unlink tern-playbooks
```

There are three ways to open a file:

- **From the main session:** write the YAML file first, then call `playbook_open {doc: "/absolute/path/playbook.yaml"}`. With no service running, the extension starts one to the right of the current omp pane; this requires omp to run in a Tern pane managed by the session daemon, with `TERN_PANE` in its environment. With a service already running it only connects: it opens no extra pane and does not move focus.
- **From Tern:** focus a `.yaml` or `.yml` file pane and choose "Playbook: 打开" in the command palette. It shows the existing service, or starts one beside the pane. This does not start omp or set up a coordinator connection.
- **Starting the service from source:** install dependencies in the repository, then run the commands below in a Tern pane. The main session still has to call `playbook_open` to receive requests.

```sh
bun install
bun src/service/main.ts /absolute/path/playbook.yaml
```

One file has one live service and one coordinator connection. Another main session gets `Busy` while the original coordinator is still connected. When the original session ends, the document pane stays and shows "没有协调者连接" (no coordinator connected); a new session can take over. An omp without `TERN_PANE` can still connect to a service that is **already running**, but cannot create a pane beside itself from there.

Main-session commands:

- `/playbook-show [file path]`: jump to the pane of a connected document.
- `/playbook-add [file path]`: pick recent session messages, a Run, a record kind and optionally a block, and add them to the timeline.

These commands and the `playbook_*` tools are registered only in the main session; subagents do not see them.

## The file and its two kinds of block

Save the following as `playbook.yaml` and it can be opened; it needs no network, external files or `am` CLI:

````yaml
title: 缓存方案
blocks:
  - id: b1
    title: 缓存设计
    requirement: |
      数据重启后不能丢。请求路径要简单。
    design: |
      ---
      template: sheet
      title: 缓存设计
      cols: 2
      ---
      先说明方案，再检查请求路径。

      ## A 结论
      ```callout ok 使用持久化缓存
      明确持久化策略，不把“用了 Redis”当成数据不会丢的保证。
      ```

      ## B 请求路径
      ```flow LR
      Client -> Gateway -> [(Cache)]: read
      ```
    done: false
  - id: b2
    title: 检查方案
    body: |
      根据下面的需求和请求路径，列出三个需要验证的边界。
      不修改文件，只输出检查清单。
      ((b1 | requirement, panel(B)))
    done: false
````

| Block | File fields | Purpose and where it is edited |
|---|---|---|
| Design block | `requirement`, `design` | A person edits the requirement directly; the main session edits the rendered design. Cannot be launched directly |
| Execution block | `body`; optional `agent`, `isolated` | A person or the main session edits the Markdown/prompt directly; it can be referenced as context or launched in a Run. `agent` and `isolated` are its execution contract: the agent its subagent uses by default, and whether that worker gets its own worktree |
| Orchestration block | Also `body`, whose whole content is one `js` or `py` code fence | Orchestration code run by the coordinator, not treated as an ordinary worker prompt |

Every block needs `id`, `title`, `done` and the matching content fields. IDs are positive integers such as `b1`, `b2` and must be unique. The YAML **has no `kind`**; the type follows from the fields. Mixing `body` with `requirement`/`design`, missing fields and unknown fields are rejected. `agent` (a string that is not blank after trimming) and `isolated` (a boolean) are allowed only on execution blocks; when unset they do not appear in the file. Use `|` for multi-line content; an empty requirement or design is an empty string or an empty block scalar.

`done` is a flag that is set explicitly or ticked; it is not a design-approval state and is never derived from checks, subagent return values or Launch state. Existing files with only `body` blocks still work.

### How a person edits

1. Title, execution body, requirement: click the pencil, edit the text, then click "完成" (Done). `Esc` also commits these fields; it **does not undo**.
2. Design: look at the rendered result, click "写修改 prompt" (write change prompt), state exactly what should change and how, then click "提交修改" (submit change) by hand. On the notice, the main session reads the block and revises `design`; it does not touch `requirement`.
3. `Esc` in the change prompt **does not submit**. "放弃" (Discard) drops the current draft. An empty prompt, or submitting with no coordinator connected, is rejected and the draft stays in the editor.
4. An `ask` in a design is drawn as single- or multiple-choice controls with the `*` recommended options selected. Change the selection and click "提交选择" (submit choice): the pane submits `针对问题「<question>」，选择：<options>` as the design block's change prompt, which enters the change log and notifies the main session like a hand-written one; when revising, the main session replaces the answered `ask` with the matching design decision. With no coordinator connected the submission is refused and the text stays in the change-prompt editor; the button is unavailable while the block is locked, another draft exists, the Run has finished or nothing is selected.
5. Within one service, templates and all Runs included, only one person's field draft can exist at a time. The edit lock covers the whole block; while a person is editing, the coordinator cannot write that block. While the coordinator holds the lock, "打断" (Interrupt) takes the block back.

With many blocks, "折叠" (fold) on a card's state row leaves only the state row (lock included), the title and notices; "全部折叠" / "全部展开" (fold all / unfold all) at the top act on every card of the current document. Folding changes only what is shown: checks and the view `playbook_check inspect` returns stay as when unfolded, and a draft in progress is kept for when the card opens again. An execution block with `agent` or `isolated` set shows them on its state row.

A submitted prompt goes into an append-only change log; "修改记录" (change log) on the card is collapsed by default. It records **the person's change requests**, not design snapshots, design diffs or AI replies; an ordinary block read does not include it.

```json
{"op":"revisions","block":"b1","after":0}
```

The above are `playbook_read` arguments; querying a Run's log also needs `run`. `after` is a record sequence number; records with a larger number are returned. A new Run does not inherit the template's change history.

## Template, Run, Launch

| Object | Start and end | What never happens automatically |
|---|---|---|
| Template | The original YAML, copied by each Run | Changing the template does not update existing Runs |
| Run | "开始 Run" (Start Run) or `playbook_run start` copies the template and resets every `done` to `false`. After it finishes, its blocks can no longer be edited through cards or tools | Starting a Run starts no agent; finishing a Run does not require every block to be done |
| Launch | Compiles a Run's execution blocks, freezes the prompt/orchestration code and creates a record; closed explicitly, by `playbook.result` when it finishes up, or when the Run finishes | `launch`/`bind` start no worker; writing a result with `playbook_timeline` does not close the Launch; a close record does not cancel the worker |

A Run has its own block contents, change log and timeline. **After clicking "开始 Run", switch to that Run's tab at the top** before editing or launching; tool calls also pass the returned Run ID, for example `r1`. Read, edit, compile and check operations without `run` act on the template.

Clicking "启动" (Launch) on an execution block in a Run sends `launch_requested` to the coordinator. With several blocks ticked, the launch targets are combined in document order; design blocks cannot be launched, and an orchestration block can only be launched alone. The worker only starts working once the main session calls the execution tools.

An execution block can reference several design blocks, and several execution blocks can be compiled into one Launch. A subagent receives the frozen text, not the UI, a live design page or any implicit Playbook context.

### Changes during execution

The document service recompiles the affected active Launches and compares them with their baseline; when the compiled text changes or compilation fails, it notifies the coordinator after about two seconds of coalescing. A person's content edits, edits on disk and the coordinator's design revisions can all trigger the notice; titles, `done` and the coordinator's own edits to an execution body do not trigger the same content-change notice. Active means not closed and belonging to the currently connected coordinator session; a new session that takes over the document does not take over the old session's Launches.

The notice does not change a running worker's prompt. The coordinator decides whether to tell the worker, rearrange the work, or call `playbook_launch rebase` to accept the current compilation as the new baseline. `rebase` appends the current compilation as the new baseline and keeps the originally frozen snapshot in the Launch record; a later `playbook.spawn`, and `playbook.exec` of an orchestration block, use the latest baseline. A closed Launch can no longer be bound or rebased.

### Records and files

For `playbook.yaml`:

| File | Content |
|---|---|
| `playbook.yaml` | Template |
| `playbook.yaml.revisions.jsonl` | Template change-prompt history |
| `playbook.yaml.pb.jsonl` | Service ID allocation records |
| `playbook.runs/r1.yaml` | The Run's blocks and run metadata |
| `playbook.runs/r1.jsonl` | The Run's timeline and Launch records |
| `playbook.runs/r1.revisions.jsonl` | The Run's change-prompt history |

For a `.yml` file the Run directory keeps the suffix, for example `example.yml.runs/`. Finishing a Run closes its Launch records, releases locks, discards uncommitted drafts and saves the finish time; it does not write back to the template and does not replace stopping agents that are still running.

The timeline accepts `update`, `result`, `failure` and `retrospective`. A retrospective is written only after the Run finishes. `update_every` and `next` are positive integer seconds; when they come due it is only a notice, and no update is generated automatically. A result can be read through that block's `.result` reference only when it is associated with a `block`.

The service checks the files on disk about once a second, and committed edits are written back to the YAML about a second later. Direct edits to the YAML content fields are loaded too, designs included; the editing split on the cards is not a file-system permission. Invalid YAML shows the parse error and keeps the last valid content; write-back resumes once the file is valid again. Disk changes do not commit a person's draft for them; a change to the same field is flagged, and clicking "完成" afterwards still applies the draft. Blocks of a finished Run are protected only on the UI/tool paths; the files on disk are not immutable.

## References and compilation

Execution bodies use `((target))` or `((target | selector, selector))`. Several selected results are joined with blank lines in the order written. A reference must fit on one line; references inside inline code or code fences are not expanded.

| Target | Example | What it compiles to |
|---|---|---|
| Design block | `((b1))` | The raw requirement and design, wrapped in `<requirement>` and `<design>` |
| Design field/panel | `((b1 \| requirement, panel(B)))` | The raw requirement and the full explicit `## B …` panel, panel heading included |
| Execution block | `((b2))` | The body, expanded recursively; `lines(1..3)` and `section("标题")` select from the source before expansion |
| Block result in a Run | `((b2.result))` | The latest `result` record associated with that block; `lines` and `section` also work, with no recursive expansion |
| Local text file | `((file:notes.md \| section("背景")))` | Text fetched relative to the Playbook's directory; `lines` also works, with no recursive expansion |
| GitHub issue/PR | `((https://github.com/owner/repo/issues/1 \| title, body))` | The issue/PR title, body or discussion comments; needs an authenticated `gh` |

Rules and limits:

- Design blocks support `requirement`, `design` and `panel(A)`; a panel needs a single uppercase-letter ID written in its heading, such as `## A 结论`. Automatically displayed numbers are not referenceable IDs. `((…))` inside requirements and designs stays as written: it is not fetched or expanded.
- `lines` is a 1-based closed range written `lines(1..3)`; `section` excludes the selected heading and includes its subsections. Neither works on design blocks.
- GitHub supports only standard `https://github.com/<owner>/<repo>/issues/<n>` or `/pull/<n>` URLs. `comments`, `comments(1..2)` and `comments(-1)` select discussion comments in time order; a PR does not include its diff, files, reviews or inline review comments. Arbitrary web URLs are not supported.
- External text is wrapped in `<external source="…" fetched="…">`, showing when it was fetched. A fetch is a copy, not a live sync; for the latest content click "重新取回" (refetch) or use `refetch`.
- `file:` allows `../` and has **no** directory sandbox or secret scanning like the design images/`src=` have; reference only files you are willing to hand to a subagent.
- A missing block, panel, result or section, out-of-range lines, a failed fetch or a reference cycle fails compilation. A block reference chain is at most 8 levels deep, root included.

"预览" (Preview) and `playbook_compile` only show the compiled result; they start no work.

## Designs and components

The component format follows [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html), but **parsing and rendering are implemented in this repository; it does not call that project's CLI and is not an embedded browser page**. Prose and formulas go to Tern's native Markdown nodes; diagram components become static SVG, and the rest use native TSP nodes.

### Header and panels

- The optional header must start on the first line, opened and closed with `---`; it supports only line-by-line `key: value`, not full YAML.
- `template: sheet` is a grid and `doc` a single column. `cols` ranges 1–6, default 3. `title` and `subtitle` are supported; without a header `title`, if the first non-empty body line is `# Title`, it becomes the header title and is removed from the body; writing prose before the heading does not trigger this.
- `## A Title {span=2 bare meta="note"}` starts a panel. `span` sets the column span, `bare` drops the card frame and `meta` shows extra text; panel height follows its content. `rows` is parsed but does not affect layout.
- `lang` is ignored; `theme`, `mode` and `style` are ignored with a warning; other header keys are shown as text metadata.
- A panel ID is a single uppercase letter and must be unique. The native text labels of some components support inline code, bold, italic and strikethrough; flow and ER labels show as plain text, and sequence labels have these marks removed and show as plain text. Do not treat component labels as a full Markdown renderer.

### Supported syntax

All of these are components **inside a design**. Execution bodies are not drawn with this component parser.

| Component | Fence opening line and body |
|---|---|
| `flow` | `flow LR`; `Client -> [API] -> [(Cache)]: read`; direction `TB/LR/BT/RL`, default `TB`; `-->` dashed, `{Choice}` diamond, `(Reply)` rounded |
| `er` | `er LR`; one entity per line, indented fields such as `id uuid PK`, `user_id uuid FK -> User`; relations such as `User 1--* Order: owns` |
| `sequence` | `sequence num`; `participants: Client, API`, `Client -> API: request`, `API --> Client: reply`; supports `note API: text` and `== phase ==` |
| `tree` | `tree list`; indentation means parent/child, `name \| note`; without `list` the layout is chosen automatically |
| `timeline` | `timeline h` or `timeline v`; `09:00 \| start \| note`, `*` before the time highlights it |
| `limits` | `limits`; `Latency \| 13 / 20 \| ms \| p95` or `Workers \| max 8 \| count` |
| `annot` | `annot`; body `结果可能[过期]{!读取前刷新}`, `# Title \| side note`, `> caption` |
| `kv` | `kv cols=2`; `存储: Redis`, `*不变量: 一个源头` is a full-width item |
| `callout` | `callout warn 缓存失效`; the body is Markdown; types `info/ok/warn/err` |
| `ask` | `ask` or `ask multi`; the first line is the question, followed by 2–6 `* recommended \| note` or `- other \| note`; single choice needs exactly one recommended option; in the pane the options can be picked and submitted with "提交选择", see [How a person edits](#how-a-person-edits) |
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
- A single fence body over 1000 lines is not drawn; code and diffs over 200 lines are an error, over 40 lines a warning. Errors and warnings both show line numbers, and only errors fail the `draft` check. An empty design is not treated as an error by this.

## Coordinator tools

These are tool arguments, not shell commands. `doc` can be omitted only when exactly one document is connected; all input is strictly validated and extra fields are rejected. A plain `playbook_read` **has no `op: "read"`**.

| Tool | Arguments |
|---|---|
| `playbook_open` | `{doc}` |
| `playbook_read` | `{doc?, run?, block?}`; history `{doc?, run?, op:"revisions", block?, after?}` |
| `playbook_edit` | `{doc?, run?, op:"title" or "done", block, value}`; `replace` takes `{block, find, replace}`; `write` takes `{block, text}`; `panel` takes `{block, panel, text}`; `insert` takes `{after?, title, body, agent?, isolated?}`; `insert_design` takes `{after?, title, design}`; `delete` takes `{block}`; `move` takes `{block, after}` with `after` a block ID or `null` (to the top); `agent` takes `{block, value}` with a string or `null` (clear); `isolated` takes `{block, value}` with a boolean or `null`; each also passes `op` |
| `playbook_compile` | `{doc?, run?, op:"compile", blocks:[…]}`; refetch `{doc?, run?, op:"refetch", targets:[…]}` |
| `playbook_check` | `{doc?, run?, op:"inspect", blocks:[…]}`; report `{doc?, run?, op:"report", blocks:[…], version, result}` |
| `playbook_run` | `{doc?, op:"start", name, update_every?}`, `{doc?, op:"finish", run}`, `{doc?, op:"list"}` |
| `playbook_timeline` | `{doc?, op:"read", run, after?}`; `{doc?, op:"post", run, kind, text, block?, launch?, next?, quote?}`; `{doc?, op:"snooze", run, after}` |
| `playbook_launch` | `{doc?, op:"launch", run, blocks:[…]}` → `{launch, kind, text, agent?, isolated?}`; `{doc?, op:"bind", launch, agent}`; `{doc?, op:"info" or "rebase" or "close", launch}` |

`write/replace` in `playbook_edit` change only an execution body or a design, never a requirement; the `find` of `replace` must occur exactly once. The `text` of `panel` must be the whole replacement panel, starting with `## <ID> Title`. `insert_design` always starts with an empty requirement for a person to fill in. `move` records nothing when the position does not change. `agent` and `isolated` apply only to execution blocks; changing them does not change the compiled text or trigger a change-during-execution notice, and `launch` returns one only when every root block presets the same value. When editing an existing block, one call takes the lock, edits and releases it.

### Running one execution block

With the file above, the main session calls in order:

1. `playbook_open {doc: "/absolute/path/playbook.yaml"}`.
2. `playbook_compile {op: "compile", blocks: ["b2"]}`: check the expanded requirement and panel B.
3. `playbook_run {op: "start", name: "检查缓存方案"}`: take the returned Run ID. Below it is assumed to be `r1`; use the actual returned value.
4. In the main session's **JS eval**, start the worker:

```js
var worker = await playbook.agent({
  run: "r1", blocks: ["b2"], agent: "task:mid", label: "检查缓存方案"
});
```

`playbook.agent` returns as soon as the worker is started and bound. `worker` is a top-level variable that later eval cells can still use; wait for the worker with omp's `wait` tool, and the main session keeps handling change requests and change notices from the pane meanwhile. When the worker has finished, send another eval:

```js
return await playbook.result(worker);
```

It records the result on b2 (a Launch with a single block is associated automatically) and closes this Launch. When nothing needs answering in between, one blocking call `await playbook.run({ run: "r1", blocks: ["b2"], agent: "task:mid" })` starts, waits, records and closes in one go.

5. Check the output; when appropriate, set `playbook_edit {op:"done", run:"r1", block:"b2", value:true}` explicitly, or let a person tick it. Finally call `playbook_run {op:"finish", run:"r1"}` and write the retrospective.

`task:mid` must be an agent available in the current omp; the extension neither provides nor configures it. A call without `agent` uses the block's preset `agent`, and with no preset either, omp's default agent; when the default is disabled, `agent` must be given or preset on the block. `isolated` follows the same order: explicit argument, then the block's preset, then nothing.

The `playbook` object in JS eval is injected by the extension; do not add an import line yourself. Helpers:

| Method | Behavior |
|---|---|
| `playbook.run({run, blocks, …})` | `playbook.agent` plus `playbook.result`: creates a Launch, starts and binds one worker, waits, records the result and closes the Launch |
| `playbook.agent({run, blocks, …})` | Creates a Launch, starts and binds a worker, returns `{launch, blocks, id, handle, …}` without waiting; `agent` and `isolated` left out come from the blocks' presets; on an orchestration block it closes the Launch it just created and throws |
| `playbook.result(worker, {block?, close?})` | Waits and writes `result`, associated with the Launch's only block when `block` is not given; a wait error writes `failure` and throws. Afterwards it closes the Launch as `close` says, by default when the worker was created by `playbook.agent` |
| `playbook.spawn(launch, {…})` | Adds a worker to an open prompt Launch, using its latest baseline (the new text after `rebase`); the worker does not own the Launch, so its `result` does not close it by default; a closed Launch is refused |
| `playbook.read({run?, block?})` | Reads blocks; there is no history helper, so history still uses the `playbook_read` tool |
| `playbook.post({run, kind, text, …})` | Writes a record |
| `playbook.timeline({run, after?})` | Reads the timeline |
| `playbook.context` | `{doc, run, launch}` during orchestration; empty in an ordinary eval |

The helpers never set `done` or finish a Run on their own. For parallel work, start workers with several `playbook.agent` calls, keep each in a top-level variable and `result` each one later; for several workers on one Launch, add them with `playbook.spawn` and pass `{close: true}` to the one that finishes up, or call `playbook_launch {op:"close"}`. A cell containing `playbook.run/result` with no explicit `timeout` gets `timeout: 0`.

### Orchestration blocks

The block below can be added under `blocks` in the example file; use a `js`/`py` fence of exactly three backticks, with no other prose in the body:

````yaml
  - id: b3
    title: 编排检查
    body: |
      ```js
      var worker = await playbook.agent({ blocks: ["b2"], agent: "task:mid" });
      var result = await playbook.result(worker);
      await tool.playbook_launch({ doc: playbook.context.doc, op: "close", launch: playbook.context.launch });
      return result;
      ```
    done: false
````

Changing the template does not bring new blocks into existing Runs. After adding the orchestration block to the template, call `playbook_run {op:"start", name:"编排检查"}` and use the Run ID it returns; below it is assumed to be `r2`, use the actual returned value.

Call `playbook_launch {op:"launch", run:"r2", blocks:["b3"]}` to get the Launch ID; below it is assumed to be `l2`, use the actual returned value. Then send an eval whose **entire code is just this one line**:

```js
await playbook.exec("l2")
```

`exec` is an entry point that the extension intercepts and replaces the whole cell with; it is not an ordinary helper, and no code may come before or after it. With several documents connected, write `await playbook.exec("l2", "/absolute/path/playbook.yaml")`. What runs is the orchestration code in the Launch's current baseline (the code frozen at launch until a `rebase`), with `timeout: 0` forced; the JS helpers default to that Launch's document and Run. Raw `tool.playbook_*` calls do not inherit those defaults: with several documents connected pass `doc` explicitly, and for Run operations also pass `run` as the tool arguments require.

Python orchestration sets the **Python variables** `PLAYBOOK_DOC`, `PLAYBOOK_RUN` and `PLAYBOOK_LAUNCH`, not environment variables, and does not inject the JS `playbook` helpers; use the `tool` and `agent` interfaces of Python eval directly, which needs omp's Python backend.

## Checks are not completion or approval

Cards show the deterministic checks `compile`, `render_error` and `render_pending`; execution blocks also check `empty_expansion` and table charts, design blocks check `draft`. Checks do not prove a business design correct; apart from Launch constraints such as compile failures, a failed check does not gate a launch.

`jev` is a separately reported model judgment:

- `playbook_check inspect` returns `{blocks, source, compiled, view, findings, version}` and **currently returns no question definitions**.
- The current fixed question is `missing`: does the full compiled prompt mention logs, discussions, files or earlier results whose content it does not include? The main session can answer it in eval with an available `judge`.
- The report shape is `result: {kind:"answers", answers:{missing: P(yes)}}`, with the probability in 0–1; `P(yes) >= 0.5` shows as failed. With no judge available, report `{kind:"judge_unavailable"}`, which shows as not judged, not as passed.
- The report must carry the latest `version` for the same document, the same Run and the same ordered block list. Stale reports are ignored; a change to the input invalidates the old judgment.

The "检查" (Check) button refreshes the deterministic checks and notifies the coordinator; it never calls a model itself. There is no design-approval state and no automatic transition from checks to `done`.

## Development checks

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
