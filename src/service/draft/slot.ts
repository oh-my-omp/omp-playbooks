// Slots: a value the person picks, declared once in a ```slot <name> fence and written `{{name}}`
// where it goes (prose, list items, kv values, flow node labels) in the same text, or `{{bN.name}}`
// in any block for slot `name` of block bN. The pane draws each use as its current value; compiling
// replaces it with that value and drops the declaration.
//
// ```slot 通知目标
// = SMTP 邮箱
// * SMTP 邮箱 | 你在 GUI 填 SMTP 服务器与凭据
// - Webhook | 发到已有的 HTTP 接收端
// ~ Telegram bot | 需要 bot token 与 chat id
// ```
//
// `=` is the current value, `*` the recommended option, `-` another option and `~` an option offered
// earlier (a value someone picked or wrote before).
import { parseBlockId, type BlockContent, type BlockId } from "../../domain/model";
import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed } from "./contract";
import { fences } from "./document";

export interface SlotOption {
	readonly label: string;
	readonly note: string;
	readonly kind: "recommended" | "option" | "past";
}

export interface SlotDecl {
	readonly name: string;
	readonly value: string;
	readonly options: readonly SlotOption[];
	/** 1-based line of the fence body. */
	readonly line: number;
}

/** `{{name}}` where a slot's value goes. */
const USE = /\{\{([^{}\n]+?)\}\}/g;
/** `bN.name`: slot `name` declared in block `bN`. */
const QUALIFIED = /^(b[^.\s]*)\.(.+)$/;
/** Fences whose text draws slots, so a `{{bN.name}}` there takes a value. */
const SLOT_FENCES: Readonly<Record<string, true>> = { kv: true, flow: true };

/** Where a block declares a slot that other blocks reach as `{{bN.name}}`, and the text it is declared in. */
export interface SlotEntry {
	readonly block: BlockId;
	readonly field: "body" | "requirement" | "design";
	readonly source: string;
	readonly decl: SlotDecl;
}
export type SlotTable = ReadonlyMap<string, SlotEntry>;

/** What a text's diagnostics may know of the document: every block's slots, which blocks exist, and the text's own place. */
export interface SlotScope {
	readonly table: SlotTable;
	readonly blocks: ReadonlySet<BlockId>;
	readonly self?: { readonly block: BlockId; readonly field: SlotEntry["field"] };
}

export type SlotResolution = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly use: string; readonly block: BlockId; readonly slot: string };

export function parseSlot(input: FenceInput): Parsed<SlotDecl> {
	const diagnostics: DraftDiagnostic[] = [];
	const name = input.args.trim();
	if (!name || /[{}|]/.test(name)) return { ok: false, diagnostics: [diagnostic("slot", Math.max(1, input.line - 1), tr("Slot needs a name on the fence line: ```slot name (without { } |)", "槽位需要名称，写在围栏行：```slot 名称（不含 { } |）"))] };
	if (qualifiedName(name)) return { ok: false, diagnostics: [diagnostic("slot", Math.max(1, input.line - 1), tr(`Slot name ${name} starts like a block ID: {{bN.name}} is how another block's slot is written`, `槽位名 ${name} 以块 ID 开头：{{bN.名称}} 是引用其他块槽位的写法`))] };
	let value: string | null = null;
	const options: SlotOption[] = [];
	input.lines.forEach((raw, index) => {
		const text = raw.trim();
		if (!text || text.startsWith("//")) return;
		const line = input.line + index;
		const marker = text[0];
		const rest = text.slice(1).trim();
		if (marker === "=") {
			if (value !== null) diagnostics.push(diagnostic("slot", line, tr("The current value may be written on only one line: = value", "当前值只能写一行 = 值")));
			else value = rest;
			return;
		}
		if (marker !== "*" && marker !== "-" && marker !== "~") {
			diagnostics.push(diagnostic("slot", line, tr("Each line must start with = current value, * recommended option, - option, or ~ previously offered option", "每行以 = 当前值、* 建议项、- 选项 或 ~ 曾提出的选项 开头")));
			return;
		}
		const [label = "", note = ""] = rest.split("|").map(part => part.trim());
		if (!label) { diagnostics.push(diagnostic("slot", line, tr("An option needs a name: write - name | note", "选项需要名称：写成 - 名称 | 说明"))); return; }
		// A repeated option adds nothing: the first one stays, and the slot still works.
		if (options.some(option => option.label === label)) { diagnostics.push(diagnostic("slot", line, tr(`Option ${label} is repeated; keep the first occurrence`, `选项 ${label} 重复，只保留第一次出现`), "warning")); return; }
		options.push({ label, note, kind: marker === "*" ? "recommended" : marker === "-" ? "option" : "past" });
	});
	if (value === null) diagnostics.push(diagnostic("slot", input.line, tr("A slot needs a current value: write one line = value", "槽位需要当前值：写一行 = 值")));
	if (value === null || diagnostics.some(found => found.severity === "error")) return { ok: false, diagnostics };
	return { ok: true, value: { name, value, options, line: input.line }, diagnostics };
}

