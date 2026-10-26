import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { escapeXml, textWidth, wrapText } from "./text";

interface Annotation {
	/** UTF-16 offsets in the sentence's plain text. */
	readonly start: number;
	readonly end: number;
	readonly note: string;
	readonly tone: "accent" | "error";
}

interface AnnotSentence {
	readonly text: string;
	readonly annotations: readonly Annotation[];
}

interface AnnotGroup {
	readonly heading: string;
	readonly rightNote: string;
	readonly sentences: readonly AnnotSentence[];
	readonly captions: readonly string[];
}

export interface AnnotSpec {
	readonly groups: readonly AnnotGroup[];
}

function parseSentence(source: string, line: number, diagnostics: DraftDiagnostic[]): AnnotSentence {
	let text = "";
	const annotations: Annotation[] = [];
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("[", cursor);
		if (open === -1) {
			text += source.slice(cursor);
			break;
		}
		text += source.slice(cursor, open);
		const close = source.indexOf("]", open + 1);
		if (close === -1) {
			diagnostics.push(diagnostic("annot", line, tr("Annotation is missing a closing square bracket; write [fragment]{note}", "标注缺少右方括号；请写成 [片段]{说明}")));
			break;
		}
		// Brackets in ordinary prose are not an annotation until followed by a brace.
		if (source[close + 1] !== "{") {
			text += source.slice(open, close + 1);
			cursor = close + 1;
			continue;
		}
		const end = source.indexOf("}", close + 2);
		if (end === -1) {
			diagnostics.push(diagnostic("annot", line, tr("Annotation is missing a closing brace; write [fragment]{note}", "标注缺少右花括号；请写成 [片段]{说明}")));
			break;
		}
		const span = source.slice(open + 1, close);
		if (!span) {
			diagnostics.push(diagnostic("annot", line, tr("Annotation fragment cannot be empty; write [fragment]{note}", "标注片段不能为空；请写成 [片段]{说明}")));
		}
		const rawNote = source.slice(close + 2, end);
		const red = rawNote.startsWith("!");
		annotations.push({ start: text.length, end: text.length + span.length, note: (red ? rawNote.slice(1) : rawNote).trim(), tone: red ? "error" : "accent" });
		text += span;
		cursor = end + 1;
	}
	return { text, annotations };
}

