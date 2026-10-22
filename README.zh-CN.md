# omp-playbooks

[English](README.md) | 简体中文

omp-playbooks 把**设计、执行 prompt 和编排代码**放在一份可共同编辑的 Playbook 里。它由 omp 扩展和 Tern 文档服务组成：主会话通过 `playbook_*` 工具连接文档服务，人在旁边的 pane 中看卡片、改内容、提交修改要求。

设计和执行是分开的：设计块对应一个设计或业务单元，执行块通过引用组合所需的需求、设计面板、上下文和先前结果。一个执行块可以引用多个设计块，并不要求设计与 task 一一对应。

| 对象 | 在这里负责什么 |
|---|---|
| 人 | 直接改需求、执行正文和标题；查看可视化设计；手动提交设计修改 prompt、请求启动或检查 |
| omp 主会话（协调者） | 自己修订设计；调用工具建立 Run、编译 prompt；决定怎样启动和编排 subagent、处理变更通知及记录结果 |
| 文档服务 | 保存文档、Run、Launch 和记录；解析引用；绘制卡片与设计组件；加锁、做确定性检查、向协调者发通知 |
| subagent | 执行协调者交给它的编译后 prompt；不拥有这份 Playbook 的工具或 UI |

**按钮是请求，不是自动执行器。** “提交修改”把修改 prompt 交给主会话；“启动”通知主会话去执行；“检查”请求主会话补做模型判定。扩展不会因收到通知就自行修订设计、启动 worker 或认可结果。

## 安装与打开

