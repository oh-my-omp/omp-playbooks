#!/usr/bin/env bun
// Same-load memory benchmark for the document service (oh-my-omp/omp-playbooks#26 G2).
//
//   bun test/bench/memory.ts fixture <dir> [--runs 200] [--running 20] [--entries 520] [--template-entries 5000]
//   bun test/bench/memory.ts measure --src <repo root> --fixture <dir> [--poll 60]
//   bun test/bench/memory.ts compare --base <repo root> --fixture <dir> [--poll 60]
//   bun test/bench/memory.ts diff --base <repo root> --fixture <dir>
//
// `measure` copies the fixture, starts `Core` + `serveK1` from the given checkout and reports one JSON line;
// `compare` runs `measure` for the base checkout and for this checkout in separate processes on the same
// fixture. The fixture is written through the Store API both versions share (serialize, write, appendEntry,
// appendLaunch, appendServiceRecord), so either version reads it.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import type { Block, BlockId, DocRef, EntryData, Launch, LaunchId, PlaybookDoc, RunId, RunMeta, TimelineEntry } from "../../src/domain/model";
import type { Store } from "../../src/domain/ports";

import type * as ChecksModule from "../../src/service/checks";
import type * as CoreModule from "../../src/service/core";
import type * as ReferencesModule from "../../src/service/references";
import type * as SocketModule from "../../src/service/socket";
import type * as StoreModule from "../../src/service/store";
import { createStore as createFixtureStore } from "../../src/service/store";