/** The slots `text` declares, by name; a name declared twice keeps its first declaration and is a diagnostic. */
export function parseSlots(text: string, scope?: SlotScope): { readonly slots: ReadonlyMap<string, SlotDecl>; readonly diagnostics: readonly DraftDiagnostic[] } {
	const slots = new Map<string, SlotDecl>();
	const diagnostics: DraftDiagnostic[] = [];
	const code: { start: number; end: number }[] = [];
	const lineOf = (index: number): number => text.slice(0, index).split("\n").length;
	for (const fence of fences(text)) {
		if (fence.name !== "slot") { code.push(fence.span); continue; }
		const parsed = parseSlot(fence.input);
		if (!parsed.ok) continue;
		if (slots.has(parsed.value.name)) { diagnostics.push(diagnostic("slot", fence.line, tr(`Slot ${parsed.value.name} is declared more than once`, `槽位 ${parsed.value.name} 重复声明`))); continue; }
		slots.set(parsed.value.name, parsed.value);
		// A design's requirement and design are two texts of one block: `{{bN.name}}` reaches the requirement's.
		const self = scope?.self;
		const owner = self ? scope.table.get(`${self.block}.${parsed.value.name}`) : undefined;
		if (self && owner && owner.field !== self.field) diagnostics.push(diagnostic("slot", fence.line, tr(`Slot ${parsed.value.name} is also declared in this block's requirement; {{${self.block}.${parsed.value.name}}} reaches that one`, `槽位 ${parsed.value.name} 在本块的需求里也有声明；{{${self.block}.${parsed.value.name}}} 指向需求里的那个`)));
	}
	for (const match of text.matchAll(/`[^`\n]+`/g)) code.push({ start: match.index, end: match.index + match[0].length });
	const qualified = new Set(qualifiedUses(text).map(use => use.index));
	for (const match of text.matchAll(USE)) {
		const name = match[1]!.trim();
		const target = qualifiedName(name);
		if (target !== null) {
			// Without the document's slots (a check of one text alone) the compiler is the one to report it.
			if (!scope || !qualified.has(match.index) || scope.table.has(name)) continue;
			const reason = scope.blocks.has(target.block) ? tr(`${target.block} declares no slot ${target.slot}`, `${target.block} 没有声明槽位 ${target.slot}`) : tr(`block ${target.block} does not exist`, `块 ${target.block} 不存在`);
			diagnostics.push(diagnostic("slot", lineOf(match.index), tr(`{{${name}}} cannot be resolved: ${reason}`, `{{${name}}} 无法解析：${reason}`), "warning"));
			continue;
		}
		// `{{…}}` in code is the code's own syntax (a Go or Docker template), not a slot left undeclared.
		if (slots.has(name) || inside(code, match.index)) continue;
		diagnostics.push(diagnostic("slot", lineOf(match.index), tr(`{{${name}}} has no corresponding slot declaration`, `{{${name}}} 没有对应的 slot 声明`), "warning"));
	}
	return { slots, diagnostics };
}

/** The `bN.name` of a slot of another block, or null for a slot of the text itself. */
export function qualifiedName(name: string): { readonly block: BlockId; readonly slot: string } | null {
	const match = QUALIFIED.exec(name);
	const block = match ? parseBlockId(match[1]!) : null;
	return block && match ? { block, slot: match[2]!.trim() } : null;
}

/** Inline code spans of `text`, and with `fenced` its fences other than those that draw slots. */
function codeSpans(text: string, fenced: boolean): { start: number; end: number }[] {
	const spans = [...text.matchAll(/`[^`\n]+`/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
	if (fenced) for (const fence of fences(text)) if (SLOT_FENCES[fence.name] !== true) spans.push(fence.span);
	return spans;
}

function inside(spans: readonly { start: number; end: number }[], index: number): boolean {
	return spans.some(span => index >= span.start && index < span.end);
}

/**
 * The `{{bN.name}}` uses of `text` that take another block's value: outside inline code and outside
 * fences that do not draw slots. Drawing, diagnostics, compiling and dependencies all read these.
 */
export function qualifiedUses(text: string): { readonly index: number; readonly block: BlockId; readonly slot: string }[] {
	const code = codeSpans(text, true);
	return [...text.matchAll(USE)].flatMap(match => {
		const target = qualifiedName(match[1]!.trim());
		return target && !inside(code, match.index) ? [{ index: match.index, ...target }] : [];
	});
}

/** The texts of a block that may declare and use slots, in the order a `{{bN.name}}` searches them. */
export function slotTexts(content: BlockContent): readonly { readonly field: SlotEntry["field"]; readonly text: string }[] {
	return content.kind === "task" ? [{ field: "body", text: content.body }] : [{ field: "requirement", text: content.requirement }, { field: "design", text: content.design }];
}

/** Every block's slots, keyed `bN.name`; a design's requirement is read before its design. */
export function slotTable(blocks: Iterable<readonly [BlockId, BlockContent]>): SlotTable {
	const table = new Map<string, SlotEntry>();
	for (const [block, content] of blocks) {
		for (const { field, text } of slotTexts(content)) {
			for (const [name, decl] of parseSlots(text).slots) {
				const key = `${block}.${name}`;
				if (!table.has(key)) table.set(key, { block, field, source: text, decl });
			}
		}
	}
	return table;
}

/** The pieces of `text` around the `{{name}}` uses of `slots`; a `{{bN.name}}` in inline code stays text. */
export function slotParts(text: string, slots: ReadonlyMap<string, SlotDecl>): ({ readonly kind: "text"; readonly text: string } | { readonly kind: "slot"; readonly name: string })[] {
	const code = codeSpans(text, false);
	const parts: ({ kind: "text"; text: string } | { kind: "slot"; name: string })[] = [];
	let offset = 0;
	for (const match of text.matchAll(USE)) {
		const name = match[1]!.trim();
		if (!slots.has(name) || (qualifiedName(name) !== null && inside(code, match.index))) continue;
		if (match.index > offset) parts.push({ kind: "text", text: text.slice(offset, match.index) });
		parts.push({ kind: "slot", name });
		offset = match.index + match[0].length;
	}
	if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset) });
	return parts;
}

