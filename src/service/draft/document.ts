// Document-level parser of a design draft (answer-me-with-html draft format, `am help format`):
// frontmatter, lead, `## ` panels and the segments inside them. Component fences are only
// located here; src/service/draft/components.ts parses and draws them. Every segment keeps the
// UTF-16 range it came from, so the pane can edit the text it draws in place.
import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type SourceLine, type Span } from "./contract";

export interface DraftMeta {
	readonly template: "sheet" | "doc";
	readonly title: string | null;
	readonly subtitle: string | null;
	/** Most panels in a sheet row. */
	readonly cols: number;
	/** Other frontmatter keys, shown in the header's meta line. */
	readonly extra: readonly { readonly key: string; readonly value: string }[];
}

export type Segment =
	| { readonly kind: "markdown"; readonly text: string; readonly line: number; readonly lines: readonly SourceLine[]; readonly span: Span }
	/** A fenced block; `name` is the fence language (a component name, a code language, or empty). */
	| { readonly kind: "fence"; readonly name: string; readonly input: FenceInput; readonly line: number; readonly span: Span }
	/** A GFM table block (header, delimiter and body rows). */
	| { readonly kind: "table"; readonly input: FenceInput; readonly span: Span }
	/** An image on its own line: `![alt](path)`. */
	| { readonly kind: "image"; readonly input: FenceInput; readonly span: Span };

export interface Panel {
	/** Letter ID: written in the heading (`explicit`) or assigned in order. */
	readonly id: string;
	readonly explicit: boolean;
	readonly title: string;
	/** Where the title is written in the heading line. */
	readonly titleSpan: Span;
	readonly span: number | null;
	readonly rows: number | null;
	readonly bare: boolean;
	readonly meta: string | null;
	/** 1-based line of the `## ` heading. */
	readonly line: number;
	/** UTF-16 range of the panel in the draft text, from its heading to the next panel or the end. */
	readonly start: number;
	readonly end: number;
	readonly segments: readonly Segment[];
}

export interface DraftDocument {
	readonly meta: DraftMeta;
	readonly lead: readonly Segment[];
	readonly panels: readonly Panel[];
	/** Document-level findings (frontmatter, headings, fences); component findings come from components.ts. */
	readonly diagnostics: readonly DraftDiagnostic[];
}

interface Line extends SourceLine {
	/** 1-based line number. */
	readonly number: number;
	/** Inside a fenced block (fence delimiter lines included). */
	readonly fenced: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*?)[ \t]*$/;
const HEADING = /^## (?:([A-Z])(?=[ \t]|$|\{))?[ \t]*(.*?)[ \t]*(?:\{([^{}]*)\})?[ \t]*$/;
const IMAGE = /^[ \t]*!\[[^\]]*\]\(.+\)[ \t]*$/;
const DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const IGNORED_KEYS = new Set(["theme", "mode", "style"]);

function closes(open: string, line: string): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return match !== null && match[1]![0] === open[0] && match[1]!.length >= open.length;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let offset = 0;
	let fence: string | null = null;
	text.split("\n").forEach((raw, index) => {
		const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		let fenced = fence !== null;
		if (fence !== null) {
			if (closes(fence, value)) fence = null;
		} else {
			const open = FENCE_OPEN.exec(value);
			if (open) { fence = open[1]!; fenced = true; }
		}
		lines.push({ text: value, number: index + 1, offset, fenced });
		offset += raw.length + 1;
	});
	return lines;
}

/** The range of `lines`, from the first line's start to the last line's end (its newline excluded). */
function spanOf(lines: readonly SourceLine[]): Span {
	const last = lines.at(-1)!;
	return { start: lines[0]!.offset, end: last.offset + last.text.length };
}