const HERE = resolve(import.meta.dir, "../..");

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index < 0 ? undefined : args[index + 1];
}
function numberOption(args: readonly string[], name: string, fallback: number): number {
	const value = option(args, name);
	return value === undefined ? fallback : Number(value);
}
function required(args: readonly string[], name: string): string {
	const value = option(args, name);
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

// ---------------------------------------------------------------- fixture

/** Deterministic filler text of about `size` characters. */
function filler(seed: number, size: number): string {
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
	const out: string[] = [];
	let length = 0;
	for (let i = 0; length < size; i++) {
		const word = words[(seed * 7 + i * 3) % words.length]!;
		out.push(i % 12 === 11 ? `${word}\n` : word);
		length += word.length + 1;
	}
	return out.join(" ");
}

function blocks(count: number, bodySize: number, finishedStatus: boolean): Block[] {
	return Array.from({ length: count }, (_, index) => {
		const id = `b${index + 1}` as BlockId;
		return {
			id,
			title: `Block ${index + 1}`,
			content: { kind: "task", body: filler(index, bodySize) },
			progress: { kind: "tracked", status: finishedStatus && index % 3 === 0 ? "done" : "todo", report: finishedStatus && index % 3 === 0 ? `Report ${index + 1}` : null },
		} satisfies Block;
	});
}

function entryData(index: number, run: RunId | null, launches: readonly LaunchId[]): EntryData {
	const block = `b${(index % 100) + 1}` as BlockId;
	switch (index % 8) {
		case 0: return { type: "post", kind: "update", text: filler(index, 200) };
		case 1: return { type: "post", kind: "result", text: filler(index + 1, 400), block };
		case 2: return { type: "block_edited", block, field: "body", text: filler(index + 2, 600), edit: index + 1 };
		case 3: return { type: "event_sent", event: "launch_requested", data: { ...(run === null ? {} : { run }), blocks: [block] } };
		case 4: return { type: "launch_created", launch: launches[index % launches.length]!, kind: "prompt", blocks: [block] };
		case 5: return { type: "progress_changed", block, progress: { kind: "tracked", status: "done", report: filler(index, 120) } };
		case 6: return { type: "post", kind: "failure", text: filler(index + 3, 150), block };
		default: return { type: "agent_bound", launch: launches[index % launches.length]!, agent: "task" };
	}
}

function launchRecord(id: LaunchId, run: RunId | null, start: number, closed: boolean): Launch {
	const text = filler(start, 20_000);
	return {
		id, run, session: "bench-session", blocks: ["b1" as BlockId], kind: "prompt",
		snapshot: { result: { kind: "Ok", text, sources: [] }, fetches: [], results: [] },
		agents: [], baselines: [text], notified: null, dirty: [], fetches: [],
		closed: closed ? { at: start + 1, by: "run_finished" } : null,
	};
}

async function writeFixture(directory: string, args: readonly string[]): Promise<void> {
	const runs = numberOption(args, "runs", 200);
	const running = numberOption(args, "running", 20);
	const perRun = numberOption(args, "entries", 520);
	const templateEntries = numberOption(args, "template-entries", 5000);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const store = createFixtureStore(join(directory, "book.yaml"));
	const template: DocRef = { kind: "template" };
	store.write(template, store.serialize({ title: "Bench Playbook", blocks: blocks(100, 1000, false) }, null));
	for (let b = 1; b <= 100; b++) store.appendServiceRecord({ kind: "block", id: `b${b}` as BlockId });
	let launchNumber = 0;
	const writeLog = (ref: DocRef, run: RunId | null, count: number, finished: boolean, base: number): void => {
		const launches = Array.from({ length: 3 }, () => `l${++launchNumber}` as LaunchId);
		for (const id of launches) store.appendServiceRecord({ kind: "launch", id });
		let seq = 0;
		const append = (data: EntryData): void => {
			seq++;
			const entry: TimelineEntry = { seq, at: base + seq * 1000, origin: seq % 2 === 0 ? "coordinator" : "human", data };
			store.appendEntry(ref, entry);
		};
		if (run !== null) append({ type: "run_started", name: `Run ${run}` });
		for (const [index, id] of launches.entries()) {
			// Base's #setLaunch appended the whole record on each change: a few full lines per Launch.
			const record = launchRecord(id, run, base + index, false);
			store.appendLaunch(ref, record);
			store.appendLaunch(ref, { ...record, agents: ["task"] });
			store.appendLaunch(ref, { ...record, agents: ["task"], dirty: [["b1" as BlockId, index + 1]] });
			if (finished) store.appendLaunch(ref, { ...record, agents: ["task"], closed: { at: base + 10, by: "run_finished" } });
		}
		for (let i = 0; i < count; i++) append(entryData(i, run, launches));
		if (finished && run !== null) {
			for (const id of launches) append({ type: "launch_closed", launch: id });
			append({ type: "run_finished" });
			if (Number(run.slice(1)) % 2 === 0) append({ type: "post", kind: "retrospective", text: filler(seq, 300) });
		}
	};
	writeLog(template, null, templateEntries, false, 1_700_000_000_000);
	for (let r = 1; r <= runs + running; r++) {
		const id = `r${r}` as RunId;
		const finished = r <= runs;
		const startedAt = 1_700_000_000_000 + r * 3_600_000;
		const meta: RunMeta = { id, name: `Run ${r}`, status: finished ? "finished" : "running", startedAt, finishedAt: finished ? startedAt + 60_000 : null, updateEvery: null, updateDue: null };
		const doc: PlaybookDoc = { title: "Bench Playbook", blocks: blocks(100, 1000, finished) };
		store.appendServiceRecord({ kind: "run", id });
		store.write({ kind: "run", run: id }, store.serialize(doc, meta));
		writeLog({ kind: "run", run: id }, id, perRun, finished, startedAt);
	}
	console.log(JSON.stringify({ fixture: directory, runs, running, perRun, templateEntries }));
}

// ---------------------------------------------------------------- K1 line client (independent of src/extension)

class LineClient {
	readonly #pending = new Map<string, (frame: Record<string, unknown>) => void>();
	readonly #socket;
	#buffer = "";
	#next = 0;
	private constructor(path: string, ready: () => void) {
		this.#socket = createConnection(path, ready);
		this.#socket.setEncoding("utf8");
		this.#socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			let newline: number;
			while ((newline = this.#buffer.indexOf("\n")) >= 0) {
				const frame: Record<string, unknown> = JSON.parse(this.#buffer.slice(0, newline));
				this.#buffer = this.#buffer.slice(newline + 1);
				const id = frame.id;
				if (typeof id === "string") this.#pending.get(id)?.(frame);
			}
		});
	}
	static connect(path: string): Promise<LineClient> {
		const { promise, resolve } = Promise.withResolvers<LineClient>();
		const client: LineClient = new LineClient(path, () => resolve(client));
		return promise;
	}
	request(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `q${++this.#next}`;
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, frame => { this.#pending.delete(id); resolve(frame); });
		this.#socket.write(`${JSON.stringify({ id, op, args })}\n`);
		return promise;
	}
	close(): void { this.#socket.end(); }
}

// ---------------------------------------------------------------- measure

/** Counts every Store call by method name and the characters of whole-file text reads. */
function countingStore(store: Store, counts: Map<string, number>, bytes: { yaml: number }): Store {
	const record = (name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1); };
	return new Proxy(store, {
		get(target, key, receiver) {
			const value: unknown = Reflect.get(target, key, receiver);
			if (typeof value !== "function" || typeof key !== "string") return value;
			return (...args: unknown[]) => {
				record(key);
				const result: unknown = value.apply(target, args);
				// Base: stat() returns the whole text; HEAD: readText() does.
				if (key === "stat" && typeof result === "object" && result !== null && "text" in result && typeof result.text === "string") bytes.yaml += result.text.length;
				if (key === "readText" && typeof result === "string") bytes.yaml += result.length;
				return result;
			};
		},
	});
}

function mb(value: number): number {
	return Math.round(value / 1024 / 1024 * 10) / 10;
}
function rss(): number {
	Bun.gc(true);
	return process.memoryUsage().rss;
}
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** A copy of the fixture served by `Core` + `serveK1` of the checkout at `src`, with a K1 client said hello. */
async function startService(src: string, fixture: string, counts: Map<string, number>, bytes: { yaml: number }, now?: () => number) {
	// The checkout under test is chosen at run time (base or HEAD), so these imports cannot be static.
	const { Core }: typeof CoreModule = await import(join(src, "src/service/core.ts"));
	const { createStore }: typeof StoreModule = await import(join(src, "src/service/store.ts"));
	const { references }: typeof ReferencesModule = await import(join(src, "src/service/references.ts"));
	const { checks }: typeof ChecksModule = await import(join(src, "src/service/checks.ts"));
	const { serveK1 }: typeof SocketModule = await import(join(src, "src/service/socket.ts"));
	const directory = mkdtempSync("/tmp/opb-bench-");
	cpSync(fixture, directory, { recursive: true });
	const store = countingStore(createStore(join(directory, "book.yaml")), counts, bytes);
	const core = new Core({
		store, references, checks, ...(now ? { now } : {}),
		fetcher: { fetch: async () => ({ ok: true, at: 1, value: { kind: "file", text: "bench" } }) },
		panes: { ownPane: () => null, focusPane: async () => ({ ok: true }) },
	});
	const rssStart = rss();
	const loadStarted = performance.now();
	const loadError = core.load();
	if (loadError !== null) throw new Error(loadError);
	const loadMs = performance.now() - loadStarted;
	await sleep(50);
	const rssAfterLoad = rss();
	const server = await serveK1(join(directory, "k1.sock"), core);
	const client = await LineClient.connect(join(directory, "k1.sock"));
	await client.request("hello", { session: "bench" });
	const stop = (): void => {
		client.close();
		core.stop();
		server.close();
		rmSync(directory, { recursive: true, force: true });
	};
	return { directory, store, client, rssStart, rssAfterLoad, loadMs, stop };
}

async function measure(args: readonly string[]): Promise<void> {
	const src = resolve(required(args, "src"));
	const fixture = resolve(required(args, "fixture"));
	const poll = numberOption(args, "poll", 60);
	const counts = new Map<string, number>();
	const bytes = { yaml: 0 };
	const { directory, store, client, rssStart, rssAfterLoad, loadMs, stop } = await startService(src, fixture, counts, bytes);

	// Polling window: nothing on disk changes, so every whole-file read here is spent on change detection.
	counts.clear();
	bytes.yaml = 0;
	await sleep(poll * 1000);
	const pollCounts = Object.fromEntries(counts);
	const pollYamlChars = bytes.yaml;
	const rssSteady = rss();

	// A disk edit of the template: one block appended outside the service, read back over K1.
	const templateFile = join(directory, "book.yaml");
	const parsed = store.parse(readFileSync(templateFile, "utf8"), false);
	if (!parsed.ok) throw new Error(parsed.error);
	const added: Block = { id: "b500" as BlockId, title: "Added on disk", content: { kind: "task", body: "Appended outside the service" }, progress: { kind: "tracked", status: "todo", report: null } };
	writeFileSync(templateFile, store.serialize({ title: parsed.doc.title, blocks: [...parsed.doc.blocks, added] }, null));
	const editStarted = performance.now();
	let editSeenMs: number | null = null;
	while (performance.now() - editStarted < 2000) {
		const reply = await client.request("read", { block: "b500" });
		if (reply.ok === true) { editSeenMs = Math.round(performance.now() - editStarted); break; }
		await sleep(50);
	}

	// Finishing every running Run: its state should leave memory (§2).
	const summaries = await client.request("runs", {});
	const runList = summaries.ok === true && typeof summaries.result === "object" && summaries.result !== null && "runs" in summaries.result && Array.isArray(summaries.result.runs) ? summaries.result.runs : [];
	const runningIds = runList.flatMap((run: unknown) => typeof run === "object" && run !== null && "status" in run && run.status === "running" && "id" in run && typeof run.id === "string" ? [run.id] : []);
	const rssBeforeFinish = rss();
	for (const run of runningIds) await client.request("finish_run", { run });
	await sleep(50);
	const rssAfterFinish = rss();
	const after = await client.request("runs", {});
	const afterRuns = after.ok === true && typeof after.result === "object" && after.result !== null && "runs" in after.result && Array.isArray(after.result.runs) ? after.result.runs.length : -1;

	stop();
	console.log(JSON.stringify({
		src,
		loadMs: Math.round(loadMs),
		rssStartMB: mb(rssStart),
		rssAfterLoadMB: mb(rssAfterLoad),
		pollSeconds: poll,
		rssSteadyMB: mb(rssSteady),
		pollStoreCalls: pollCounts,
		pollYamlFullReads: (pollCounts.stat ?? 0) + (pollCounts.readText ?? 0),
		pollYamlMB: mb(pollYamlChars),
		diskEditSeenMs: editSeenMs,
		finished: runningIds.length,
		rssBeforeFinishMB: mb(rssBeforeFinish),
		rssAfterFinishMB: mb(rssAfterFinish),
		runsAfterFinish: afterRuns,
	}));
	process.exit(0);
}

async function compare(args: readonly string[]): Promise<void> {
	const base = resolve(required(args, "base"));
	const fixture = resolve(required(args, "fixture"));
	const poll = String(numberOption(args, "poll", 60));
	const results: Record<string, Record<string, unknown>> = {};
	for (const [label, src] of [["base", base], ["head", HERE]] as const) {
		const child = Bun.spawnSync(["bun", join(HERE, "test/bench/memory.ts"), "measure", "--src", src, "--fixture", fixture, "--poll", poll], { stdout: "pipe", stderr: "inherit" });
		if (child.exitCode !== 0) throw new Error(`${label} measure failed with ${child.exitCode}`);
		const line = child.stdout.toString().trim().split("\n").at(-1)!;
		results[label] = JSON.parse(line);
		console.log(`${label}: ${line}`);
	}
	const keys = ["loadMs", "rssAfterLoadMB", "rssSteadyMB", "pollYamlFullReads", "pollYamlMB", "diskEditSeenMs", "rssBeforeFinishMB", "rssAfterFinishMB", "runsAfterFinish"];
	console.log(`\n| metric | base | head |\n|---|---|---|`);
	for (const key of keys) console.log(`| ${key} | ${JSON.stringify(results.base?.[key])} | ${JSON.stringify(results.head?.[key])} |`);
}

// ---------------------------------------------------------------- replay (G3: same answers, same files)

/**
 * A fixed request script over finished, running and template documents, with a fixed clock. Prints every
 * answer and a digest of every Run file and of the entry lines of every log it touched. Launch lines are
 * left out of the digest: their format is what #26 §4 changes; `launch_info` answers carry the replayed state.
 */
async function replay(args: readonly string[]): Promise<void> {
	const src = resolve(required(args, "src"));
	const fixture = resolve(required(args, "fixture"));
	const { directory, client, stop } = await startService(src, fixture, new Map(), { yaml: 0 }, () => 1_800_000_000_000);
	const script: [string, Record<string, unknown>][] = [
		["runs", {}],
		["timeline", { run: "r1" }], ["timeline", { run: "r1", after: 300 }], ["read", { run: "r1" }], ["read", { run: "r1", block: "b7" }], ["revisions", { run: "r1" }],
		["launch_info", { launch: "l4" }], ["launch_info", { launch: "l2" }],
		["lock", { run: "r1", block: "b1" }], ["insert", { run: "r1", title: "x", content: { kind: "task", body: "x" } }], ["launch", { run: "r1", blocks: ["b1"] }],
		["snooze", { run: "r1", after: 5 }], ["finish_run", { run: "r1" }], ["unlock", { run: "r1", block: "b1", request: "q0" }],
		["bind", { launch: "l4", agent: "late" }], ["rebase", { launch: "l4" }], ["close", { launch: "l4" }],
		["post", { run: "r3", kind: "retrospective", text: "Late review", launch: "l10" }], ["post", { run: "r3", kind: "retrospective", text: "Wrong", launch: "l4" }],
		["inspect", { run: "r5", blocks: ["b2"] }],
		["compile", { run: "r5", blocks: ["b4"] }],
		["finish_run", { run: "r201" }], ["timeline", { run: "r201", after: 500 }], ["read", { run: "r201", block: "b3" }], ["launch_info", { launch: "l604" }],
		["timeline", { after: 4990 }], ["read", { block: "b1" }], ["launch_info", { launch: "l1" }],
		["runs", {}],
	];
	const answers: unknown[] = [];
	for (const [op, requestArgs] of script) {
		const reply = await client.request(op, requestArgs);
		answers.push({ op, args: requestArgs, ok: reply.ok, ...(reply.ok === true ? { result: reply.result } : { error: reply.error }) });
	}
	// The inspect version, reported back: the report must land in the finished Run's log.
	const inspected = answers[19];
	const version = typeof inspected === "object" && inspected !== null && "result" in inspected && typeof inspected.result === "object" && inspected.result !== null && "version" in inspected.result ? inspected.result.version : null;
	const reported = await client.request("report", { run: "r5", blocks: ["b2"], version, result: { kind: "judge_unavailable" } });
	answers.push({ op: "report", ok: reported.ok, ...(reported.ok === true ? { result: reported.result } : { error: reported.error }) });
	const digest = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
	const files: Record<string, string> = {};
	for (const name of ["book.yaml", "book.runs/r1.yaml", "book.runs/r3.yaml", "book.runs/r5.yaml", "book.runs/r201.yaml"]) files[name] = digest(readFileSync(join(directory, name), "utf8"));
	for (const name of ["book.yaml.log.jsonl", "book.runs/r1.jsonl", "book.runs/r3.jsonl", "book.runs/r5.jsonl", "book.runs/r201.jsonl"]) {
		files[`${name} (entry lines)`] = digest(readFileSync(join(directory, name), "utf8").split("\n").filter(line => line.startsWith('{"entry"')).join("\n"));
	}
	stop();
	console.log(JSON.stringify({ answers, files }));
	process.exit(0);
}

async function diffReplay(args: readonly string[]): Promise<void> {
	const base = resolve(required(args, "base"));
	const fixture = resolve(required(args, "fixture"));
	const outputs: Record<string, { answers: unknown[]; files: Record<string, string> }> = {};
	for (const [label, src] of [["base", base], ["head", HERE]] as const) {
		const child = Bun.spawnSync(["bun", join(HERE, "test/bench/memory.ts"), "replay", "--src", src, "--fixture", fixture], { stdout: "pipe", stderr: "inherit" });
		if (child.exitCode !== 0) throw new Error(`${label} replay failed with ${child.exitCode}`);
		outputs[label] = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
	}
	const baseOut = outputs.base!;
	const headOut = outputs.head!;
	let differences = 0;
	baseOut.answers.forEach((answer, index) => {
		const a = JSON.stringify(answer);
		const b = JSON.stringify(headOut.answers[index]);
		const op = typeof answer === "object" && answer !== null && "op" in answer ? answer.op : "?";
		console.log(`${a === b ? "same" : "DIFF"} answer ${index + 1} ${String(op)} (${a.length} bytes)`);
		if (a !== b) { differences++; console.log(`  base: ${a.slice(0, 400)}\n  head: ${b.slice(0, 400)}`); }
	});
	for (const [name, hash] of Object.entries(baseOut.files)) {
		const same = headOut.files[name] === hash;
		if (!same) differences++;
		console.log(`${same ? "same" : "DIFF"} file ${name} ${hash} ${headOut.files[name]}`);
	}
	console.log(differences === 0 ? `identical: ${baseOut.answers.length} answers, ${Object.keys(baseOut.files).length} files` : `${differences} differences`);
	process.exit(differences === 0 ? 0 : 1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case "fixture": await writeFixture(resolve(rest[0] ?? "/tmp/opb-fixture"), rest.slice(1)); break;
	case "measure": await measure(rest); break;
	case "compare": await compare(rest); break;
	case "replay": await replay(rest); break;
	case "diff": await diffReplay(rest); break;
	default: throw new Error("usage: memory.ts fixture <dir> | measure --src <root> --fixture <dir> | compare --base <root> --fixture <dir> | replay --src <root> --fixture <dir> | diff --base <root> --fixture <dir>");
}