需要 [Bun](https://bun.sh)、omp 和 Tern。加载扩展的进程必须能从 `PATH` 找到 `tern`；启动文档服务的环境必须能执行 `bun`。使用 GitHub issue/PR 引用时还需要已认证的 `gh`。

仓库是 [oh-my-omp/omp-playbooks](https://github.com/oh-my-omp/omp-playbooks)；安装后的 omp 包名和 Tern 插件 ID 都是 `omp-playbooks`，下文的升级、卸载命令都用这个名字。

```sh
omp plugin install 'https://github.com/oh-my-omp/omp-playbooks.git#main'
```

扩展加载时检查 Tern，并把包内的 `tern-plugin/` 链接到 Tern；已链接到同一目录时跳过。链接的就是 omp 安装目录本身。Tern 守护进程会自己重新加载原地修改的插件文件，但升级会整个替换安装目录，守护进程会停在“链接目标不存在”或旧版本上。所以扩展随后比较 `tern-plugin/plugin.toml` 的版本和守护进程已加载的版本，不同时执行 `tern plugin reload`，并在主会话提示结果。重新加载后版本仍不一致时只警告、不中断安装，下次加载扩展会再比较。

**拉取仓库或重启会话不会更新已安装的插件副本。** 已安装过旧实现时先更新：

```sh
omp plugin upgrade omp-playbooks
```

更新后启动新的 omp 会话；已运行的扩展和文档服务不会热替换。先妥善结束正在执行的工作，再关闭旧文档服务 pane，由新会话重新打开。`playbook_open` 会复用已有服务，不能借它强制换成新服务。每次推到 `main` 后，CI 把 `package.json` 和 `tern-plugin/plugin.toml` 的版本最后一位同时加一，所以版本号可以区分新旧代码。

卸载时分别移除两侧：

```sh
omp plugin uninstall omp-playbooks
tern plugin unlink omp-playbooks
```

打开文件有三条路径：

- **从主会话打开：** 先写好 YAML 文件，再调用 `playbook_open {doc: "/绝对路径/playbook.yaml"}`。没有服务时，扩展在当前 omp pane 右侧启动服务；这一步要求 omp 运行在 session daemon 托管的 Tern pane 中，环境带 `TERN_PANE`。已有服务时只连接，不另开 pane，也不自动切换焦点。
- **从 Tern 打开：** 聚焦 `.yaml` 或 `.yml` 文件 pane，在命令面板选“Playbook: 打开”。已有服务时显示它，否则在旁边启动。此操作不启动 omp、不建立协调者连接。
- **从源码启动服务：** 在仓库安装依赖后，在 Tern pane 中运行下面的命令。随后主会话仍需调用 `playbook_open` 才能接收请求。

```sh
bun install
bun src/service/main.ts /绝对路径/playbook.yaml
```

同一文件只有一个在线服务和一个协调者连接。另一个主会话在原协调者仍连接时会得到 `Busy`。原会话结束后，文档 pane 保留并显示“没有协调者连接”；新会话可以接管。没有 `TERN_PANE` 的 omp 也可以连接**已经启动**的服务，但不能从那里在旁边创建 pane。

主会话命令：

- `/playbook-show [文件路径]`：转到已连接文档的 pane。
- `/playbook-add [文件路径]`：选择最近会话消息、Run、记录类别及可选块，加入时间线。

这些命令和 `playbook_*` 工具只注册在主会话，subagent 看不到它们。

## 文件与两种块

下面保存成 `playbook.yaml` 即可打开；不需要网络、外部文件或 `am` CLI：

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

| 块 | 文件字段 | 用途和编辑入口 |
|---|---|---|
| 设计块 | `requirement`、`design` | 人直接改需求；主会话改可视化设计稿。不能直接启动 |
| 执行块 | `body`；可选 `agent`、`isolated` | 人或主会话直接改 Markdown/prompt；可以作为上下文被引用，也可以在 Run 中启动。`agent`、`isolated` 是它的执行契约：启动 subagent 时默认使用的 agent，以及是否让 worker 在独立 worktree 中工作 |
| 编排块 | 同样是 `body`，正文整体为一个 `js` 或 `py` 代码围栏 | 执行协调者的编排代码，不把它当成普通 worker prompt |

每个块必须有 `id`、`title`、`done`，以及对应的内容字段。ID 为 `b1`、`b2` 等正整数编号，不能重复。YAML **不写 `kind`**；类型由字段决定。混写 `body` 和 `requirement`/`design`、缺字段、未知字段会被拒绝。`agent`（去掉首尾空白后非空的字符串）和 `isolated`（布尔值）只能写在执行块上；不写时文件里也不出现。多行内容建议用 `|`，空需求或空设计用空字符串或空块标量。

`done` 是显式填写或勾选的标记，不是设计认可状态，也不从检查、subagent 返回值或 Launch 状态推导。现有只有 `body` 的文件仍可使用。

### 人怎么编辑

1. 标题、执行正文、需求：点对应的“编辑标题”“编辑正文”“编辑需求”，改文字，再点“完成”（或按 `Esc` 提交，`Esc` **不是撤销**）；点“放弃”丢弃当前草稿。
2. 设计：查看绘制结果，点“写修改 prompt”，精确写下哪里要改、改成什么，再手动点“提交修改”。主会话收到通知后读块并修订 `design`，不会改 `requirement`。
3. 修改 prompt 的 `Esc` **不提交**。点“放弃”丢弃当前草稿。空 prompt 或没有协调者连接时提交被拒，草稿保留在编辑框里。
4. 设计稿里的 `ask` 显示为单选或多选控件，默认选中 `*` 推荐项。改选后点“提交选择”，面板把 `针对问题「<问题>」，选择：<选项>` 作为这个设计块的修改 prompt 提交，和手写的修改 prompt 一样进入修改记录并通知主会话；主会话修订设计时把已回答的 `ask` 换成对应的设计结论。没有协调者连接时提交被拒，这段文字留在修改 prompt 编辑框里；块被锁、已有其他草稿、Run 已结束或没有选中项时按钮不可用。
5. 一个服务内，包括模板和各 Run，同时只能有一个人的字段草稿。编辑锁覆盖整个块；人正在编辑时，协调者不能写同一块。协调者持锁时可点“打断”收回块。

块多时可点状态行的“折叠”，卡片只留状态行（含锁状态）、标题和提示；顶部“全部折叠”“全部展开”作用于当前文档的所有卡片。折叠只影响显示：检查结果和 `playbook_check inspect` 返回的视图与展开时相同，正在编辑的草稿也保留，展开后继续。执行块设置了 `agent` 或 `isolated` 时，状态行显示对应标识。

提交成功的 prompt 进入只追加的修改记录，卡片中的“修改记录”默认折叠。记录的是**人的修改要求**，不是设计版本快照、设计 diff 或 AI 回复；普通读块不会自动附带它。

```json
{"op":"revisions","block":"b1","after":0}
```

上面是 `playbook_read` 的参数；查询 Run 的记录还要加 `run`。`after` 是记录序号，返回比它大的记录。新 Run 不继承模板的修改历史。

## 模板、Run、Launch

| 对象 | 开始与结束 | 不会自动发生的事 |
|---|---|---|
| 模板 | 原始 YAML，供各次 Run 复制 | 改模板不会同步改已有 Run |
| Run | “开始 Run”或 `playbook_run start` 复制模板；所有 `done` 重置为 `false`。结束后不能通过卡片或工具编辑块 | 开始 Run 不启动 agent；结束 Run 不要求所有块已 done |
| Launch | 对 Run 的执行块编译，冻结 prompt/编排代码并建立记录；显式关闭、`playbook.result` 收尾或结束 Run 时关闭 | `launch`/`bind` 不启动 worker；`playbook_timeline` 写结果本身不关闭 Launch；关闭记录不取消 worker |

Run 有独立的块内容、修改记录和时间线。**在面板中点“开始 Run”会自动切换到新创建的 Run 标签**；若由协调者调用 `playbook_run start` 创建，也在该 Run 标签中编辑或启动，工具调用传返回的 Run ID，例如 `r1`。不传 `run` 的读、改、编译、检查工具操作的是模板。

Run 中点执行块的“启动”，会向协调者发 `launch_requested`。勾选多个块时，按文档顺序组合启动目标；设计块不能启动，编排块只能单独启动。主会话再调用执行工具，worker 才会真正开始工作。

一个执行块可以引用多个设计块，也可以把多个执行块一起编译成同一个 Launch。subagent 得到的是冻结后的文本，不是 UI、实时设计页面或隐式的 Playbook 上下文。

### 执行中的变更

文档服务会重新编译受影响的活跃 Launch，与基线比较；编译文本改变或编译失败时，经过约 2 秒合并通知协调者。人的内容修改、磁盘内容修改，以及协调者修订设计，都可能触发通知；标题、`done`、协调者自己修改执行正文不会触发同样的内容变更通知。活跃指未关闭且属于当前连接的协调者会话；新会话接管文档不会接管旧会话的 Launch。

通知不会自动改正在运行的 worker prompt。协调者决定是否告知 worker、重新安排工作或调用 `playbook_launch rebase` 接受当前编译结果为新基线。`rebase` 把当前编译结果追加为新基线，最初冻结的快照仍留在 Launch 记录里；之后 `playbook.spawn` 和编排块的 `playbook.exec` 使用最新基线。已关闭的 Launch 不能再 `bind` 或 `rebase`。

### 记录与文件

以 `playbook.yaml` 为例：

| 文件 | 内容 |
|---|---|
| `playbook.yaml` | 模板 |
| `playbook.yaml.revisions.jsonl` | 模板的修改 prompt 历史 |
| `playbook.yaml.pb.jsonl` | 服务编号分配记录 |
| `playbook.runs/r1.yaml` | Run 的块和运行元数据 |
| `playbook.runs/r1.jsonl` | Run 时间线及 Launch 记录 |
| `playbook.runs/r1.revisions.jsonl` | Run 的修改 prompt 历史 |

`.yml` 文件的 Run 目录保留后缀，例如 `example.yml.runs/`。结束 Run 会关闭它的 Launch 记录、解除锁、丢弃未提交草稿并保存结束时间；不会回写模板，也不会替代对仍运行 agent 的停止操作。

时间线可写 `update`、`result`、`failure`、`retrospective`。复盘只在 Run 结束后写。`update_every` 和 `next` 是正整数秒；到期只是通知，不会自动生成更新。结果只有关联到 `block` 时才可通过该块的 `.result` 引用读取。

服务约每秒检查磁盘文件，已提交的编辑约一秒后写回 YAML。直接修改 YAML 的内容字段也会载入，包括设计稿；卡片中的编辑分工不是文件系统权限限制。无效 YAML 会显示解析错误并保留上次有效内容，恢复有效后才继续写回。磁盘改动不会替你提交人的草稿；同字段变化会提示，随后点“完成”仍会应用草稿。已结束 Run 的块只在 UI/工具路径禁止修改，不是磁盘文件不可变。

## 引用与编译

执行正文使用 `((target))` 或 `((target | selector, selector))`。多个选择结果按书写顺序用空行连接。引用必须在一行内；行内代码和代码围栏中的引用不会展开。

| 目标 | 示例 | 编译得到什么 |
|---|---|---|
| 设计块 | `((b1))` | 原始需求与设计，分别包在 `<requirement>`、`<design>` 中 |
| 设计字段/面板 | `((b1 \| requirement, panel(B)))` | 原始需求与显式 `## B …` 面板全文，包含面板标题 |
| 执行块 | `((b2))` | 递归展开的正文；可用 `lines(1..3)`、`section("标题")` 先选原文再展开 |
| Run 中的块结果 | `((b2.result))` | 最新关联到该块的 `result` 记录；也支持 `lines`、`section`，不递归展开 |
| 本地文本文件 | `((file:notes.md \| section("背景")))` | 相对 Playbook 所在目录取回的文本；也支持 `lines`，不会递归展开 |
| GitHub issue/PR | `((https://github.com/owner/repo/issues/1 \| title, body))` | issue/PR 标题、正文或讨论评论；需已有 `gh` 认证 |

规则与边界：

- 设计块支持 `requirement`、`design`、`panel(A)`；面板必须在标题里手写单个大写字母 ID，例如 `## A 结论`。自动显示编号不是可引用 ID。需求和设计里的 `((…))` 都保持原样，不取回、不递归展开。
- `lines` 是从 1 开始的闭区间，写成 `lines(1..3)`；`section` 不包含选中标题，包含其下级章节。它们不能用于设计块。
- GitHub 只支持标准 `https://github.com/<owner>/<repo>/issues/<n>` 或 `/pull/<n>` 地址。`comments`、`comments(1..2)`、`comments(-1)` 选择按时间排序的讨论评论；PR 不包含 diff、文件、review 或行内 review comments。任意网页 URL 不支持。
- 外部文本使用 `<external source="…" fetched="…">` 包装，显示取回时间。取回是副本，不是持续同步；需要最新内容时手动“重新取回”或用 `refetch`。
- `file:` 允许 `../`，**没有**设计稿图片/`src=` 的目录沙箱或秘密扫描；只引用愿意交给 subagent 的文件。
- 不存在的块、面板、结果、章节，越界行号、取回失败、循环引用都会编译失败。块引用链最多 8 层，包含根块。

“预览”与 `playbook_compile` 只展示编译结果，不启动工作。

## 设计稿与组件

组件格式参考 [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html)，**解析与渲染由本仓库实现，不调用它的 CLI，也不是嵌入浏览器页面**。正文与公式交给 Tern 的原生 Markdown 节点；图类组件生成静态 SVG，其余使用原生 TSP 节点。

### 稿头与面板

- 可选稿头必须在第一行，以 `---` 开始/结束；只支持逐行 `key: value`，不是完整 YAML。
- `template: sheet` 为网格，`doc` 为单列。`cols` 范围 1–6，默认 3。支持 `title`、`subtitle`；未设置稿头 `title` 时，正文第一条非空行若为 `# 标题`，会提取为稿头标题并从正文移除；先写说明再写标题不会触发提取。
- `## A 标题 {span=2 bare meta="说明"}` 开始面板。`span` 指定占列数，`bare` 去掉卡片外框，`meta` 显示补充文字；面板高度随内容。`rows` 被解析但不参与布局。
- `lang` 忽略；`theme`、`mode`、`style` 忽略并提示警告；其余稿头键作为文字元数据显示。
- 面板 ID 为单个大写字母，不能重复。部分组件的原生文本标签支持行内代码、粗体、斜体和删除线；flow 与 ER 标签按普通文字显示，sequence 标签移除这些标记后显示纯文本。不要把组件标签当成完整 Markdown 渲染器。

### 当前支持的写法

下面都是**设计稿内**的组件。执行正文不会用这套组件解析器绘图。

| 组件 | 围栏首行与正文写法 |
|---|---|
| `flow` | `flow LR`；`Client -> [API] -> [(Cache)]: read`；方向 `TB/LR/BT/RL`，默认 `TB`；`-->` 虚线，`{Choice}` 菱形、`(Reply)` 圆角 |
| `er` | `er LR`；实体独占一行，缩进字段如 `id uuid PK`、`user_id uuid FK -> User`；关系如 `User 1--* Order: owns` |
| `sequence` | `sequence num`；`participants: Client, API`，`Client -> API: request`，`API --> Client: reply`；支持 `note API: 说明` 与 `== 阶段 ==` |
| `tree` | `tree list`；缩进表示父子，`名称 \| 说明`；省略 `list` 时自动选布局 |
| `timeline` | `timeline h` 或 `timeline v`；`09:00 \| 开始 \| 说明`，时间前加 `*` 突出 |
| `limits` | `limits`；`Latency \| 13 / 20 \| ms \| p95` 或 `Workers \| max 8 \| count` |
| `annot` | `annot`；正文 `结果可能[过期]{!读取前刷新}`，`# 标题 \| 旁注`、`> 图注` |
| `kv` | `kv cols=2`；`存储: Redis`，`*不变量: 一个源头` 为通栏项 |
| `callout` | `callout warn 缓存失效`；正文为 Markdown；类型 `info/ok/warn/err` |
| `ask` | `ask` 或 `ask multi`；首行问题，随后 2–6 个 `* 推荐项 \| 说明` 或 `- 其他项 \| 说明`；单选必须恰有一个推荐项；面板中可点选并“提交选择”，见[人怎么编辑](#人怎么编辑) |
| `diff` | `diff file=src/value.ts title="变更"`；正文直接贴 unified diff，不从 `file` 加载；支持 `start`、`hl` |
| `html` | `html`；结构化标签如 `<section><h3>方案</h3><p><strong>结论</strong></p></section>`，转换为 TSP，不运行网页 |
| `svg` | `svg`；完整、静态、安全的 `<svg>`，建议明确 `viewBox` 或 `width`/`height` |
| 代码 | 其他语言围栏如 `ts title="片段" start=18 hl=19`；正文直接写代码，或用 `ts src=sample.ts lines=1-2 hl=2` 读取文件 |
| 表格 | Markdown 表格；数据单元格的独立小写状态词 `ok`、`no`、`warn`（可跟空格和说明）显示状态图标 |
| 图片 | 单独一行 `![说明](image.png)`，读取本地图片文件 |

`flow`、`er`、`tree` 支持 `+ `、`- `、`~ ` 变更标记，并提供“变更/之前/之后”视图。`~` 标出已修改声明，不储存两份旧新内容；flow 的边、ER 的关系要用一删一增表达修改。新增/删除的 tree 父节点、ER 实体会把标记传给子项。

### 不要当成浏览器能力

- `html` 不保留普通 `class/style/id` 等属性；链接显示为文字与地址，按钮没有动作；脚本、样式和嵌入页面被移除。不是任意 HTML/CSS 页面、交互表单或 web app 渲染器。
- `svg` 拒绝脚本、事件、`foreignObject`、外部链接和外部 CSS 资源。HTML 内嵌 SVG 会清理不安全内容并提示。具体 SVG 绘制能力仍由 Tern 决定。
- Mermaid 围栏在这里按普通代码显示，不转成图。`flow/er/sequence` 有各自语法，不能直接粘 Mermaid DSL。
- 图片仅从 Playbook 目录内加载，远程 URL 或 data URL 只展示说明/地址并警告。图片及 `src=` 都检查真实路径，不能通过 `../` 或符号链接越出目录。
- 本地嵌入文件上限 5 MiB；代码 `src=` 还有 2 MiB 上限、二进制/凭据路径/秘密内容检查。`lines=1-2` 的写法与引用的 `lines(1..2)` 不同；`hl` 使用显示行号。`src=` 的整个文件先做秘密扫描，再截取行号。
- 单个围栏正文超过 1000 行不绘制；代码与 diff 超过 200 行报错，超过 40 行警告。错误和警告都显示行号，只有错误使 `draft` 检查不通过。空设计不会因此自动判错。

## 协调者工具

下面是工具参数，不是 shell 命令。只有恰好连接了一份文档时才能省略 `doc`；所有输入严格校验，不接受额外字段。普通 `playbook_read` **不写 `op: "read"`**。

| 工具 | 调用参数 |
|---|---|
| `playbook_open` | `{doc}` |
| `playbook_read` | `{doc?, run?, block?}`；历史 `{doc?, run?, op:"revisions", block?, after?}` |
| `playbook_edit` | `{doc?, run?, op:"title"或"done", block, value}`；`replace` 用 `{block, find, replace}`；`write` 用 `{block, text}`；`panel` 用 `{block, panel, text}`；`insert` 用 `{after?, title, body, agent?, isolated?}`；`insert_design` 用 `{after?, title, design}`；`delete` 用 `{block}`；`move` 用 `{block, after}`，`after` 为块 ID 或 `null`（移到首部）；`agent` 用 `{block, value}`，值为字符串或 `null`（清除）；`isolated` 用 `{block, value}`，值为布尔或 `null`；每项还要传 `op` |
| `playbook_compile` | `{doc?, run?, op:"compile", blocks:[…]}`；重新取回 `{doc?, run?, op:"refetch", targets:[…]}` |
| `playbook_check` | `{doc?, run?, op:"inspect", blocks:[…]}`；报告 `{doc?, run?, op:"report", blocks:[…], version, result}` |
| `playbook_run` | `{doc?, op:"start", name, update_every?}`、`{doc?, op:"finish", run}`、`{doc?, op:"list"}` |
| `playbook_timeline` | `{doc?, op:"read", run, after?}`；`{doc?, op:"post", run, kind, text, block?, launch?, next?, quote?}`；`{doc?, op:"snooze", run, after}` |
| `playbook_launch` | `{doc?, op:"launch", run, blocks:[…]}` → `{launch, kind, text, agent?, isolated?}`；`{doc?, op:"bind", launch, agent}`；`{doc?, op:"info"或"rebase"或"close", launch}` |

`playbook_edit` 的 `write/replace` 只改执行正文或设计稿，不能改需求；`replace` 的 `find` 必须恰好出现一次。`panel` 的 `text` 必须是以 `## <ID> 标题` 开始的整个替换面板。`insert_design` 的需求固定从空开始，由人填写。`move` 在位置不变时不写记录。`agent`、`isolated` 只用于执行块，修改它们不改变编译文本，不触发执行中的变更通知；`launch` 只在所有根块对某一项预设了相同值时返回该项。修改已有块时，一个调用内完成加锁、修改、解锁。

### 跑一次执行块

以上面的文件为例，由主会话依次调用：

1. `playbook_open {doc: "/绝对路径/playbook.yaml"}`。
2. `playbook_compile {op: "compile", blocks: ["b2"]}`：查看展开的需求和 B 面板。
3. `playbook_run {op: "start", name: "检查缓存方案"}`：取得返回的 Run ID。以下假设为 `r1`，实际以返回值为准。
4. 在主会话的 **JS eval** 中启动 worker：

```js
var worker = await playbook.agent({
  run: "r1", blocks: ["b2"], agent: "task:mid", label: "检查缓存方案"
});
```

`playbook.agent` 在 worker 启动并绑定后立即返回。`worker` 是顶层变量，后续 eval 单元仍可使用；用 omp 的 `wait` 工具等待 worker，期间主会话照常处理面板上的修改请求和变更通知。worker 结束后另发一个 eval：

```js
return await playbook.result(worker);
```

它把结果记到 b2（Launch 只有一个块时自动关联）并关闭这个 Launch。不需要中途响应面板时，也可以用一次阻塞调用 `await playbook.run({ run: "r1", blocks: ["b2"], agent: "task:mid" })` 完成启动、等待、记录和关闭。

5. 检查输出；需要时显式 `playbook_edit {op:"done", run:"r1", block:"b2", value:true}`，或者由人勾选。最后 `playbook_run {op:"finish", run:"r1"}`，再写复盘。

`task:mid` 必须是当前 omp 可用的 agent；扩展不提供或配置它。调用时没有指定 `agent` 就用块上预设的 `agent`，块也没有预设时用 omp 的默认 agent；默认被禁用时必须显式指定或在块上预设。`isolated` 同样按“显式传参 > 块上预设 > 不传”决定。

JS eval 的 `playbook` 由扩展注入，不要自行加导入行。辅助方法：

| 方法 | 行为 |
|---|---|
| `playbook.run({run, blocks, …})` | `playbook.agent` 加 `playbook.result`：创建 Launch、启动并绑定一个 worker、等待、记结果并关闭 Launch |
| `playbook.agent({run, blocks, …})` | 创建 Launch 并启动、绑定 worker，返回 `{launch, blocks, id, handle, …}`，不等待；未传的 `agent`、`isolated` 取块上的预设；对编排块先关闭刚建的 Launch 再报错 |
| `playbook.result(worker, {block?, close?})` | 等待并写 `result`，未给 `block` 时关联到 Launch 唯一的块；等待异常写 `failure` 并抛出。写完后按 `close` 关闭 Launch，默认在 worker 由 `playbook.agent` 创建时关闭 |
| `playbook.spawn(launch, {…})` | 在未关闭的 prompt Launch 上增加 worker，使用最新基线（`rebase` 后即新文本）；它不拥有该 Launch，`result` 默认不关闭；Launch 已关闭时报错 |
| `playbook.read({run?, block?})` | 读块；没有历史查询辅助，历史仍用 `playbook_read` 工具 |
| `playbook.post({run, kind, text, …})` | 写记录 |
| `playbook.timeline({run, after?})` | 读时间线 |
| `playbook.context` | 编排执行时的 `{doc, run, launch}`；普通 eval 中为空 |

辅助方法不会自动设 `done` 或结束 Run。并行时用多个 `playbook.agent` 启动 worker，各自存进顶层变量，之后分别 `result`；多个 worker 共用一个 Launch 时用 `playbook.spawn` 加入，最后收尾的那个传 `{close: true}`，或调用 `playbook_launch {op:"close"}`。含 `playbook.run/result` 且未显式给 `timeout` 的单元会设置 `timeout: 0`。

### 编排块

可把下面的块加到示例文件的 `blocks` 下；使用恰好三个反引号的 `js`/`py` 围栏，正文不能另外夹说明文字：

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

修改模板不会把新块带入已有 Run。把编排块加入模板后，再调用 `playbook_run {op:"start", name:"编排检查"}`，使用这次返回的 Run ID；下面假设为 `r2`，实际以返回值为准。

调用 `playbook_launch {op:"launch", run:"r2", blocks:["b3"]}` 取得返回的 Launch ID；下面假设为 `l2`，实际以返回值为准。然后发**一个完整代码只有下面这一句**的 eval：

```js
await playbook.exec("l2")
```

`exec` 是扩展拦截并替换整个单元的入口，不是普通辅助方法；不允许在这句前后追加代码。连接多份文档时可写 `await playbook.exec("l2", "/绝对路径/playbook.yaml")`。执行的是 Launch 当前基线里的编排代码（没有 `rebase` 过就是启动时冻结的代码），强制设置 `timeout: 0`；JS 辅助默认取该 Launch 的文档与 Run。原始 `tool.playbook_*` 调用不继承这些默认值：连接多份文档时需显式传 `doc`，操作 Run 时还需按工具参数要求显式传 `run`。

Python 编排会设置 **Python 变量** `PLAYBOOK_DOC`、`PLAYBOOK_RUN`、`PLAYBOOK_LAUNCH`，不是环境变量，也不注入 JS 的 `playbook` 辅助；直接使用 Python eval 的 `tool`、`agent` 接口，需要 omp 的 Python 后端可用。

## 检查不等于完成或认可

卡片显示确定性检查：`compile`、`render_error`、`render_pending`；执行块另检查 `empty_expansion` 与表格图表，设计块检查 `draft`。检查不负责证明业务设计正确；除编译失败等 Launch 自身约束外，其他检查不通过不是启动门禁。

`jev` 是另行报告的模型判定：

- `playbook_check inspect` 返回 `{blocks, source, compiled, view, findings, version}`，**当前不返回问题定义**。
- 当前固定问题 `missing`：完整编译 prompt 是否提到未包含其中的日志、讨论、文件或先前结果内容？主会话可以在 eval 中用可用的 `judge` 回答。
- 报告形状为 `result: {kind:"answers", answers:{missing: P(yes)}}`，概率必须在 0–1；`P(yes) >= 0.5` 显示不通过。judge 不可用时报告 `{kind:"judge_unavailable"}`，显示未判定，不当作通过。
- 报告须带同一文档、同一 Run、同一顺序块列表的最新 `version`。过期报告会被忽略；输入变化使旧判定失效。

“检查”按钮会更新确定性检查并通知协调者；不会自己调用模型。没有设计认可状态，没有从检查到 `done` 的自动转换。

## 开发检查

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