/** Segments of consecutive lines (a panel body or the lead). */
function segmentsOf(lines: readonly Line[], diagnostics: DraftDiagnostic[]): Segment[] {
	const segments: Segment[] = [];
	let markdown: Line[] = [];
	const flush = (): void => {
		const text = markdown.map(line => line.text).join("\n");
		if (text.trim()) segments.push({ kind: "markdown", text, line: markdown[0]!.number, lines: markdown, span: spanOf(markdown) });
		markdown = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const open = FENCE_OPEN.exec(line.text);
		if (open) {
			flush();
			const body: Line[] = [];
			let closed = false;
			let next = index + 1;
			for (; next < lines.length; next++) {
				if (closes(open[1]!, lines[next]!.text)) { closed = true; break; }
				body.push(lines[next]!);
			}
			if (!closed) diagnostics.push(diagnostic("draft", line.number, tr(`Code fence is not closed; add a line ${open[1]} at the end of the block.`, `代码块没有结束：在块末尾加一行 ${open[1]}`)));
			const last = closed ? lines[next]! : body.at(-1) ?? line;
			const bodyStart = body[0]?.offset ?? line.offset + line.text.length + 1;
			segments.push({
				kind: "fence", name: open[2]!.toLowerCase(), line: line.number,
				input: { args: open[3]!, lines: body.map(item => item.text), line: line.number + 1, starts: body.map(item => item.offset), body: body.length ? spanOf(body) : { start: bodyStart, end: bodyStart } },
				span: { start: line.offset, end: last.offset + last.text.length },
			});
			index = next;
			continue;
		}
		if (IMAGE.test(line.text)) {
			flush();
			segments.push({ kind: "image", input: { args: "", lines: [line.text.trim()], line: line.number, starts: [line.offset], body: spanOf([line]) }, span: spanOf([line]) });
			continue;
		}
		const following = lines[index + 1];
		if (line.text.includes("|") && following && !following.fenced && DELIMITER.test(following.text) && following.text.includes("-")) {
			flush();
			const rows: Line[] = [line, following];
			let next = index + 2;
			while (next < lines.length && !lines[next]!.fenced && lines[next]!.text.trim() !== "" && lines[next]!.text.includes("|")) rows.push(lines[next++]!);
			segments.push({ kind: "table", input: { args: "", lines: rows.map(row => row.text), line: line.number, starts: rows.map(row => row.offset), body: spanOf(rows) }, span: spanOf(rows) });
			index = next - 1;
			continue;
		}
		markdown.push(line);
	}
	flush();
	return segments;
}

function attributes(text: string, line: number, diagnostics: DraftDiagnostic[]): Pick<Panel, "span" | "rows" | "bare" | "meta"> {
	let span: number | null = null, rows: number | null = null, bare = false, meta: string | null = null;
	for (const match of text.matchAll(/([A-Za-z]+)(?:=(?:"((?:[^"\\]|\\.)*)"|(\S+)))?/g)) {
		const key = match[1]!, value = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3];
		switch (key) {
			case "span": case "rows": {
				const number = value === undefined ? NaN : Number(value);
				if (!Number.isInteger(number) || number < 1) diagnostics.push(diagnostic("draft", line, tr(`${key} must be a positive integer, e.g. {${key}=2}.`, `${key} 需要正整数，例如 {${key}=2}`)));
				else if (key === "span") span = number;
				else rows = number;
				break;
			}
			case "bare":
				bare = true;
				break;
			case "meta":
				if (value === undefined) diagnostics.push(diagnostic("draft", line, tr(`meta needs a value, e.g. {meta="Description"}.`, `meta 需要值，例如 {meta="说明"}`)));
				else meta = value;
				break;
			default:
				diagnostics.push(diagnostic("draft", line, tr(`Unknown panel attribute ${key}; available attributes are span, rows, bare, and meta.`, `未知的面板属性 ${key}：可用 span、rows、bare、meta`), "warning"));
		}
	}
	return { span, rows, bare, meta };
}

function frontmatter(lines: readonly Line[], diagnostics: DraftDiagnostic[]): { meta: DraftMeta; rest: readonly Line[] } {
	let template: DraftMeta["template"] = "sheet";
	let title: string | null = null, subtitle: string | null = null, cols = 3;
	const extra: { key: string; value: string }[] = [];
	let rest = lines;
	if (lines[0]?.text.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.text.trim() === "---");
		if (end < 0) {
			diagnostics.push(diagnostic("draft", 1, tr("The front matter is not closed; add a line --- at its end.", "稿头没有结束：在稿头末尾加一行 ---")));
		} else {
			const seen = new Set<string>();
			for (const line of lines.slice(1, end)) {
				if (!line.text.trim() || line.text.trimStart().startsWith("#")) continue;
				const match = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*(?:#.*)?$/.exec(line.text);
				if (!match) { diagnostics.push(diagnostic("draft", line.number, tr("Write each front-matter line as key: value.", "稿头每行写成 key: value"))); continue; }
				const key = match[1]!, value = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
				if (seen.has(key)) diagnostics.push(diagnostic("draft", line.number, tr(`Front-matter key ${key} is repeated; keep only one line.`, `稿头 ${key} 重复，只保留一行`), "warning"));
				seen.add(key);
				switch (key) {
					case "template":
						if (value === "sheet" || value === "doc") template = value;
						else diagnostics.push(diagnostic("draft", line.number, tr("template must be sheet or doc.", "template 只能是 sheet 或 doc")));
						break;
					case "title": title = value; break;
					case "subtitle": subtitle = value; break;
					case "cols": {
						const number = Number(value);
						if (Number.isInteger(number) && number >= 1 && number <= 6) cols = number;
						else diagnostics.push(diagnostic("draft", line.number, tr("cols must be an integer from 1 to 6, e.g. cols: 3.", "cols 需要 1 到 6 的整数，例如 cols: 3")));
						break;
					}
					case "lang": break;
					default:
						if (IGNORED_KEYS.has(key)) diagnostics.push(diagnostic("draft", line.number, tr(`${key} has no effect in a Playbook and was ignored.`, `${key} 在 Playbook 中不生效，已忽略`), "warning"));
						else extra.push({ key, value });
				}
			}
			rest = lines.slice(end + 1);
		}
	}
	const first = rest.findIndex(line => line.text.trim() !== "");
	if (title === null && first >= 0 && !rest[first]!.fenced) {
		const heading = /^# (.+?)[ \t]*$/.exec(rest[first]!.text);
		if (heading) {
			title = heading[1]!;
			rest = [...rest.slice(0, first), ...rest.slice(first + 1)];
		}
	}
	return { meta: { template, title, subtitle, cols, extra }, rest };
}