/**
 * `text` as an agent reads it: slot declarations dropped, every `{{name}}` of a slot declared in it
 * and every `{{bN.name}}` of `table` replaced by its value, in one pass (a value is never resolved
 * again). A `{{bN.name}}` the table lacks is an error; one in code stays as written.
 */
export function resolveSlots(text: string, table: SlotTable): SlotResolution {
	const declared = fences(text).filter(fence => fence.name === "slot");
	const { slots } = parseSlots(text);
	const qualified = new Set(qualifiedUses(text).map(use => use.index));
	const edits: { start: number; end: number; text: string }[] = declared.map(fence => ({
		start: fence.span.start,
		// The fence goes with its line break, so no empty line is left in its place.
		end: text[fence.span.end] === "\n" ? fence.span.end + 1 : fence.span.end,
		text: "",
	}));
	for (const match of text.matchAll(USE)) {
		if (declared.some(fence => match.index >= fence.span.start && match.index < fence.span.end)) continue;
		const name = match[1]!.trim();
		const target = qualifiedName(name);
		if (target === null) {
			const local = slots.get(name);
			if (local) edits.push({ start: match.index, end: match.index + match[0].length, text: local.value });
			continue;
		}
		if (!qualified.has(match.index)) continue;
		const entry = table.get(name);
		if (!entry) return { ok: false, use: match[0], block: target.block, slot: target.slot };
		edits.push({ start: match.index, end: match.index + match[0].length, text: entry.decl.value });
	}
	let resolved = "";
	let offset = 0;
	for (const edit of edits.sort((a, b) => a.start - b.start)) {
		resolved += text.slice(offset, edit.start) + edit.text;
		offset = edit.end;
	}
	return { ok: true, text: resolved + text.slice(offset) };
}

/**
 * `text` with slot `name` set to `value`. A value that is none of the slot's options is kept as an
 * option offered earlier, so it can be picked again. Null when no slot `name` is declared.
 */
export function setSlotValue(text: string, name: string, value: string): string | null {
	const fence = fences(text).find(candidate => candidate.name === "slot" && candidate.input.args.trim() === name);
	if (!fence || value.includes("\n")) return null;
	const parsed = parseSlot(fence.input);
	const lines = [...fence.input.lines];
	const current = lines.findIndex(line => line.trim().startsWith("="));
	if (current >= 0) lines[current] = `= ${value}`;
	else lines.unshift(`= ${value}`);
	const known = parsed.ok && parsed.value.options.some(option => option.label === value);
	if (!known && !value.includes("|") && value.trim()) lines.push(tr(`~ ${value} | Custom`, `~ ${value} | 自定义`));
	const body = lines.join("\n");
	const { start, end } = fence.input.body;
	// An empty body has no line to replace: the new lines go in with their own line break.
	return start === end ? `${text.slice(0, start)}${body}\n${text.slice(end)}` : text.slice(0, start) + body + text.slice(end);
}
