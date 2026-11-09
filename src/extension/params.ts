// Parameter definitions for the eight playbook_* devices.
//
// The public shape is what the host renders to the model (rule §工具参数「形状」): one flat object
// per device whose `op` enum selects the branch, every field described where it is declared, no
// object unions, no dictionaries and no `.nullable()`.
//
// The internal shape is the discriminated union the tool runner and the K1 service already speak.
// `toInternal` parses a public call with the strict branch its `op` names, so a field that belongs
// to another op is rejected and the error names it.
import type * as zod from "@oh-my-pi/omptype/zod";
import { parseBlockId, parseLaunchId, parseRunId, type BlockId, type LaunchId, type RunId } from "../domain/model";
import { tr } from "../i18n";

type Zod = typeof zod;

const BLOCK_ID = /^b[1-9][0-9]*$/;
const RUN_ID = /^r[1-9][0-9]*$/;
const LAUNCH_ID = /^l[1-9][0-9]*$/;
const PANEL_ID = /^[A-Z][0-9]*$/;

export function toolParameters(z: Zod) {
  // Internal field schemas: the shapes the service protocol expects, shared by every op.
  const doc = z.string().optional();
  const block = z.string().regex(BLOCK_ID).transform(value => {
    const id = parseBlockId(value); if (id === null) throw new Error(tr("Invalid block id", "块 id 无效")); return id;
  });
  const run = z.string().regex(RUN_ID).transform(value => {
    const id = parseRunId(value); if (id === null) throw new Error(tr("Invalid Run id", "Run id 无效")); return id;
  });
  const launch = z.string().regex(LAUNCH_ID).transform(value => {
    const id = parseLaunchId(value); if (id === null) throw new Error(tr("Invalid Launch id", "Launch id 无效")); return id;
  });
  const kind = z.enum(["update", "result", "failure", "retrospective"]);
  /** A task block's default agent, as K1 stores it: trimmed and not blank. */
  const agentName = z.string().trim().min(1);
  const positive = z.number().int().positive();
  const report = z.union([
    z.object({ kind: z.literal("answers"), answers: z.record(z.string(), z.number()) }).strict(),
    z.object({ kind: z.literal("judge_unavailable") }).strict(),
  ]);

  // Public field builders: validated but not transformed, each carrying the description that
  // survives into the rendered `### Schema`. `doc` and `run` are shared, so their description is
  // written once here; op-conditional fields go optional at the end of their chain so the marker
  // survives `.describe()`.
  const docField = z.string().describe("Playbook file path. Omit while exactly one Playbook is open in this session; that one is used.").optional();
  const runField = z.string().regex(RUN_ID).describe("Run id `r<n>` (for example `r2`). Omit to work in the Playbook itself.").optional();
  const blockField = z.string().regex(BLOCK_ID);
  const launchField = z.string().regex(LAUNCH_ID).describe("Launch id `l<n>` (for example `l2`).").optional();
  const blocksField = z.array(z.string().regex(BLOCK_ID));

  const site = z.object({ block, reference: z.string() });
  const compileError = z.union([
    z.object({ kind: z.literal("UnknownBlock"), block, at: site }),
    z.object({ kind: z.literal("UnknownTarget"), at: site }),
    z.object({ kind: z.literal("BadExpression"), reason: z.string(), at: site }),
    z.object({ kind: z.literal("Cycle"), path: z.array(block), at: site }),
    z.object({ kind: z.literal("TooDeep"), at: site }),
    z.object({ kind: z.literal("NoResult"), block, at: site }),
    z.object({ kind: z.literal("FetchFailed"), target: z.string(), error: z.string(), at: site }),
    z.object({ kind: z.literal("UnknownSlot"), block, slot: z.string(), at: site }),
  ]);
  const sourceFields = { target: z.string(), expression: z.string().nullable() };
  const source = z.union([
    z.object({ kind: z.literal("block"), ...sourceFields }),
    z.object({ kind: z.literal("result"), ...sourceFields, seq: z.number(), origin: z.enum(["human", "coordinator", "disk", "service"]), launch: launch.nullable() }),
    z.object({ kind: z.literal("external"), ...sourceFields, fetchedAt: z.number() }),
  ]);
  const events = z.union([
    z.object({ event: z.literal("block_changed"), data: z.object({ id: z.string(), launch: z.object({ id: launch, kind: z.enum(["prompt", "orchestration"]), run: run.optional() }), agents: z.array(z.string()), changed: z.array(block), diff: z.string(), current: z.union([
      z.object({ kind: z.literal("Ok"), text: z.string(), sources: z.array(source) }),
      z.object({ kind: z.literal("Err"), error: compileError }),
    ]) }) }),
    z.object({ event: z.literal("launch_requested"), data: z.object({ run: run.optional(), blocks: z.array(block) }) }),
    z.object({ event: z.literal("stop_requested"), data: z.object({ run: run.optional(), block, launches: z.array(z.object({ id: launch, agents: z.array(z.string()) })) }) }),
    z.object({ event: z.literal("status_changed"), data: z.object({ run: run.optional(), block, status: z.enum(["todo", "running", "done"]) }) }),
    z.object({ event: z.literal("update_due"), data: z.object({ run, due: z.number(), last_update: z.number().nullable() }) }),
    z.object({ event: z.literal("interrupted"), data: z.object({ run: run.optional(), block, request: z.string() }) }),
    z.object({ event: z.literal("revision_requested"), data: z.object({ run: run.optional(), block, revision: positive }) }),
    z.object({ event: z.literal("agents_requested"), data: z.object({}).strict() }),
  ]);
  const error = z.object({ code: z.enum(["Busy", "NotHello", "Locked", "NotLocked", "UnknownBlock", "UnknownRun", "RunFinished", "BadValue", "NotFound", "Ambiguous", "BadLaunch", "CompileError", "UnknownTarget", "BadReport", "UnknownLaunch", "NotOwner", "UnknownEvent", "RevealFailed"]), message: z.string(), detail: z.unknown().optional() });
  const frames = z.union([events, z.object({ id: z.string(), ok: z.literal(true), result: z.unknown().optional() }).strict(), z.object({ id: z.string(), ok: z.literal(false), error }).strict()]);
  const summary = z.object({ id: run, name: z.string(), status: z.enum(["running", "finished"]), started_at: z.number(), finished_at: z.number().nullable(), done: z.number(), total: z.number(), update_due: z.number().nullable(), update_overdue: z.boolean(), retrospective: z.boolean() });
  const runsResult = z.object({ runs: z.array(summary) });
  const helloResult = z.object({ blocks: z.array(block), runs: z.array(summary), pane: z.string().optional() });
  const progressFields = { status: z.enum(["todo", "running", "done"]).optional(), report: z.string().optional(), task: z.literal(false).optional() };
  const wireBlock = z.union([
    z.object({ id: block, kind: z.literal("task"), title: z.string(), body: z.string(), agent: z.string().optional(), isolated: z.boolean().optional(), ...progressFields }),
    z.object({ id: block, kind: z.literal("design"), title: z.string(), requirement: z.string(), design: z.string(), ...progressFields }),
  ]);
  const readResult = z.object({ title: z.string(), blocks: z.array(wireBlock) });
  const revisionsResult = z.object({ revisions: z.array(z.object({ seq: positive, at: z.number(), block, prompt: z.string() })) });
  const postResult = z.object({ seq: positive });
  const launchRecord = z.object({ id: launch, run: run.nullable(), session: z.string(), kind: z.enum(["prompt", "orchestration"]), snapshot: z.object({ result: z.object({ text: z.string() }) }), baselines: z.array(z.string()).optional() });
  const evalInput = z.object({ language: z.enum(["js", "py"]), code: z.string(), title: z.string().optional(), timeout: z.number().optional(), reset: z.boolean().optional() });

  // Internal branches: the existing tool-internal discriminated unions, unchanged. `toInternal`
  // selects one branch by `op` so a foreign or missing field is reported against that branch.
  const openInternal = z.object({ doc: z.string() }).strict();

  const readBranches = {
    read: z.object({ doc, run: run.optional(), block: block.optional() }).strict(),
    revisions: z.object({ doc, run: run.optional(), op: z.literal("revisions"), block: block.optional(), after: z.number().int().nonnegative().optional() }).strict(),
  };
  const readInternal = z.union([readBranches.read, readBranches.revisions]);

  const editBranches = {
    title: z.object({ doc, run: run.optional(), op: z.literal("title"), block, value: z.string() }).strict(),
    status: z.object({ doc, run: run.optional(), op: z.literal("status"), block, value: z.enum(["todo", "running", "done"]) }).strict(),
    task: z.object({ doc, run: run.optional(), op: z.literal("task"), block, value: z.boolean() }).strict(),
    replace: z.object({ doc, run: run.optional(), op: z.literal("replace"), block, find: z.string(), replace: z.string() }).strict(),
    write: z.object({ doc, run: run.optional(), op: z.literal("write"), block, text: z.string() }).strict(),
    panel: z.object({ doc, run: run.optional(), op: z.literal("panel"), block, panel: z.string().regex(PANEL_ID), text: z.string() }).strict(),
    insert: z.object({ doc, run: run.optional(), op: z.literal("insert"), after: block.optional(), title: z.string(), body: z.string(), agent: agentName.optional(), isolated: z.boolean().optional() }).strict(),
    insert_design: z.object({ doc, run: run.optional(), op: z.literal("insert_design"), after: block.optional(), title: z.string(), design: z.string() }).strict(),
    delete: z.object({ doc, run: run.optional(), op: z.literal("delete"), block }).strict(),
    move: z.object({ doc, run: run.optional(), op: z.literal("move"), block, after: block.nullable() }).strict(),
    agent: z.object({ doc, run: run.optional(), op: z.literal("agent"), block, value: agentName.nullable() }).strict(),
    isolated: z.object({ doc, run: run.optional(), op: z.literal("isolated"), block, value: z.boolean().nullable() }).strict(),
  };
  const editInternal = z.union(Object.values(editBranches) as [typeof editBranches.title, typeof editBranches.status, typeof editBranches.task, typeof editBranches.replace, typeof editBranches.write, typeof editBranches.panel, typeof editBranches.insert, typeof editBranches.insert_design, typeof editBranches.delete, typeof editBranches.move, typeof editBranches.agent, typeof editBranches.isolated]);

  const compileBranches = {
    compile: z.object({ doc, run: run.optional(), op: z.literal("compile"), blocks: z.array(block) }).strict(),
    refetch: z.object({ doc, run: run.optional(), op: z.literal("refetch"), targets: z.array(z.string()) }).strict(),
  };
  const compileInternal = z.union([compileBranches.compile, compileBranches.refetch]);

  const checkBranches = {
    inspect: z.object({ doc, run: run.optional(), op: z.literal("inspect"), blocks: z.array(block) }).strict(),
    report: z.object({ doc, run: run.optional(), op: z.literal("report"), blocks: z.array(block), version: z.string(), result: report }).strict(),
  };
  const checkInternal = z.union([checkBranches.inspect, checkBranches.report]);

  const runBranches = {
    start: z.object({ doc, op: z.literal("start"), name: z.string(), update_every: positive.optional() }).strict(),
    finish: z.object({ doc, op: z.literal("finish"), run }).strict(),
    list: z.object({ doc, op: z.literal("list") }).strict(),
  };
  const runInternal = z.union([runBranches.start, runBranches.finish, runBranches.list]);

  const timelineBranches = {
    read: z.object({ doc, op: z.literal("read"), run: run.optional(), after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict(),
    post: z.object({ doc, op: z.literal("post"), run: run.optional(), kind, text: z.string(), block: block.optional(), launch: launch.optional(), next: positive.optional(), quote: z.string().optional() }).strict(),
    snooze: z.object({ doc, op: z.literal("snooze"), run, after: positive }).strict(),
  };
  const timelineInternal = z.union([timelineBranches.read, timelineBranches.post, timelineBranches.snooze]);

  const launchBranches = {
    launch: z.object({ doc, op: z.literal("launch"), run: run.optional(), blocks: z.array(block) }).strict(),
    bind: z.object({ doc, op: z.literal("bind"), launch, agent: z.string() }).strict(),
    info: z.object({ doc, op: z.literal("info"), launch }).strict(),
    rebase: z.object({ doc, op: z.literal("rebase"), launch }).strict(),
    close: z.object({ doc, op: z.literal("close"), launch }).strict(),
  };
  const launchInternal = z.union([launchBranches.launch, launchBranches.bind, launchBranches.info, launchBranches.rebase, launchBranches.close]);

  // Public parameter definitions: one flat object per device, every field described. The `op`
  // enum selects the branch; all other fields are optional because only some values use them.
  const openParams = z.object({
    doc: z.string().describe("Playbook file path to open, for example `/home/me/book.yaml`."),
  }).strict();

  const readParams = z.object({
    op: z.enum(["read", "revisions"]).optional().describe("`revisions` lists the person's change requests for design blocks; `read` or omit for a normal read."),
    doc: docField,
    run: runField,
    block: blockField.describe("Block id `b<n>` (for example `b3`). Omit to read all blocks.").optional(),
    after: z.number().int().nonnegative().describe("Revision sequence number (0, 1, 2, …): only requests with a larger `seq` are returned. `revisions` only; omit to list all.").optional(),
  }).strict();

  const editParams = z.object({
    op: z.enum(["title", "status", "task", "replace", "write", "panel", "insert", "insert_design", "delete", "move", "agent", "isolated"]).describe("The change to make. Each value needs the fields its own note names; a field of another op is rejected."),
    doc: docField,
    run: runField,
    block: blockField.describe("Block id `b<n>` (for example `b3`): the block to change (`title`, `status`, `task`, `replace`, `write`, `panel`, `delete`, `move`, `agent`, `isolated`); not used by `insert` or `insert_design`.").optional(),
    after: z.string().regex(BLOCK_ID).describe("Block id `b<n>`: insert the new block after it (`insert`, `insert_design`; omit to append at the end) or place the moved block after it (`move` with `position: \"after\"`).").optional(),
    position: z.enum(["top", "after"]).optional().describe("Where to put the moved block: `top` for the beginning, `after` to follow `after`. `move` only."),
    title: z.string().describe("Title text: the new title (`title`), or the title of the new block (`insert`, `insert_design`).").optional(),
    body: z.string().describe("Body of the new task block, in Markdown; `insert` only.").optional(),
    design: z.string().describe("Initial design of the new design block, in draft format; `insert_design` only.").optional(),
    text: z.string().describe("New text, written whole: the block's body or design (`write`), or one panel's whole text (`panel`).").optional(),
    find: z.string().describe("Text that must occur exactly once in the block's body or design; `replace` only.").optional(),
    replace: z.string().describe("Replacement for `find`; `replace` only.").optional(),
    panel: z.string().regex(PANEL_ID).describe("Panel letter id `A`, `A1`, … as written in the panel heading; `panel` only.").optional(),
    agent: z.string().describe("Task block's default subagent name: the new default (`agent`) or the new block's default (`insert`). Omit for `insert` to use the session default; `agent` with `clear: true` is rejected.").optional(),
    isolated: z.boolean().describe("Whether that default subagent works in its own worktree; `insert` only. Use `isolation` to change an existing block.").optional(),
    isolation: z.enum(["isolated", "shared", "default"]).optional().describe("New isolated setting of an existing task block: own worktree, shared worktree, or no preset. `isolated` only."),
    status: z.enum(["todo", "running", "done"]).optional().describe("New status; `status` only. The subagent that runs a block writes its own status; set it only to correct one."),
    tracked: z.boolean().describe("`false` makes a task block untracked (no status, not launchable, not counted); `true` tracks it again from `todo`. `task` only.").optional(),
    clear: z.boolean().describe("`true` clears the task block's default agent; `agent` only, and not together with `agent`. `false` is the same as omitting it.").optional(),
  }).strict();

  const compileParams = z.object({
    op: z.enum(["compile", "refetch"]).describe("`compile` renders the prompt the blocks produce; `refetch` fetches external references again."),
    doc: docField,
    run: runField,
    blocks: blocksField.describe("Block ids `b<n>` to compile, for example `[\"b1\", \"b3\"]`; `compile` only.").optional(),
    targets: z.array(z.string()).describe("External reference targets to fetch again, exactly as compiled: `file:<path>` or an `https://` URL. `refetch` only.").optional(),
  }).strict();

  const checkParams = z.object({
    op: z.enum(["inspect", "report"]).describe("`inspect` returns findings, judge questions and a `version`; `report` records the judge's answers for that version."),
    doc: docField,
    run: runField,
    blocks: blocksField.describe("Block ids `b<n>` to check, for example `[\"b1\", \"b3\"]`; `inspect` and `report`.").optional(),
    version: z.string().describe("The `version` the matching `inspect` returned; `report` only.").optional(),
    result: z.enum(["answers", "judge_unavailable"]).optional().describe("`answers` reports judged questions in `answers`; `judge_unavailable` marks them not judged. `report` only."),
    answers: z.array(z.object({
      question: z.string().describe("Question id, as returned by `inspect`."),
      probability: z.number().describe("Probability 0–1 that the answer is yes; 0.5 or more counts as failed."),
    }).strict()).describe("One entry per judge question; required when `result` is `answers`.").optional(),
  }).strict();

  const runParams = z.object({
    op: z.enum(["start", "finish", "list"]).describe("`start` copies the Playbook into a new Run; `finish` ends a Run; `list` returns Run summaries."),
    doc: docField,
    name: z.string().describe("Name of the new Run; `start` only.").optional(),
    update_every: z.number().int().positive().describe("Seconds between update reminders in the new Run; `start` only.").optional(),
    run: z.string().regex(RUN_ID).describe("Run id `r<n>` (for example `r2`): the Run to finish. `finish` only.").optional(),
  }).strict();

  const timelineParams = z.object({
    op: z.enum(["read", "post", "snooze"]).describe("`read` lists entries; `post` appends a record; `snooze` postpones a Run's update reminder."),
    doc: docField,
    run: z.string().regex(RUN_ID).describe("Run id `r<n>` (for example `r2`) to read or post in; required for `snooze`. Omit otherwise to work in the Playbook itself.").optional(),
    after: z.number().int().nonnegative().describe("Entry sequence number: for `read`, return entries with a larger `seq` (pass `next_after` from the last page); for `snooze`, postpone the reminder by this many seconds.").optional(),
    limit: z.number().int().positive().describe("Maximum entries to return; `read` only. A truncated page returns `next_after`.").optional(),
    kind: z.enum(["update", "result", "failure", "retrospective"]).optional().describe("Record kind; `post` only."),
    text: z.string().describe("Record text; `post` only.").optional(),
    block: blockField.describe("Block id `b<n>` the record is about; `post` only.").optional(),
    launch: launchField.describe("Launch id `l<n>` the record is about; `post` only.").optional(),
    next: z.number().int().positive().describe("Seconds until the next update reminder; `post` only, for a Run's `update`.").optional(),
    quote: z.string().describe("Session message id this record quotes; `post` only.").optional(),
  }).strict();

  const launchParams = z.object({
    op: z.enum(["launch", "bind", "info", "rebase", "close"]).describe("`launch` freezes blocks into a Launch; the other values work on an existing Launch."),
    doc: docField,
    run: runField,
    blocks: blocksField.describe("Root block ids `b<n>` of the Launch, for example `[\"b1\", \"b3\"]`; `launch` only.").optional(),
    launch: launchField.describe("Launch id `l<n>` the op works on; `bind`, `info`, `rebase` and `close`.").optional(),
    agent: z.string().describe("Name of the subagent working from the Launch; `bind` only.").optional(),
  }).strict();

  /** A public call missing a field its `op` needs; names the field the model knows. */
  const needs = (tool: string, op: string, field: string): never => {
    throw new Error(tr(`${tool} op ${op} requires ${field}`, `${tool} 的 ${op} op 需要 ${field}`));
  };

  function readToInternal(flat: ReturnType<typeof readParams.parse>): ReturnType<typeof readInternal.parse> {
    const candidate: Record<string, unknown> = { ...flat };
    // The public enum offers `read`, but the internal plain-read branch carries no `op` key.
    if (flat.op !== "revisions") delete candidate.op;
    return (flat.op === "revisions" ? readBranches.revisions : readBranches.read).parse(candidate);
  }

  function editToInternal(flat: ReturnType<typeof editParams.parse>): ReturnType<typeof editInternal.parse> {
    const candidate: Record<string, unknown> = { ...flat };
    switch (flat.op) {
      case "title":
        if (flat.title === undefined) needs("playbook_edit", "title", "title");
        candidate.value = flat.title;
        delete candidate.title;
        break;
      case "status":
        if (flat.status === undefined) needs("playbook_edit", "status", "status");
        candidate.value = flat.status;
        delete candidate.status;
        break;
      case "task":
        if (flat.tracked === undefined) needs("playbook_edit", "task", "tracked");
        candidate.value = flat.tracked;
        delete candidate.tracked;
        break;
      case "move":
        if (flat.position === undefined) needs("playbook_edit", "move", "position");
        if (flat.position === "top" && flat.after !== undefined) {
          throw new Error(tr("playbook_edit op move with position top takes no after", "playbook_edit 的 move op 在 position 为 top 时不接受 after"));
        }
        if (flat.position === "after" && flat.after === undefined) needs("playbook_edit", "move", "after");
        candidate.after = flat.position === "top" ? null : flat.after;
        delete candidate.position;
        break;
      case "agent":
        if (flat.agent !== undefined && flat.clear === true) {
          throw new Error(tr("playbook_edit op agent takes either agent or clear, not both", "playbook_edit 的 agent op 只能传 agent 或 clear 之一"));
        }
        if (flat.clear !== true && flat.agent === undefined) needs("playbook_edit", "agent", "agent");
        candidate.value = flat.clear === true ? null : flat.agent;
        delete candidate.agent;
        delete candidate.clear;
        break;
      case "isolated":
        if (flat.isolation === undefined) needs("playbook_edit", "isolated", "isolation");
        candidate.value = flat.isolation === "default" ? null : flat.isolation === "isolated";
        delete candidate.isolation;
        break;
    }
    return editBranches[flat.op].parse(candidate);
  }

  function checkToInternal(flat: ReturnType<typeof checkParams.parse>): ReturnType<typeof checkInternal.parse> {
    const candidate: Record<string, unknown> = { ...flat };
    delete candidate.answers;
    if (flat.result === "answers") {
      if (flat.answers === undefined) {
        throw new Error(tr("playbook_check op report with result answers requires answers", "playbook_check 的 report 在 result 为 answers 时需要 answers"));
      }
      const answers = new Map<string, number>();
      for (const item of flat.answers) {
        if (answers.has(item.question)) {
          throw new Error(tr(`Duplicate answer for question ${item.question}`, `问题 ${item.question} 有重复回答`));
        }
        answers.set(item.question, item.probability);
      }
      candidate.result = { kind: "answers", answers: Object.fromEntries(answers) };
    } else if (flat.result === "judge_unavailable") {
      if (flat.answers !== undefined) {
        throw new Error(tr("playbook_check result judge_unavailable takes no answers", "playbook_check 的 judge_unavailable 不接受 answers"));
      }
      candidate.result = { kind: "judge_unavailable" };
    } else if (flat.answers !== undefined) {
      throw new Error(tr("playbook_check answers needs result answers", "playbook_check 的 answers 需要 result 为 answers"));
    }
    return checkBranches[flat.op].parse(candidate);
  }

  return {
    playbook_open: { parameters: openParams, toInternal: (flat: ReturnType<typeof openParams.parse>) => openInternal.parse(flat) },
    playbook_read: { parameters: readParams, toInternal: readToInternal },
    playbook_edit: { parameters: editParams, toInternal: editToInternal },
    playbook_compile: { parameters: compileParams, toInternal: (flat: ReturnType<typeof compileParams.parse>) => compileBranches[flat.op].parse(flat) },
    playbook_check: { parameters: checkParams, toInternal: checkToInternal },
    playbook_run: { parameters: runParams, toInternal: (flat: ReturnType<typeof runParams.parse>) => runBranches[flat.op].parse(flat) },
    playbook_timeline: { parameters: timelineParams, toInternal: (flat: ReturnType<typeof timelineParams.parse>) => timelineBranches[flat.op].parse(flat) },
    playbook_launch: { parameters: launchParams, toInternal: (flat: ReturnType<typeof launchParams.parse>) => launchBranches[flat.op].parse(flat) },
    // The wire shapes the tools and their events share; unchanged, and not sent to the model.
    wire: { site, compileError, source, events, error, frames, summary, runsResult, helloResult, wireBlock, readResult, revisionsResult, postResult, launchRecord, evalInput },
  };
}