function letter(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26) + 1}`;
}

export function parseDocument(text: string): DraftDocument {
	const diagnostics: DraftDiagnostic[] = [];
	const all = splitLines(text);
	const { meta, rest } = frontmatter(all, diagnostics);
	const headings = rest.flatMap((line, index) => !line.fenced && line.text.startsWith("## ") ? [index] : []);
	const lead = segmentsOf(rest.slice(0, headings[0] ?? rest.length), diagnostics);
	const used = new Set<string>();
	const parsed = headings.map((at, index) => {
		const line = rest[at]!;
		const match = HEADING.exec(line.text)!;
		const id = match[1] ?? null;
		if (id !== null) {
			if (used.has(id)) diagnostics.push(diagnostic("draft", line.number, tr(`Panel ID ${id} is repeated; each panel's letter ID may be used only once.`, `面板 ID ${id} 重复：每个面板的字母 ID 只能用一次`)));
			used.add(id);
		}
		const end = headings[index + 1];
		const body = rest.slice(at + 1, end ?? rest.length);
		const title = match[2] ?? "";
		// The title sits after `## `, the optional letter ID and the spaces after it.
		const titleAt = line.text.indexOf(title, 3 + (id === null ? 0 : 1));
		const titleStart = line.offset + (title ? titleAt : line.text.length);
		return {
			id, title, line, titleSpan: { start: titleStart, end: titleStart + title.length },
			attrs: attributes(match[3] ?? "", line.number, diagnostics),
			end: end === undefined ? text.length : rest[end]!.offset,
			segments: segmentsOf(body, diagnostics),
		};
	});
	let next = 0;
	const panels: Panel[] = parsed.map(panel => {
		let id = panel.id;
		if (id === null) {
			while (used.has(letter(next))) next++;
			id = letter(next);
			used.add(id);
		}
		if (!panel.title && !panel.attrs.bare && panel.segments.length === 0) diagnostics.push(diagnostic("draft", panel.line.number, tr("The panel has neither a title nor content.", "面板没有标题也没有内容"), "warning"));
		return { id, explicit: panel.id !== null, title: panel.title, titleSpan: panel.titleSpan, ...panel.attrs, line: panel.line.number, start: panel.line.offset, end: panel.end, segments: panel.segments };
	});
	return { meta, lead, panels, diagnostics };
}

/** Every fenced block of a text, lead and panels alike, in order. */
export function fences(text: string): Extract<Segment, { kind: "fence" }>[] {
	const document = parseDocument(text);
	return [...document.lead, ...document.panels.flatMap(panel => panel.segments)].flatMap(segment => segment.kind === "fence" ? [segment] : []);
}

/** Text of the panel whose heading writes `id`; panels with assigned IDs cannot be addressed. */
export function panelText(text: string, id: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
	const panel = parseDocument(text).panels.find(candidate => candidate.explicit && candidate.id === id);
	if (!panel) return { ok: false, reason: tr(`Panel ${id} is not written in the design (write "## ${id} Title" in the heading)`, `设计稿中没有写出 ID 为 ${id} 的面板（请在标题中写 "## ${id} 标题"）`) };
	return { ok: true, text: text.slice(panel.start, panel.end).replace(/\n+$/, "") };
}

/**
 * The draft with the panel whose heading writes `id` replaced by `replacement`, which must itself
 * be one panel whose heading writes the same ID.
 */
export function replacePanel(text: string, id: string, replacement: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: "NotFound" | "BadValue"; readonly reason: string } {
	const panel = parseDocument(text).panels.find(candidate => candidate.explicit && candidate.id === id);
	if (!panel) return { ok: false, code: "NotFound", reason: tr(`The design has no panel with ID ${id}.`, `设计稿中没有写出 ID 为 ${id} 的面板`) };
	const own = parseDocument(replacement);
	if (own.panels.length !== 1 || own.lead.length > 0 || !own.panels[0]!.explicit || own.panels[0]!.id !== id) {
		return { ok: false, code: "BadValue", reason: tr(`The replacement must be one panel starting with "## ${id} Title".`, `替换文本必须是一个面板，以 "## ${id} 标题" 开头`) };
	}
	const tail = text.slice(panel.end);
	const body = replacement.replace(/\n+$/, "");
	return { ok: true, text: text.slice(0, panel.start) + body + (tail ? `\n\n${tail}` : text.endsWith("\n") ? "\n" : "") };
}