export function parseAnnot(input: FenceInput): Parsed<AnnotSpec> {
	const groups: { heading: string; rightNote: string; sentences: AnnotSentence[]; captions: string[] }[] = [];
	const diagnostics: DraftDiagnostic[] = [];
	const ensureGroup = (): (typeof groups)[number] => {
		let group = groups.at(-1);
		if (!group) {
			group = { heading: "", rightNote: "", sentences: [], captions: [] };
			groups.push(group);
		}
		return group;
	};
	for (const [index, raw] of input.lines.entries()) {
		const source = raw.trim();
		if (!source) continue;
		if (source.startsWith("#")) {
			const body = source.replace(/^#+\s*/, "");
			const pipe = body.indexOf("|");
			groups.push({ heading: (pipe === -1 ? body : body.slice(0, pipe)).trim(), rightNote: pipe === -1 ? "" : body.slice(pipe + 1).trim(), sentences: [], captions: [] });
		} else if (source.startsWith(">")) {
			ensureGroup().captions.push(source.replace(/^>\s*/, ""));
		} else {
			ensureGroup().sentences.push(parseSentence(source, input.line + index, diagnostics));
		}
	}
	if (!groups.length) diagnostics.push(diagnostic("annot", input.line, tr("Write at least one sentence, e.g. [fragment]{note}", "请至少写一个句子，例如 [片段]{说明}")));
	if (diagnostics.length) return { ok: false, diagnostics };
	return { ok: true, value: { groups }, diagnostics };
}

const WIDTH = 900;
const PAD = 24;
const CONTENT = WIDTH - PAD * 2;
const SENTENCE_SIZE = 16;
const NOTE_SIZE = 12;

/** Use shared word/CJK wrapping, splitting only a single token that exceeds the canvas. */
function fitLines(text: string, width: number, size: number): string[] {
	const result: string[] = [];
	for (const line of wrapText(text, width, size)) {
		if (textWidth(line, size) <= width) {
			result.push(line);
			continue;
		}
		let part = "";
		let partWidth = 0;
		for (const char of line) {
			const charWidth = textWidth(char, size);
			if (part && partWidth + charWidth > width) {
				result.push(part);
				part = "";
				partWidth = 0;
			}
			part += char;
			partWidth += charWidth;
		}
		if (part) result.push(part);
	}
	return result;
}

function svgText(text: string, x: number, y: number, size: number, color: string, extra = ""): string {
	const width = textWidth(text, size);
	return `<text x="${x}" y="${y}" font-size="${size}" fill="var(--${color})"${width ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"` : ""}${extra}>${escapeXml(text)}</text>`;
}

interface NoteLayout {
	readonly annotation: Annotation;
	readonly x: number;
	readonly width: number;
	readonly lines: readonly string[];
}

interface NoteTrack {
	readonly notes: NoteLayout[];
	height: number;
}

function renderSentence(sentence: AnnotSentence, top: number): { readonly svg: string; readonly bottom: number } {
	const output: string[] = [];
	let y = top;
	let offset = 0;
	for (const rowText of fitLines(sentence.text, CONTENT, SENTENCE_SIZE)) {
		// wrapText removes whitespace at row boundaries, except leading whitespace
		// retained in the first row. Preserve that prefix when advancing source offsets.
		const sourceWhitespace = /^\s*/u.exec(sentence.text.slice(offset))![0].length;
		const rowWhitespace = /^\s*/u.exec(rowText)![0].length;
		offset += Math.max(0, sourceWhitespace - rowWhitespace);
		const start = offset;
		const end = start + rowText.length;
		offset = end;
		const baseline = y + SENTENCE_SIZE;
		output.push(svgText(rowText, PAD, baseline, SENTENCE_SIZE, "fg", ' xml:space="preserve"'));
		const tracks: NoteTrack[] = [];
		for (const annotation of sentence.annotations) {
			const left = Math.max(start, annotation.start);
			const right = Math.min(end, annotation.end);
			if (left >= right) continue;
			const x1 = PAD + textWidth(rowText.slice(0, left - start), SENTENCE_SIZE);
			const x2 = PAD + textWidth(rowText.slice(0, right - start), SENTENCE_SIZE);
			const bracketY = baseline + 8;
			output.push(`<path d="M ${x1} ${bracketY - 4} V ${bracketY} H ${x2} V ${bracketY - 4}" fill="none" stroke="var(--${annotation.tone})" stroke-width="1.5"/>`);
			// A wrapped annotation retains brackets on each row and owns just one note.
			if (!annotation.note || (annotation.end > end && sentence.text.slice(end, annotation.end).trim())) continue;
			const lines = fitLines(annotation.note, Math.min(380, CONTENT), NOTE_SIZE);
			const width = Math.max(...lines.map(line => textWidth(line, NOTE_SIZE)));
			const x = Math.max(PAD, Math.min(x1, WIDTH - PAD - width));
			const note: NoteLayout = { annotation, x, width, lines };
			let track = tracks.find(candidate => candidate.notes.every(other => x + width + 12 <= other.x || other.x + other.width + 12 <= x));
			if (!track) {
				track = { notes: [], height: 0 };
				tracks.push(track);
			}
			track.notes.push(note);
			track.height = Math.max(track.height, lines.length * 17);
		}
		let noteY = baseline + 25;
		for (const track of tracks) {
			for (const note of track.notes) {
				for (const [index, line] of note.lines.entries()) output.push(svgText(line, note.x, noteY + index * 17, NOTE_SIZE, note.annotation.tone));
			}
			noteY += track.height + 9;
		}
		y = tracks.length ? noteY + 9 : baseline + 25;
	}
	return { svg: output.join(""), bottom: y };
}

export function renderAnnot(spec: AnnotSpec, ctx: RenderContext): Rendered {
	const nodes = spec.groups.map((group, index) => {
		const output: string[] = [];
		let y = PAD;
		if (group.heading || group.rightNote) {
			const headingWidth = group.rightNote ? CONTENT * 0.62 : CONTENT;
			const noteWidth = group.heading ? CONTENT * 0.34 : CONTENT;
			const heading = group.heading ? fitLines(group.heading, headingWidth, 16) : [];
			const right = group.rightNote ? fitLines(group.rightNote, noteWidth, 12) : [];
			for (const [row, text] of heading.entries()) output.push(svgText(text, PAD, y + 16 + row * 23, 16, "fg", ' font-weight="600"'));
			for (const [row, text] of right.entries()) output.push(svgText(text, WIDTH - PAD - textWidth(text, 12), y + 16 + row * 23, 12, "muted"));
			y += Math.max(heading.length, right.length) * 23 + 15;
			output.push(`<path d="M ${PAD} ${y - 9} H ${WIDTH - PAD}" stroke="var(--border)"/>`);
		}
		for (const sentence of group.sentences) {
			const rendered = renderSentence(sentence, y);
			output.push(rendered.svg);
			y = rendered.bottom + 8;
		}
		for (const caption of group.captions) {
			for (const line of fitLines(caption, CONTENT, 13)) {
				output.push(svgText(line, PAD, y + 13, 13, "muted"));
				y += 20;
			}
			y += 4;
		}
		const height = y + PAD;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Arial, sans-serif"><rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="var(--surface)" stroke="var(--border)"/>${output.join("")}</svg>`;
		const alt = [group.heading, group.rightNote, ...group.sentences.flatMap(sentence => [sentence.text, ...sentence.annotations.map(annotation => annotation.note)]), ...group.captions].filter(Boolean).join("; ");
		return ctx.svg(`${ctx.id}.group.${index}`, svg, { w: WIDTH, h: height }, alt);
	});
	return { nodes, diagnostics: [] };
}
