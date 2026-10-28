import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pastedImagePaths } from "../src/service/ui";
import type { TspNode } from "../src/service/tsp-types";
import type { OmpPane } from "../src/service/coordinators";
import { registerCoreCleanup, design, task, template } from "./core-fixture";
import { fakeCoordinators, fixture, settle, TestTsp } from "./ui-fixture";

/** The editable node drawn for the field's text that starts with `text`. */
function editableOf(tsp: TestTsp, prefix: string, text: string): TspNode {
	return tsp.nodes().find(node => node.id.startsWith(prefix) && node.p?.actions && JSON.stringify(node.c ?? []).includes(text))!;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_PATH = `book.yaml.assets/${new Bun.CryptoHasher("sha256").update(PNG).digest("hex")}.png`;

describe("current Playbook user interactions", () => {
	test("opens first card and folding another mounts exactly that body", async () => {
		const f = await fixture();
		expect(f.tsp.nodes().some(node => node.id === "b1.body")).toBe(true);
		expect(f.tsp.nodes().some(node => node.id === "b2.body")).toBe(false);
		f.tsp.action("b2.fold");
		expect(f.tsp.nodes().some(node => node.id === "b1.body")).toBe(false);
		expect(f.tsp.nodes().some(node => node.id === "b2.body")).toBe(true);
	});
	for (const end of ["\r", "\x1b"]) test(`inline title editing commits through ${JSON.stringify(end)}`, async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "Renamed", cursor: 7, len: 2 });
		f.tsp.keys(end);
		expect(f.core.view(template).blocks[0]?.block.title).toBe("Renamed");
	});
	test("stale inline edits cannot overwrite a concurrent title change", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.keys(" local");
		expect(f.core.edit(template, "b1", "title", "b1", "Concurrent")).toBeNull();
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("Concurrent");
		expect(f.tsp.nodes().some(node => node.k === "toast" && node.p?.tone === "error")).toBe(true);
	});
	test("document title editing persists through core", async () => {
		const f = await fixture();
		f.tsp.action("doc.title", "edit");
		f.tsp.keys(" changed\r");
		expect(f.core.view(template).title).toBe("Playbook changed");
	});
	test("native edit length guard rejects an edit against obsolete text", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "Wrong", cursor: 5, len: 100 });
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("b1");
	});
	test("status toggles update the task and dock completion count", async () => {
		const f = await fixture();
		f.tsp.action("b1.status");
		expect(f.core.view(template).blocks[0]?.block.progress).toEqual({ kind: "tracked", status: "done", report: null });
		expect(f.tsp.node("status.done").p?.text).toBe("1 / 2 已完成");
		f.tsp.action("b1.status");
		expect(f.core.view(template).blocks[0]?.block.progress).toMatchObject({ status: "todo" });
	});
	test("meta-click selects tracked tasks and grouped launch requests retain document order", async () => {
		const f = await fixture(); await f.connect();
		f.tsp.action("b2.title", "invoke", ["meta"]); f.tsp.action("b1.title", "invoke", ["meta"]);
		f.tsp.action("bar.launch");
		expect(f.events).toContainEqual({ event: "launch_requested", data: { blocks: ["b1", "b2"] } });
		expect(f.tsp.nodes().some(node => node.id === "bar.launch")).toBe(false);
	});
	test("untracked and design cards cannot be selected for grouped launch", async () => {
		const untracked = { ...task("b1"), progress: { kind: "untracked" as const } };
		const f = await fixture([untracked, design("b2")]);
		f.tsp.action("b1.title", "invoke", ["meta"]); f.tsp.action("b2.title", "invoke", ["meta"]);
		expect(f.tsp.nodes().some(node => node.id === "bar.launch")).toBe(false);
		expect(f.tsp.nodes().some(node => node.id === "b1.status")).toBe(false);
	});
	test("launch is disabled while pending and running task uses stop instead", async () => {
		const f = await fixture(); await f.connect();
		f.tsp.action("b1.foot.launch"); f.tsp.action("b1.foot.launch");
		expect(f.events.filter(event => event.event === "launch_requested")).toHaveLength(1);
		await f.success({ op: "launch", args: { blocks: ["b1"] } });
		f.core.setStatus(template, "b1", "running"); await Promise.resolve();
		f.tsp.action("b1.foot.launch");
		expect(f.events).toContainEqual(expect.objectContaining({ event: "stop_requested", data: { block: "b1", launches: [{ id: "l1", agents: [] }] } }));
	});
	test("task slots rewrite source while design slots submit a revision without editing design", async () => {
		const source = "```slot mode\n= Fast\n* Fast\n- Safe\n```\nUse {{mode}}.";
		const f = await fixture([task("b1", source), design("b2", source)]); await f.connect();
		const slot = f.tsp.nodes().find(node => node.p?.text === "Fast" && node.p?.actions)!;
		f.tsp.action(slot.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: source.replace("= Fast", "= Safe") });
		f.tsp.action("b2.fold");
		const designSlot = f.tsp.nodes().find(node => node.p?.text === "Fast" && node.p?.actions)!;
		f.tsp.action(designSlot.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[1]?.block.content).toMatchObject({ design: source });
		expect(f.store.readRevisions(template)).toContainEqual(expect.objectContaining({ block: "b2" }));
	});
	test("a {{bN.name}} shows bN's value and a pick changes it where it is declared: a body directly, a design by change request", async () => {
		const declared = "```slot mode\n= Fast\n* Fast\n- Safe\n```\n";
		const body = "Use {{b2.mode}} and {{b3.mode}}.\n\n| Mode |\n|---|\n| {{b2.mode}} |";
		const f = await fixture([task("b1", body), task("b2", declared), design("b3", declared)]); await f.connect();
		const cell = (): string => JSON.stringify(f.tsp.nodes().find(node => node.k === "table")?.p?.rows);
		expect(cell()).toContain('"Fast"');
		const slots = f.tsp.nodes().filter(node => node.p?.class?.toString().startsWith("pb-slot"));
		expect(slots.map(node => [node.p?.text, node.p?.title])).toEqual([["Fast", "b2 的槽位 mode"], ["Fast", "b3 的槽位 mode"]]);
		f.tsp.action(slots[0]!.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[1]?.block.content).toMatchObject({ body: declared.replace("= Fast", "= Safe") });
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body });
		expect(cell()).toContain('"Safe"');
		f.tsp.action(slots[1]!.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[2]?.block.content).toMatchObject({ design: declared });
		expect(f.store.readRevisions(template)).toContainEqual(expect.objectContaining({ block: "b3" }));
	});
	test("ordered list pick-and-place rewrites and renumbers the actual body", async () => {
		const f = await fixture([task("b1", "3. One\n4. Two\n5. Three")]);
		const grip = f.tsp.nodes().find(node => node.k === "icon" && node.p?.name === "grip")!;
		f.tsp.action(grip.id);
		const target = f.tsp.nodes().filter(node => node.p?.tag === "li" && node.p?.actions).at(-1)!;
		f.tsp.action(target.id);
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "3. Two\n4. Three\n5. One" });
	});
	test("completion reports start folded and reveal the subagent's text on request", async () => {
		const block = { ...task("b1"), progress: { kind: "tracked" as const, status: "done" as const, report: "Work completed" } };
		const f = await fixture([block]);
		expect(f.tsp.nodes().some(node => node.p?.text === "Work completed")).toBe(false);
		f.tsp.action("b1.foot.report.toggle");
		expect(f.tsp.nodes().some(node => node.p?.text === "Work completed")).toBe(true);
	});
	test("more menu deletes the open block through core", async () => {
		const f = await fixture(); f.tsp.action("b1.more"); f.tsp.action("menu.delete");
		expect(f.core.view(template).blocks.map(item => item.block.id)).toEqual(["b2"]);
	});
	test("Unicode deletion removes a code point and undo restores the last edit", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "A😀B", cursor: 4, len: 2 });
		f.tsp.keys("\x7f\x7f");
		f.tsp.event({ ev: "undo", id: "b1.title.edit" });
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("A😀");
	});
	test("fragmented paste and coalesced text plus Escape commit one single-line edit", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.keys("\x1b[200~");
		f.tsp.keys(" pasted\ntext");
		f.tsp.keys("\x1b[201~!\x1b");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("b1 pasted text!");
	});
	test("Shift+Enter inserts a requirement newline and Ctrl+Enter commits without editing design", async () => {
		const f = await fixture([design("b1")]);
		f.tsp.action(editableOf(f.tsp, "b1.requirement", "Requirement").id, "edit");
		f.tsp.keys("\x1b[13;2u");
		f.tsp.keys("Extra requirement");
		f.tsp.keys("\x1b[13;5u");
		expect(f.core.view(template).blocks[0]?.block.content).toEqual({ kind: "design", requirement: "Requirement\nExtra requirement", design: "## A Plan\nDesign" });
	});
	test("Ctrl+V keeps the clipboard image beside the Playbook and appends its line to the open card", async () => {
		const f = await fixture([task("b1", "Before"), design("b2")], undefined, async () => ({ data: PNG, mimeType: "image/png" }));
		f.tsp.keys("\x1b[118;5u");
		await settle();
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: `Before\n\n![图片](${PNG_PATH})\n` });
		expect(new Uint8Array(readFileSync(join(f.directory, PNG_PATH)))).toEqual(PNG);
		expect(f.tsp.nodes().some(node => node.k === "image")).toBe(true);
		// A design card takes it in the person's requirement; the same image is the same file.
		f.tsp.action("b2.fold");
		f.tsp.keys("\x16");
		await settle();
		expect(f.core.view(template).blocks[1]?.block.content).toMatchObject({ requirement: `Requirement\n\n![图片](${PNG_PATH})\n`, design: "## A Plan\nDesign" });
	});
	test("an image pasted while editing goes in at the caret on a line of its own", async () => {
		const f = await fixture([task("b1", "Left right")], undefined, async () => ({ data: PNG, mimeType: "image/png" }));
		f.tsp.action(editableOf(f.tsp, "b1.body", "Left right").id, "edit");
		f.tsp.keys("\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D");
		f.tsp.keys("\x1b[200~\x1b[201~");
		await settle();
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: `Left\n![图片](${PNG_PATH})\n right` });
	});
	test("without an image, or with one the card cannot draw, nothing is written and the person is told", async () => {
		const empty = await fixture();
		empty.tsp.keys("\x16");
		await settle();
		expect(empty.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "Task body" });
		expect(empty.tsp.nodes().some(node => node.k === "toast" && node.p?.text === "剪贴板里没有图片")).toBe(true);
		const tiff = await fixture(undefined, undefined, async () => ({ data: PNG, mimeType: "image/tiff" }));
		tiff.tsp.keys("\x16");
		await settle();
		expect(tiff.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "Task body" });
		expect(tiff.tsp.nodes().some(node => node.k === "toast" && node.p?.tone === "error")).toBe(true);
	});
	test("Cmd+V of copied image files, pasted as their escaped paths, puts the files in; an unreadable one falls back to the clipboard data", async () => {
		const f = await fixture([task("b1", "Before")], undefined, async () => ({ data: PNG, mimeType: "image/png" }));
		const folder = join(f.directory, "copied dir");
		mkdirSync(folder);
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		writeFileSync(join(folder, "a b.gif"), gif);
		f.tsp.keys(`${folder.replaceAll(" ", "\\ ")}/a\\ b.gif`);
		const gifPath = `book.yaml.assets/${new Bun.CryptoHasher("sha256").update(gif).digest("hex")}.gif`;
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: `Before\n\n![图片](${gifPath})\n` });
		expect(new Uint8Array(readFileSync(join(f.directory, gifPath)))).toEqual(gif);
		f.tsp.keys(`\x1b[200~${join(folder, "gone.png").replaceAll(" ", "\\ ")}\x1b[201~`);
		await settle();
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: `Before\n\n![图片](${gifPath})\n\n![图片](${PNG_PATH})\n` });
	});
	test("pasted text that is not only image paths stays text", () => {
		expect(pastedImagePaths("/a/b\\ c.png '/d/e f.JPG' file:///g/h%20i.webp")).toEqual(["/a/b c.png", "/d/e f.JPG", "/g/h i.webp"]);
		for (const text of ["/a/b.txt", "relative/b.png", "/a/b.png and more", "see /a/b.png", "'/a/b.png", ""]) expect(pastedImagePaths(text)).toBeNull();
	});
	test("the 退出编辑 button commits the edit like Enter", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.keys(" renamed");
		f.tsp.action("b1.title.exit");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("b1 renamed");
		expect(f.tsp.nodes().some(node => node.id === "b1.title.edit")).toBe(false);
	});
	test("offline, the status lists omp panes; only panes with omp-playbooks can be chosen, and 新建会话 is always offered", async () => {
		const panes: OmpPane[] = [
			{ pane: "11", title: "omp", cwd: "/work", place: { session: "Default", tab: 2 }, ompSession: "/s/a.jsonl", loaded: true },
			{ pane: "12", title: "old omp", cwd: "/old", place: { session: "Default", tab: 3 }, ompSession: "/s/b.jsonl", loaded: false },
		];
		const f = await fixture(undefined, fakeCoordinators(panes));
		f.tsp.action("status.coordinator");
		await settle();
		expect(f.calls).toEqual(["list"]);
		expect(f.tsp.node("coord.o0").p?.actions).toEqual({ click: "invoke" });
		expect(f.tsp.node("coord.o1").p?.actions).toBeUndefined();
		f.tsp.action("coord.o0");
		await settle();
		expect(f.calls).toEqual(["list", "choose 11"]);
		f.tsp.action("status.coordinator");
		await settle();
		f.tsp.action("coord.new");
		await settle();
		expect(f.calls).toEqual(["list", "choose 11", "list", "new"]);
	});
	test("a block reference opens its card and scrolls to it once; code spans and missing blocks stay text", async () => {
		const f = await fixture([task("b1", "See ((b2)), `((b2))` and ((b9))."), { ...task("b2", "Target"), title: "Rollout" }]);
		const links = f.tsp.nodes().filter(node => node.p?.class === "pb-ref");
		expect(links.map(node => node.p?.text)).toEqual(["Rollout"]);
		expect(f.tsp.nodes().find(node => node.p?.text === "((b9))")?.p?.actions).toBeUndefined();
		f.tsp.action(links[0]!.id);
		expect(f.tsp.nodes().some(node => node.id === "b2.body")).toBe(true);
		const followed = f.tsp.frames.length;
		expect(f.tsp.frames.at(-1)!.ops).toContainEqual(["reveal", "b2.card", "start"]);
		f.tsp.action("b2.status");
		await settle();
		expect(f.tsp.frames.slice(followed).flatMap(frame => frame.ops).some(op => op[0] === "reveal")).toBe(false);
	});
	test("a link shows its alias, else the target's name, and keeps its source on hover", async () => {
		const f = await fixture([
			task("b1", 'One ((b2)), two ((b2 | as("the plan"), lines(1..1))), three ((b3.result)).'),
			{ ...task("b2"), title: "Rollout" }, { ...task("b3"), title: " " },
		]);
		const links = f.tsp.nodes().filter(node => node.p?.class === "pb-ref").map(node => ({ text: node.p?.text, title: node.p?.title }));
		expect(links).toEqual([
			{ text: "Rollout", title: "((b2))" },
			{ text: "the plan", title: '((b2 | as("the plan"), lines(1..1)))' },
			{ text: "未命名块 b3 · 结果", title: "((b3.result))" },
		]);
	});
	test("references in panel headings and prose are links, external ones opened by Tern; component values stay text", async () => {
		const f = await fixture([design("b1", "## A Plan ((b2))\nUse ((file:docs/a b.md)).\n```kv\nKey: ((b2))\n```", "Fix ((https://github.com/Owner/Repo/pull/7))"), task("b2")]);
		const links = f.tsp.nodes().filter(node => node.p?.class === "pb-ref").map(node => ({ text: node.p?.text, href: node.p?.href, actions: node.p?.actions }));
		expect(links).toEqual([
			{ text: "owner/repo#7", href: "https://github.com/owner/repo/pull/7", actions: undefined },
			{ text: "b2", href: undefined, actions: { click: "invoke" } },
			{ text: "docs/a b.md", href: `${f.directory}/docs/a%20b.md`, actions: undefined },
		]);
	});
});

registerCoreCleanup();
