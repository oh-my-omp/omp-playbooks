# omp-playbooks

[English](README.md) | 简体中文

omp-playbooks 把**设计、执行 prompt 和编排代码**放在一份可共同编辑的 Playbook 里。它由 omp 扩展和 Tern 文档服务组成：主会话通过 `playbook_*` 工具连接文档服务，人在旁边的 pane 中把块当卡片读、就地编辑，并请求启动和设计修改。

设计和执行是分开的：设计块对应一个设计或业务单元，执行块通过引用组合所需的需求、设计面板、上下文和先前结果。一个执行块可以引用多个设计块，并不要求设计与 task 一一对应。

Playbook 文件自己携带执行状态：每个跟踪的块有 `status`（`todo`、`running`、`done`），执行这个块的 subagent 自己把状态和完成报告 `report` 写进文件。

| 对象 | 在这里负责什么 |
|---|---|
| 人 | 就地改标题、执行正文、需求和选项；查看可视化设计；请求设计修改、启动和打断；勾选完成 |
| omp 主会话（协调者） | 自己修订设计；调用工具编译 prompt、建立 Launch；决定怎样启动和编排 subagent，按请求停止它们，处理变更通知及记录结果 |
| 文档服务 | 保存文档、Run、Launch 和记录；解析引用；绘制面板与设计组件；加锁、做确定性检查、向协调者发通知 |
| subagent | 执行协调者交给它的编译后 prompt，再把所执行块的 `status` 和 `report` 写进 Playbook 文件；不拥有这份 Playbook 的工具或 UI |

**按钮是请求，不是自动执行器。** “启动”通知主会话去执行；“打断执行”请求它取消 worker；修改要求或在设计上选的选项把修改交给主会话。扩展不会因收到通知就自行修订设计、启动或取消 worker、认可结果。

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

