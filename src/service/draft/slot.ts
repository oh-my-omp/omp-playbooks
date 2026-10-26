// Slots: a value the person picks, declared once in a ```slot <name> fence and written `{{name}}`
// where it goes (prose, list items, kv values, flow node labels). The pane draws each `{{name}}` as
// its current value; compiling replaces it with that value and drops the declaration.
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

export function parseSlot(input: FenceInput): Parsed<SlotDecl> {
	const diagnostics: DraftDiagnostic[] = [];
	const name = input.args.trim();
	if (!name || /[{}|]/.test(name)) return { ok: false, diagnostics: [diagnostic("slot", Math.max(1, input.line - 1), "槽位需要名称，写在围栏行：```slot 名称（不含 { } |）")] };
	let value: string | null = null;
	const options: SlotOption[] = [];
	input.lines.forEach((raw, index) => {
		const text = raw.trim();
		if (!text || text.startsWith("//")) return;
		const line = input.line + index;
		const marker = text[0];
		const rest = text.slice(1).trim();
		if (marker === "=") {
			if (value !== null) diagnostics.push(diagnostic("slot", line, "当前值只能写一行 = 值"));
			else value = rest;
			return;
		}
		if (marker !== "*" && marker !== "-" && marker !== "~") {
			diagnostics.push(diagnostic("slot", line, "每行以 = 当前值、* 建议项、- 选项 或 ~ 曾提出的选项 开头"));
			return;
		}
		const [label = "", note = ""] = rest.split("|").map(part => part.trim());
		if (!label) { diagnostics.push(diagnostic("slot", line, "选项需要名称：写成 - 名称 | 说明")); return; }
		if (options.some(option => option.label === label)) { diagnostics.push(diagnostic("slot", line, `选项 ${label} 重复`)); return; }
		options.push({ label, note, kind: marker === "*" ? "recommended" : marker === "-" ? "option" : "past" });
	});
	if (value === null) diagnostics.push(diagnostic("slot", input.line, "槽位需要当前值：写一行 = 值"));
	if (value === null || diagnostics.length) return { ok: false, diagnostics };
	return { ok: true, value: { name, value, options, line: input.line }, diagnostics };
}

/** The slots `text` declares, by name; a name declared twice keeps its first declaration and is a diagnostic. */
export function parseSlots(text: string): { readonly slots: ReadonlyMap<string, SlotDecl>; readonly diagnostics: readonly DraftDiagnostic[] } {
	const slots = new Map<string, SlotDecl>();
	const diagnostics: DraftDiagnostic[] = [];
	for (const fence of fences(text)) {
		if (fence.name !== "slot") continue;
		const parsed = parseSlot(fence.input);
		if (!parsed.ok) continue;
		if (slots.has(parsed.value.name)) diagnostics.push(diagnostic("slot", fence.line, `槽位 ${parsed.value.name} 重复声明`));
		else slots.set(parsed.value.name, parsed.value);
	}
	for (const match of text.matchAll(USE)) {
		const name = match[1]!.trim();
		if (!slots.has(name)) diagnostics.push(diagnostic("slot", text.slice(0, match.index).split("\n").length, `{{${name}}} 没有对应的 slot 声明`, "warning"));
	}
	return { slots, diagnostics };
}

/** The pieces of `text` around the `{{name}}` uses of declared slots. */
export function slotParts(text: string, slots: ReadonlyMap<string, SlotDecl>): ({ readonly kind: "text"; readonly text: string } | { readonly kind: "slot"; readonly name: string })[] {
	const parts: ({ kind: "text"; text: string } | { kind: "slot"; name: string })[] = [];
	let offset = 0;
	for (const match of text.matchAll(USE)) {
		const name = match[1]!.trim();
		if (!slots.has(name)) continue;
		if (match.index > offset) parts.push({ kind: "text", text: text.slice(offset, match.index) });
		parts.push({ kind: "slot", name });
		offset = match.index + match[0].length;
	}
	if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset) });
	return parts;
}

/** `text` as an agent reads it: slot declarations dropped, every `{{name}}` of a declared slot replaced by its value. */
export function resolveSlots(text: string): string {
	const declared = fences(text).filter(fence => fence.name === "slot");
	if (declared.length === 0) return text;
	const { slots } = parseSlots(text);
	let resolved = text;
	for (const fence of [...declared].reverse()) {
		// The fence goes with its line break, so no empty line is left in its place.
		const end = resolved[fence.span.end] === "\n" ? fence.span.end + 1 : fence.span.end;
		resolved = resolved.slice(0, fence.span.start) + resolved.slice(end);
	}
	return resolved.replace(USE, (whole, name: string) => slots.get(name.trim())?.value ?? whole);
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
	if (!known && !value.includes("|") && value.trim()) lines.push(`~ ${value} | 自定义`);
	const body = lines.join("\n");
	const { start, end } = fence.input.body;
	// An empty body has no line to replace: the new lines go in with their own line break.
	return start === end ? `${text.slice(0, start)}${body}\n${text.slice(end)}` : text.slice(0, start) + body + text.slice(end);
}