同一文件只有一个在线服务和一个协调者连接。另一个主会话在原协调者仍连接时会得到 `Busy`。原会话结束后，文档 pane 保留，底部状态栏显示“协调者离线 · 选择协调者”；新会话可以接管，人也可以在面板里选一个（见[面板布局](#面板布局)）。没有 `TERN_PANE` 的 omp 也可以连接**已经启动**的服务，但不能从那里在旁边创建 pane。

主会话命令：

- `/playbook-show [文件路径]`：转到已连接文档的 pane。
- `/playbook-add [文件路径]`：选择最近会话消息、Playbook 本身或某个 Run、记录类别及可选块，加入对应的执行记录。

这些命令和 `playbook_*` 工具只注册在主会话，subagent 看不到它们。

## 文件与块

下面保存成 `playbook.yaml` 即可打开；不需要网络、外部文件或 `am` CLI：

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

| 块 | 文件字段 | 用途和编辑入口 |
|---|---|---|
| 设计块 | `requirement`、`design`、`status` | 人就地改需求；主会话改可视化设计稿。不能启动 |
| 执行块 | `body`、`status`；可选 `report`、`agent`、`isolated` | 人或主会话改正文；可以作为上下文被引用，也可以启动。`agent`、`isolated` 是它的执行契约：启动 subagent 时默认使用的 agent，以及是否让 worker 在独立 worktree 中工作 |
| 编排块 | 同样是 `body`，正文整体为一个 `js` 或 `py` 代码围栏 | 执行协调者的编排代码，不把它当成普通 worker prompt；只能单独启动 |
| 不跟踪的执行块 | `body`、`task: false`；可选 `agent`、`isolated` | 通则之类的共享上下文：没有状态和报告，不计数、不能启动，但可以被引用 |

每个块必须有 `id`、`title` 和对应的内容字段，另外要么写 `status`，要么写 `task: false`。ID 为 `b1`、`b2` 等正整数编号，不能重复。YAML **不写 `kind`**；类型由字段决定。混写 `body` 和 `requirement`/`design`、缺字段、未知字段会被拒绝。`agent`（去掉首尾空白后非空的字符串）和 `isolated`（布尔值）只能写在执行块上；不写时文件里也不出现。`task` 只能是 `false`、只能写在执行块上，这样的块不能有 `status` 或 `report`。设计块不会是 `running`，也没有 `report`。多行内容建议用 `|`，空需求或空设计用空字符串或空块标量。

`status` 是执行状态，不是设计认可，也不从检查、subagent 返回值或 Launch 记录推导。`report` 是完成报告：subagent 把块改成 `done` 时一并写入，面板只读显示。仍使用旧字段 `done:` 的文件会被拒绝；把 `done: false` 改成 `status: todo`，`done: true` 改成 `status: done`。

### Where/What/How

卡片上的文字是写给人看的，所以每个执行正文（跟踪的或 `task: false`）和每份设计都按 Where/What/How 写：标题以角色词开头的 `## ` 面板。

| 角色 | 标题 | 面板写什么 |
|---|---|---|
| Where | `## A Where · 现状` | 对象、位置、范围、现状与证据 |
| What | `## B What · 决定` | 目标、决定、预期结果与边界 |
| How | `## C How · 处置` | 步骤、验证、失败处理与回退 |

三个角色都要有内容，并按这个顺序出现。一个角色可以占几个面板（`## D How · 验收与回退`）；导语和不带角色的面板放在哪里都行。角色词区分大小写，后面是标题结尾、空格或分隔符（`·`、`:`、`：`、`|`、`-`、`—`）；角色面板不能设 `bare`，否则标题不显示。空文字算作还没写。编排块是代码，不受此约束；人的 `requirement` 和完成报告也不受。展开的卡片在文字下方列出不符合之处，`playbook_check` 把它报告为 `outline`；两者都不阻止启动。

### 面板布局

面板单列显示 Playbook 文件本身；Run 不在面板里显示。最上面是文档标题（双击可改），下面按文件顺序每块一张卡片，底部是 dock。

- **卡片标题行：** 编号（不跟踪的块是 `--`，跟踪的块依次是 `01`、`02`…）、标题、状态图标（空心圆 `todo`、转圈 `running`、对勾 `done`）和折叠箭头。点标题或箭头展开/收起卡片；双击标题改标题。
- **状态图标：** 点击在 `done` 和 `todo` 之间切换，并用 `status_changed` 通知协调者。勾选完成不改动块的报告。
- **展开的卡片：** “⋯”打开菜单，里面是“粘贴剪贴板图片”和“删除此块”。正文用下文的组件绘制。执行块底部显示“SUBAGENT”（即 `agent`）和“独立 WORKTREE”（双击切换 `isolated`），再下面是启动按钮。`done` 的块改为显示折叠的“完成报告”，点击展开。
- **SUBAGENT 下拉框：** 点击后列出“默认”（不指定，用 omp 的默认 subagent）和协调者的 omp 会话此刻能启动的 subagent 类型，选中即写入 `agent`。每次打开下拉框都会向协调者重新询问：扩展从会话内置的 `task` 工具读取这份列表，其中已去掉被禁用的 agent 并应用了 spawn 策略。协调者离线或会话无法列出时，下拉框会说明原因，只提供“默认”。已保存但会话不再列出的名称仍作为当前设置显示，不会被自动改掉；启动时 omp 还会再检查一次。
- **启动按钮：** “启动”为这个块发出 `launch_requested`；在协调者从这个块建立 Launch 之前，按钮显示“已请求启动”且不能再点。块在 `running` 时按钮变成“打断执行”：有未关闭的 Launch 时向协调者发 `stop_requested`；没有时说明并没有在执行，块直接改回 `todo`。
- **一起启动多块：** ⌘ 点卡片标题选中跟踪的执行块；dock 显示“一起启动 N 块”和“取消”。这些块按文档顺序合成一个 Launch；编排块只能单独启动。
- **dock 状态栏：** “协调者在线”（点击转到协调者的 pane）或“协调者离线 · 选择协调者”，以及“N / M 已完成”（跟踪块中的完成数）。
- **选择协调者：** 离线时点状态栏，列出这个 Tern 窗口里（窗口包含的所有会话）运行 omp 的 pane；每次打开都重新向 Tern（`tern inspect`）读取。运行本版本 omp-playbooks 的 omp 会话可以选；其他 omp pane 也会列出但不能选，升级 omp-playbooks 之前就已在运行的 omp 会话需要先重启。选中后，扩展通过它为自己 pane 保留的 socket 让该会话立即连接这份 Playbook，效果等同 `playbook_open`，并在它的对话里留一条通知（不开始新的一轮）；一个会话可以同时协调多份 Playbook。随后 Playbook pane 被移到那个 omp pane 的右半边（`tern move … right-of …`），无论两者原来嵌套多深。“新建会话”在 Playbook pane 左侧新开一个 omp pane，启动时带一条初始化提示，让它 `playbook_open` 这份文件；它连上后状态栏变为在线。连接失败和移动失败分开提示：连接失败时什么都不移动；只有移动失败时，协调者仍然在线。

需要协调者的请求（启动、有 Launch 时的打断、修改要求、在设计上选选项）在协调者离线时会被拒绝并提示。

### 人怎么编辑

所有编辑都是就地的：双击文字后修改。按 `Enter`、`Esc`、点字段旁的“退出编辑”按钮，或做任何其他操作即提交；多行文字中 `Shift+Enter` 换行。只有字段仍是开始编辑时的内容才会写入；期间协调者或文件改过它时，这次编辑被拒绝并提示，在最新内容上重新编辑即可。

| 部分 | 人可以做什么 |
|---|---|
| 执行正文、需求 | 双击段落、标题、列表项、`//` 注释、`kv` 的键或值、面板标题或 callout 文字，只改这一处。不按部分编辑的组件（代码、表格、非链式 `flow`、`er` 等）整体编辑它的围栏源码。字段为空时显示“// 双击写正文”或“// 双击写需求” |
| 正文中的编号列表 | 点一项的抓手把它拿起，再点要放到的那一行；列表自动重新编号。再点同一个抓手放回原处。Tern 没有拖放，所以是“拿起-放下” |
| 正文中的链式 `flow` | 只有一条路径的流程（`A -> B -> C`，没有分组和变更标记）画成一列节点。点节点显示“+ 下方节点”和“删除”；双击改名。流程至少保留两个节点；其他流程仍是图 |
| 槽位 | `{{名称}}` 显示当前值；点击可从选项中选，或填自定义值。在执行正文或需求里写回槽位的 `=` 行；在设计里作为修改要求发出 |
| 图片 | 在面板里按 `Ctrl+V`（或“⋯ → 粘贴剪贴板图片”）读取系统剪贴板里的图片数据；复制图片文件（Finder、聊天软件）后按 `Cmd+V`，Tern 粘贴的是文件路径，面板读取这些文件；面板无权打开的文件（在其他应用的容器里）改从剪贴板的图片数据读取。图片原样保存为 Playbook 旁的 `<文件名>.assets/<sha256>.<扩展名>`，并在单独一行写入 `![图片](<文件名>.assets/…)`：正在编辑多行文字时插在光标处，否则加到展开卡片的正文末尾（设计卡片加到需求末尾）。说明文字像其他文字一样修改。支持 PNG、JPEG、GIF、WebP、AVIF、SVG，上限 5 MiB；没有图片时不写入并提示 |
| 设计 | 对人只读。双击设计下方的 “//” 行，写下哪里要改、改成什么，`Enter` 作为修改要求发出；主会话修订 `design`，不会改 `requirement` |

编辑协调者正持有的块会把它收回：释放协调者的锁，并向协调者发 `interrupted`。

提交的修改要求进入只追加的记录。它记录**人的修改要求**，不是设计快照、设计 diff 或 AI 回复；普通读块不会包含它。

```json
{"op":"revisions","block":"b2","after":0}
```

以上是 `playbook_read` 的参数；查询 Run 的日志还要加 `run`。`after` 是记录序号，返回序号更大的记录。新建 Run 不继承模板的修改历史。

## 执行：Playbook、Run、Launch

| 对象 | 开始与结束 | 不会自动发生的事 |
|---|---|---|
| Playbook（模板） | YAML 文件本身。有自己的执行记录和 Launch；面板上的启动直接执行它 | 启动除了 subagent 自己标记的块之外什么也不改 |
| Run | `playbook_run start` 把 Playbook 复制成单独的文件，所有跟踪的块设为 `status: todo` 且没有报告。结束后不能再通过工具编辑它的块 | 开始 Run 不会启动 agent；结束 Run 不要求所有块完成；修改 Playbook 不会更新已有 Run |
| Launch | 编译 Playbook 或某个 Run 的执行块，冻结 prompt/编排代码并建立记录；显式关闭、由收尾的 `playbook.result` 关闭，或随所属 Run 结束而关闭 | `launch`/`bind` 不会启动 worker；用 `playbook_timeline` 写结果不会关闭 Launch；关闭记录不会取消 worker |

Run 用来通过协调者工具以全新状态重复执行同一份 Playbook；把返回的 Run ID（例如 `r1`）作为 `run` 传入。不带 `run` 的操作作用于 Playbook 文件本身。

每个 prompt Launch 的末尾都有文档服务追加在编译结果之后的执行记录要求：告诉 subagent 它执行的是哪个文件的哪些块，开始前把它们的 `status:` 改成 `running`，结束时改成 `status: done` 并写 `report: |`，每行一件实际做了的事，最后一行写验证；没能完成时改回 `todo` 并写明停在哪里。它只改这些字段。编排 Launch 没有这段文字：状态由编排代码或协调者设置。

subagent 收到的是冻结文本，不是 UI、实时设计页或隐式 Playbook 上下文。

### 打断执行

“打断执行”发送 `stop_requested`，带上这个块未关闭的 Launch 及其绑定的 agent。协调者在 JS eval 中执行 `await playbook.stop("l3")`：它取消本会话用 `playbook.agent`/`playbook.spawn` 为该 Launch 启动的所有 subagent，并把该 Launch 中仍是 `running` 的块改回 `todo`；正在等待的 `playbook.result` 随后记录失败并关闭 Launch。用别的方式启动的 worker 由协调者用自己的方式停止，再调用 `playbook_edit {op:"status", block, value:"todo"}`。

### 执行中的变更

文档服务会重新编译受影响的活跃 Launch，与基线比较；编译文本改变或编译失败时，经过约 2 秒合并通知协调者。人的内容修改、磁盘内容修改，以及协调者修订设计，都可能触发通知；标题、`status`、`report`、协调者自己修改执行正文不会触发同样的内容变更通知。活跃指未关闭且属于当前连接的协调者会话；新会话接管文档不会接管旧会话的 Launch。

通知不会改变正在运行的 worker 的 prompt。协调者决定是否告诉 worker、重新安排工作，或调用 `playbook_launch rebase` 把当前编译结果接受为新基线。`rebase` 追加当前编译结果作为新基线，Launch 记录中保留最初冻结的快照；之后的 `playbook.spawn` 以及编排块的 `playbook.exec` 都使用最新基线。已关闭的 Launch 不能再绑定或 rebase。

### 记录与文件

以 `playbook.yaml` 为例：

| 文件 | 内容 |
|---|---|
| `playbook.yaml` | Playbook：块、状态与报告 |
| `playbook.yaml.log.jsonl` | Playbook 自己的时间线与 Launch 记录 |
| `playbook.yaml.revisions.jsonl` | Playbook 的修改要求历史 |
| `playbook.yaml.pb.jsonl` | 服务 ID 分配记录 |
| `playbook.runs/r1.yaml` | Run 的块与运行元数据 |
| `playbook.runs/r1.jsonl` | Run 的时间线与 Launch 记录 |
| `playbook.runs/r1.revisions.jsonl` | Run 的修改要求历史 |

`.yml` 文件的 Run 目录保留后缀，例如 `example.yml.runs/`。结束 Run 会关闭其 Launch 记录、释放锁并保存结束时间；不会回写 Playbook，也不能代替停止仍在运行的 agent。仍含旧 `done_changed` 记录的日志会被拒绝。

时间线接受 `update`、`result`、`failure`、`retrospective`。复盘只能在 Run 结束后写；`update_every` 和 `next` 只用于 Run，都是正整数秒，到期只提示，不会自动生成更新。结果只有关联了 `block` 时，才能通过该块的 `.result` 引用读取。

服务约每秒检查一次磁盘文件，并在写回前再读一次，所以 subagent 写入的状态和报告会与面板或协调者的修改合并，而不会被覆盖；已提交的编辑约一秒后写回 YAML。直接修改 YAML 的内容字段也会被载入，包括设计稿；面板中的编辑分工不是文件系统权限。YAML 无效时显示解析错误并保留最后一次有效内容；文件恢复有效后继续写回。已结束 Run 的块只在工具路径上受保护；磁盘文件本身不是只读的。

## 引用与编译

执行正文使用 `((target))` 或 `((target | selector, selector))`。多个选择结果按书写顺序用空行连接。引用必须在一行内；行内代码和代码围栏中的引用不会展开。编译时解析槽位：已声明槽位的每个 `{{名称}}` 换成当前值，`slot` 围栏本身被去掉。

| 目标 | 示例 | 编译结果 |
|---|---|---|
| 设计块 | `((b2))` | 原始需求和设计稿，分别包在 `<requirement>`、`<design>` 中；需求为空时不输出 `<requirement>` |
| 设计字段/面板 | `((b2 \| requirement, panel(B)))` | 原始需求和完整的显式 `## B …` 面板，包含面板标题；需求为空时不输出内容 |
| 执行块 | `((b1))` | 正文，并递归展开；`lines(1..3)`、`section("标题")` 先从源文选取再展开 |
| 块结果 | `((b3.result))` | 同一 Playbook 或同一 Run 中关联该块的最新 `result` 记录；也可用 `lines`、`section`，不递归展开 |
| 本地文本文件 | `((file:notes.md \| section("背景")))` | 相对 Playbook 所在目录取文本；也可用 `lines`，不递归展开 |
| GitHub issue/PR | `((https://github.com/owner/repo/issues/1 \| title, body))` | issue/PR 的标题、正文或讨论评论；需要已认证的 `gh` |

规则和限制：

- 设计块支持 `requirement`、`design`、`panel(A)`；面板必须在标题中写单个大写字母 ID，例如 `## B What · 结论`。自动显示的编号不能作为引用 ID。需求和设计稿中的 `((…))` 原样保留，不会取回或展开。
- `lines` 是 1 开始的闭区间，写作 `lines(1..3)`；`section` 不含所选标题本身，包含其下级小节。两者都不能用于设计块。
- GitHub 只支持标准的 `https://github.com/<owner>/<repo>/issues/<n>` 或 `/pull/<n>`。`comments`、`comments(1..2)`、`comments(-1)` 按时间顺序选择讨论评论；PR 不包含 diff、文件、review 或行内 review 评论。不支持任意网页 URL。
- 外部文本包在 `<external source="…" fetched="…">` 中，显示取回时间。取回的是副本，不实时同步；需要最新内容时用 `playbook_compile {op:"refetch"}`。
- `file:` 允许 `../`，**没有**设计图片/`src=` 那样的目录沙箱或 secret 扫描；只引用愿意交给 subagent 的文件。
- 缺少块、面板、结果或小节，行号越界，取回失败，或引用成环，都会编译失败。块引用链最多 8 层，含根块。

`playbook_compile` 只显示编译结果，不启动工作。

## 正文、设计稿与组件

执行正文和设计稿使用同一套组件解析器绘制。组件格式参考 [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html)，**解析与渲染由本仓库实现，不调用它的 CLI，也不是嵌入浏览器页面**。段落、标题、列表和 `//` 注释行画成原生文字，公式交给 Tern 的原生 Markdown 节点，图类组件生成静态 SVG，其余使用原生 TSP 节点。

### 稿头与面板

- 可选稿头必须在第一行，以 `---` 开始/结束；只支持逐行 `key: value`，不是完整 YAML。
- 面板按书写顺序单列绘制。显示 `title`、`subtitle`；未设置稿头 `title` 时，正文第一条非空行若为 `# 标题`，会提取为稿头标题并从正文移除；先写说明再写标题不会触发提取。`template`（`sheet`/`doc`）和 `cols`（1–6）为了格式兼容仍会校验，但不改变布局。
- `## A 标题 {bare meta="备注"}` 开始一个面板。`bare` 去掉面板标题行（Where/What/How 面板不能用），`meta` 显示附加文字。`span`、`rows` 会校验但不改变布局。
- `lang` 被忽略；`theme`、`mode`、`style` 被忽略并提示；其他稿头键作为文字元数据显示。
- 面板 ID 是单个大写字母，不能重复。部分组件的原生文字标签支持行内代码、粗体、斜体和删除线；flow、ER 标签显示为纯文字，sequence 标签会去掉这些标记后显示纯文字。不要把组件标签当成完整 Markdown 渲染器。
- 以 `//` 开头的行是注释行：以淡色注释样式绘制，仍属于 agent 收到的文本。

### 当前支持的写法

| 组件 | 围栏首行与正文写法 |
|---|---|
| `slot` | `slot 名称`；一行 `= 当前值`，再写选项 `* 建议项 \| 说明`、`- 选项 \| 说明`、`~ 曾提出的选项 \| 说明`；在要用值的地方写 `{{名称}}`（文字、列表项、`kv` 值、flow 节点；flow 节点必须带括号，例如 `({{名称}})`）。围栏本身不绘制。不在选项中的自定义值会保留为 `~` 选项 |
| `flow` | `flow LR`；`Client -> [API] -> [(Cache)]: read`；方向 `TB/LR/BT/RL`，默认 `TB`；`-->` 虚线，`{Choice}` 菱形，`(Reply)` 圆角。单一路径画成可编辑的节点列，见[人怎么编辑](#人怎么编辑) |
| `er` | `er LR`；实体独占一行，缩进字段如 `id uuid PK`、`user_id uuid FK -> User`；关系如 `User 1--* Order: owns` |
| `sequence` | `sequence num`；`participants: Client, API`、`Client -> API: request`、`API --> Client: reply`；支持 `note API: text` 和 `== 阶段 ==` |
| `tree` | `tree list`；缩进表示父子，`名称 \| 说明`；不写 `list` 时自动选布局 |
| `timeline` | `timeline h` 或 `timeline v`；`09:00 \| 开始 \| 说明`，时间前加 `*` 高亮 |
| `limits` | `limits`；`延迟 \| 13 / 20 \| ms \| p95` 或 `Worker \| max 8 \| 个` |
| `annot` | `annot`；正文 `结果可能[过期]{!读取前刷新}`，`# 标题 \| 旁注`，`> 说明` |
| `kv` | `kv cols=2`；`存储: Redis`，`*不变量: 一个源头` 为整行项 |
| `callout` | `callout warn 缓存失效`；正文为 Markdown；类型 `info/ok/warn/err`；画成注释样式 |
| `diff` | `diff file=src/value.ts title="变更"`；正文贴 unified diff，不会从 `file` 读取；支持 `start`、`hl` |
| `html` | `html`；结构化标签如 `<section><h3>方案</h3><p><strong>结论</strong></p></section>`，转换为 TSP；不运行网页 |
| `svg` | `svg`；完整、静态、安全的 `<svg>`，建议带明确的 `viewBox` 或 `width`/`height` |
| 代码 | 其他语言围栏如 `ts title="片段" start=18 hl=19`；代码写在正文中，或用 `ts src=sample.ts lines=1-2 hl=2` 读取文件 |
| 表格 | Markdown 表格；数据单元格中独立的小写状态词 `ok`、`no`、`warn`（后面可空一格跟说明）显示为状态图标 |
| 图片 | 独占一行的 `![说明](image.png)` 读取本地图片文件 |

`flow`、`er`、`tree` 支持 `+ `、`- `、`~ ` 变更标记，并提供“变更/之前/之后”视图。`~` 表示声明被修改，但不保存新旧两份；改 flow 边或 ER 关系时写成一删一增。tree 父节点或 ER 实体标为新增/删除时，标记会传给子项。

### 不要当成浏览器能力

- `html` 不保留普通 `class/style/id` 等属性；链接显示为文字与地址，按钮没有动作；脚本、样式和嵌入页面被移除。不是任意 HTML/CSS 页面、交互表单或 web app 渲染器。
- `svg` 拒绝脚本、事件、`foreignObject`、外部链接和外部 CSS 资源。HTML 内嵌 SVG 会清理不安全内容并提示。具体 SVG 绘制能力仍由 Tern 决定。
- Mermaid 围栏在这里显示为普通代码，不会转成图。`flow/er/sequence` 有各自的写法，不能直接粘贴 Mermaid DSL。
- 图片只从 Playbook 目录内加载；远程 URL 或 data URL 只显示说明/地址并提示。图片和 `src=` 都按真实路径检查，`../` 或符号链接都不能越出目录。
- 嵌入的本地文件上限 5 MiB；代码 `src=` 另有 2 MiB 上限，以及二进制、凭据路径和 secret 内容检查。`lines=1-2` 与引用写法 `lines(1..2)` 不同；`hl` 使用显示行号。`src=` 先扫描整个文件中的 secret，再截取行。
- 单个围栏正文超过 1000 行不绘制；代码和 diff 超过 200 行为错误，超过 40 行为警告。错误和警告都显示行号，只有错误会让 `draft` 检查不通过。空正文或空设计不会因此报错。

## 协调者工具

下面是工具参数，不是 shell 命令。只有恰好连接了一份文档时才能省略 `doc`；省略 `run` 即作用于 Playbook 文件本身。所有输入严格校验，不接受额外字段。普通 `playbook_read` **不写 `op: "read"`**。

| 工具 | 参数 |
|---|---|
| `playbook_open` | `{doc}` |
| `playbook_read` | `{doc?, run?, block?}`；历史 `{doc?, run?, op:"revisions", block?, after?}`。块带 `status` 和 `report`，或 `task: false` |
| `playbook_edit` | `{doc?, run?, op:"title", block, value}`；`status` 用 `{block, value}`，值为 `todo`、`running` 或 `done`；`task` 用 `{block, value}`，`false` 为不跟踪、`true` 为跟踪（`todo`）；`replace` 用 `{block, find, replace}`；`write` 用 `{block, text}`；`panel` 用 `{block, panel, text}`；`insert` 用 `{after?, title, body, agent?, isolated?}`；`insert_design` 用 `{after?, title, design}`；`delete` 用 `{block}`；`move` 用 `{block, after}`，`after` 为块 ID 或 `null`（移到最前）；`agent` 用 `{block, value}`，值为字符串或 `null`（清除）；`isolated` 用 `{block, value}`，值为布尔或 `null`；以上都另传 `op` |
| `playbook_compile` | `{doc?, run?, op:"compile", blocks:[…]}`；重新取回 `{doc?, run?, op:"refetch", targets:[…]}` |
| `playbook_check` | `{doc?, run?, op:"inspect", blocks:[…]}`；报告 `{doc?, run?, op:"report", blocks:[…], version, result}` |
| `playbook_run` | `{doc?, op:"start", name, update_every?}`、`{doc?, op:"finish", run}`、`{doc?, op:"list"}` |
| `playbook_timeline` | `{doc?, op:"read", run?, after?}`；`{doc?, op:"post", run?, kind, text, block?, launch?, next?, quote?}`；`{doc?, op:"snooze", run, after}` |
| `playbook_launch` | `{doc?, op:"launch", run?, blocks:[…]}` → `{launch, kind, text, agent?, isolated?}`；`{doc?, op:"bind", launch, agent}`；`{doc?, op:"info" 或 "rebase" 或 "close", launch}` |

`playbook_edit` 的 `write/replace` 只改执行正文或设计稿，不能改需求；`replace` 的 `find` 必须恰好出现一次。`panel` 的 `text` 必须是以 `## <ID> 标题` 开始的整个替换面板，可用于执行正文和设计稿。`insert`、`insert_design` 建立的块是 `todo`；`insert_design` 的需求固定从空开始，由人填写。`task` 只用于执行块。`move` 在位置不变时不写记录。`agent`、`isolated` 只用于执行块，修改它们不改变编译文本，不触发执行中的变更通知；`launch` 只在所有根块对某一项预设了相同值时返回该项。修改已有块时，一个调用内完成加锁、修改、解锁。

### 跑一次执行块

以上面的文件为例，由主会话依次调用：

1. `playbook_open {doc: "/绝对路径/playbook.yaml"}`。
2. `playbook_compile {op: "compile", blocks: ["b3"]}`：查看展开的通则、需求、B 面板和槽位值，以及末尾的执行记录要求。
3. 在主会话的 **JS eval** 中启动 worker：

```js
var worker = await playbook.agent({
  blocks: ["b3"], agent: "task:mid", label: "检查缓存方案"
});
```

`playbook.agent` 在 worker 启动并绑定后立即返回。`worker` 是顶层变量，后续 eval 单元仍可使用；用 omp 的 `wait` 工具等待 worker，期间主会话照常处理面板上的请求和变更通知。subagent 把 b3 改成 `running`，结束时改成 `done` 并写报告。之后另发一个 eval：

```js
return await playbook.result(worker);
```

它把 worker 的最终消息作为结果记到 b3（Launch 只有一个块时自动关联）并关闭这个 Launch。不需要中途响应面板时，也可以用一次阻塞调用 `await playbook.run({ blocks: ["b3"], agent: "task:mid" })` 完成启动、等待、记录和关闭。人在面板上点“启动”会以 `launch_requested` 到达，通知里给出同样的调用。

要在不动文件的情况下从干净状态再执行一遍，调用 `playbook_run {op: "start", name: "检查缓存方案"}`，把返回的 Run ID 作为 `run` 传给上面的调用；最后 `playbook_run {op:"finish", run}`。

`task:mid` 必须是当前 omp 可用的 agent；扩展不提供或配置它。调用时没有指定 `agent` 就用块上预设的 `agent`，块也没有预设时用 omp 的默认 agent；默认被禁用时必须显式指定或在块上预设。`isolated` 同样按“显式传参 > 块上预设 > 不传”决定。

JS eval 的 `playbook` 由扩展注入，不要自行加导入行。辅助方法：

| 方法 | 行为 |
|---|---|
| `playbook.run({run?, blocks, …})` | `playbook.agent` 加 `playbook.result`：创建 Launch、启动并绑定一个 worker、等待、记结果并关闭 Launch |
| `playbook.agent({run?, blocks, …})` | 创建 Launch 并启动、绑定 worker，返回 `{launch, blocks, id, handle, …}`，不等待；未传的 `agent`、`isolated` 取块上的预设；对编排块先关闭刚建的 Launch 再报错 |
| `playbook.result(worker, {block?, close?})` | 等待并写 `result`，未给 `block` 时关联到 Launch 唯一的块；等待异常（包括被 `playbook.stop` 取消）写 `failure` 并抛出。写完后按 `close` 关闭 Launch，默认在 worker 由 `playbook.agent` 创建时关闭 |
| `playbook.spawn(launch, {…})` | 在未关闭的 prompt Launch 上增加 worker，使用最新基线（`rebase` 后即新文本）；它不拥有该 Launch，`result` 默认不关闭；Launch 已关闭时报错 |
| `playbook.stop(launch, {doc?})` | 取消本 eval 内核为该 Launch 启动的所有 worker，并把其中仍是 `running` 的块改回 `todo`；返回 `{cancelled}`；本会话没有为它启动过 worker 时报错 |
| `playbook.read({run?, block?})` | 读块；没有历史查询辅助，历史仍用 `playbook_read` 工具 |
| `playbook.post({run?, kind, text, …})` | 写记录 |
| `playbook.timeline({run?, after?})` | 读时间线 |
| `playbook.context` | 编排执行时的 `{doc, run?, launch}`（Playbook 本身没有 `run`）；普通 eval 中为空 |

辅助方法不会自动设 `status` 或结束 Run；状态由 subagent 自己写。并行时用多个 `playbook.agent` 启动 worker，各自存进顶层变量，之后分别 `result`；多个 worker 共用一个 Launch 时用 `playbook.spawn` 加入，最后收尾的那个传 `{close: true}`，或调用 `playbook_launch {op:"close"}`。含 `playbook.run/result` 且未显式给 `timeout` 的单元会设置 `timeout: 0`。

### 编排块

可把下面的块加到示例文件的 `blocks` 下；使用恰好三个反引号的 `js`/`py` 围栏，正文不能另外夹说明文字：

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

调用 `playbook_launch {op:"launch", blocks:["b4"]}`（要在 Run 中启动就加 `run`）取得返回的 Launch ID；下面假设为 `l2`，实际以返回值为准。然后发**一个完整代码只有下面这一句**的 eval：

```js
await playbook.exec("l2")
```

`exec` 是扩展拦截并替换整个单元的入口，不是普通辅助方法；不允许在这句前后追加代码。连接多份文档时可写 `await playbook.exec("l2", "/绝对路径/playbook.yaml")`。执行的是 Launch 当前基线里的编排代码（没有 `rebase` 过就是启动时冻结的代码），强制设置 `timeout: 0`；JS 辅助默认取该 Launch 的文档与 Run。原始 `tool.playbook_*` 调用不继承这些默认值：连接多份文档时需显式传 `doc`，操作 Run 时还需按工具参数要求显式传 `run`。

Python 编排会设置 **Python 变量** `PLAYBOOK_DOC`、`PLAYBOOK_RUN`（Playbook 本身为 `None`）、`PLAYBOOK_LAUNCH`，不是环境变量，也不注入 JS 的 `playbook` 辅助；直接使用 Python eval 的 `tool`、`agent` 接口，需要 omp 的 Python 后端可用。

## 检查不等于完成或认可

`playbook_check inspect` 返回确定性检查：`compile`、`render_error`、`render_pending`；执行块另检查 `empty_expansion`，执行正文和设计稿检查 `draft`，非编排的执行正文和设计稿检查 `outline`（Where/What/How）。面板不显示检查，组件错误和不符合 Where/What/How 之处在原处显示。检查不负责证明业务设计正确；除编译失败等 Launch 自身约束外，其他检查不通过不是启动门禁。

`jev` 是另行报告的模型判定：

- `playbook_check inspect` 返回 `{blocks, source, compiled, view, findings, version}`，**当前不返回问题定义**。
- 当前固定问题 `missing`：完整编译 prompt 是否提到未包含其中的日志、讨论、文件或先前结果内容？主会话可以在 eval 中用可用的 `judge` 回答。
- 报告形状为 `result: {kind:"answers", answers:{missing: P(yes)}}`，概率必须在 0–1；`P(yes) >= 0.5` 记为不通过。judge 不可用时报告 `{kind:"judge_unavailable"}`，记为未判定，不当作通过。
- 报告须带同一文档、同一 Run、同一顺序块列表的最新 `version`。过期报告会被忽略；输入变化使旧判定失效。

没有设计认可状态，没有从检查到 `done` 的自动转换。

## 开发检查

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
