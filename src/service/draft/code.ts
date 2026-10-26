import { tr } from "../../i18n";
import { posix } from "node:path";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";

interface LineRange {
	readonly from: number;
	readonly to: number;
}

type CodeSource =
	| { readonly kind: "inline"; readonly lines: readonly string[]; readonly start: number; readonly numbered: boolean }
	| { readonly kind: "file"; readonly path: string; readonly range: LineRange | null };

export interface CodeSpec {
	readonly language: string;
	readonly title: string | null;
	readonly source: CodeSource;
	readonly highlights: readonly LineRange[];
	/** Opening fence and first body line in the design draft, not in the quoted file. */
	readonly fenceLine: number;
	readonly bodyLine: number;
}

const SECRET_FILE = new RegExp([
	"^\\.env(?!\\.(?:example|sample|template)$)(?:\\..*)?$",
	"^(?:\\.netrc|\\.npmrc|\\.yarnrc(?:\\.yml)?|\\.pypirc|\\.pgpass|\\.my\\.cnf|\\.git-credentials|\\.htpasswd)$",
	"^(?:id_(?:rsa|dsa|ecdsa|ed25519).*|credentials.*|secrets?(?:\\..*)?|.*_history|.*\\.local\\.json)$",
	"\\.(?:pem|key|p12|pfx|keystore|jks|tfvars|tfstate(?:\\.backup)?|sqlite3?|db|kdbx|ovpn)$",
].join("|"), "i");
const SECRET_DIR: Readonly<Record<string, true | undefined>> = {
	".git": true, ".ssh": true, ".aws": true, ".azure": true, ".gnupg": true,
	".kube": true, ".docker": true, ".password-store": true,
};
const SECRET_TEXT = /sk-ant-|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.|(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s$<{]{12,}["']|\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*[^"'\s]\S{7,}/i;

/** Return the first credential match, preserving its source offset for diagnostics. */
export function findSecret(text: string): RegExpExecArray | null {
	return SECRET_TEXT.exec(text);
}

function secretPath(path: string): boolean {
	const parts = posix.normalize(path.replace(/\\/g, "/")).split("/");
	return SECRET_FILE.test(parts.at(-1) ?? "") || parts.some(part => SECRET_DIR[part.toLowerCase()] === true);
}

/** Split whitespace-delimited attributes, retaining whitespace within quoted values. */
function argumentsOf(args: string): readonly string[] | null {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let started = false;
	for (let i = 0; i < args.length; i++) {
		const char = args[i]!;
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && (args[i + 1] === quote || args[i + 1] === "\\")) token += args[++i]!;
			else token += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) return null;
	if (started) tokens.push(token);
	return tokens;
}

function rangeOf(value: string): LineRange | null {
	const match = /^(\d+)(?:-(\d+))?$/.exec(value);
	if (!match) return null;
	const from = Number(match[1]);
	const to = Number(match[2] ?? match[1]);
	return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from ? { from, to } : null;
}

function lengthFinding(count: number, line: number): DraftDiagnostic | null {
	if (count > 200) return diagnostic("code", line, tr(`Code has ${count} lines; use lines=18-30 to include at most 200 lines, or split the code block.`, `代码有 ${count} 行；请用 lines=18-30 截取至多 200 行，或拆分代码块。`));
	if (count > 40) return diagnostic("code", line, tr(`Code has ${count} lines; trim it to the 10–40 lines that best show the issue.`, `代码有 ${count} 行；请精简为最能说明问题的 10–40 行。`), "warning");
	return null;
}

function highlightFinding(ranges: readonly LineRange[], first: number, count: number, line: number): DraftDiagnostic | null {
	const last = first + (count - 1);
	if (!Number.isSafeInteger(last)) return diagnostic("code", line, tr("Displayed line numbers exceed the safe integer range; reduce start=38.", "显示行号超出安全整数范围；请减小 start=38。"));
	const outside = ranges.find(range => range.from < first || range.to > last);
	return outside ? diagnostic("code", line, tr(`hl= exceeds displayed line numbers ${first}–${last}; highlight only lines actually shown in the code block.`, `hl= 超出显示行号 ${first}–${last}；请仅高亮代码块中实际显示的行。`)) : null;
}

export function parseCode(input: FenceInput): Parsed<CodeSpec> {
	const fenceLine = Math.max(1, input.line - 1);
	const fail = (message: string): Parsed<CodeSpec> => ({ ok: false, diagnostics: [diagnostic("code", fenceLine, message)] });
	const tokens = argumentsOf(input.args);
	if (!tokens) return fail(tr('Unclosed quote; write title="limits.ts · sketch".', '引号未闭合；请写 title="limits.ts · sketch"。'));
	const hasLanguage = tokens[0] !== undefined && !tokens[0].includes("=");
	const language = hasLanguage ? tokens[0]! : "";
	let src: string | null = null;
	let lines: LineRange | null = null;
	const highlights: LineRange[] = [];
	let title: string | null = null;
	let start = 1;
	let numbered = false;
	const seen = new Set<string>();
	for (const token of tokens.slice(hasLanguage ? 1 : 0)) {
		const equals = token.indexOf("=");
		if (equals < 1) return fail(tr("Code settings need key=value; write src=server/routes.ts lines=18-30 hl=22 title=sketch start=38.", "代码设置需要键和值；请写 src=server/routes.ts lines=18-30 hl=22 title=sketch start=38。"));
		const key = token.slice(0, equals);
		const value = token.slice(equals + 1);
		if (seen.has(key)) return fail(tr(`Setting ${key}= is repeated; keep only one value.`, `设置 ${key}= 重复；请只保留一个值。`));
		seen.add(key);
		switch (key) {
			case "src":
				if (!value) return fail(tr("src= is missing a path; write src=server/routes.ts.", "src= 缺少路径；请写 src=server/routes.ts。"));
				src = value;
				break;
			case "lines":
				lines = rangeOf(value);
				if (!lines) return fail(tr("lines= must be a positive integer with the start no later than the end; write lines=18-30 or lines=18.", "lines= 必须是正整数且起点不大于终点；请写 lines=18-30 或 lines=18。"));
				break;
			case "hl":
				for (const part of value.split(",")) {
					const range = rangeOf(part.trim());
					if (!range) return fail(tr("hl= must be a positive line number or range; write hl=20-22,25.", "hl= 必须是正整数行号或范围；请写 hl=20-22,25。"));
					highlights.push(range);
				}
				break;
			case "title":
				title = value;
				break;
			case "start":
				if (!/^\d+$/.test(value) || !rangeOf(value)) return fail(tr("start= must be a positive integer; write start=38.", "start= 必须是正整数；请写 start=38。"));
				start = Number(value);
				numbered = true;
				break;
			default:
				return fail(tr(`Unknown code setting ${key}=; use src=, lines=, hl=, title=, or start=.`, `未知代码设置 ${key}=；请使用 src=、lines=、hl=、title= 或 start=。`));
		}
	}
	if (lines && src === null) return fail(tr("lines= requires src=; for hand-written code, use start=38 to set the starting line number.", "lines= 需要 src=；手写代码请用 start=38 设置起始行号。"));
	const diagnostics: DraftDiagnostic[] = [];
	if (src !== null) {
		const nonempty = input.lines.findIndex(line => line.trim().length > 0);
		if (nonempty >= 0) diagnostics.push(diagnostic("code", input.line + nonempty, tr("src= reads code from a file, so text inside the block is not displayed; leave the code block empty.", "src= 从文件读取代码，块内文字不会显示；请将代码块留空。"), "warning"));
	} else {
		const finding = lengthFinding(input.lines.length, input.line);
		if (finding) diagnostics.push(finding);
		const highlight = highlightFinding(highlights, start, input.lines.length, fenceLine);
		if (highlight) diagnostics.push(highlight);
		if (diagnostics.some(item => item.severity === "error")) return { ok: false, diagnostics };
	}
	return {
		ok: true,
		value: {
			language, title, highlights, fenceLine, bodyLine: input.line,
			source: src === null ? { kind: "inline", lines: [...input.lines], start, numbered } : { kind: "file", path: src, range: lines },
		},
		diagnostics,
	};
}

export function renderCode(spec: CodeSpec, ctx: RenderContext): Rendered {
	const fail = (message: string, line = spec.fenceLine): Rendered => ({ nodes: [], diagnostics: [diagnostic("code", line, message)] });
	let body: readonly string[];
	let start: number;
	let numbers: boolean;
	let header = spec.title ?? "";
	let language = spec.language;
	const diagnostics: DraftDiagnostic[] = [];
	switch (spec.source.kind) {
		case "inline":
			body = spec.source.lines;
			start = spec.source.start;
			numbers = spec.source.numbered;
			break;
		case "file": {
			const source = spec.source;
			if (secretPath(source.path)) return fail(tr("src= points to a file conventionally used for secrets or passwords; use ordinary source code instead, or write hand-written code with title=sketch.", "src= 指向按惯例保存密钥或密码的文件；请改引普通源码，或写 title=sketch 的手写代码。"));
			const result = ctx.readFile(source.path);
			if (!result.ok) return fail(tr("Unable to read the src= file (it does not exist, is unreadable, or is outside the Playbook directory); use a readable source path inside the directory.", "无法读取 src= 文件（不存在、不可读或超出 Playbook 目录）；请改为目录内可读的源码路径。"));
			if (secretPath(result.path)) return fail(tr("src= actually points to a file conventionally used for secrets or passwords; use ordinary source code instead, or write hand-written code with title=sketch.", "src= 实际指向按惯例保存密钥或密码的文件；请改引普通源码，或写 title=sketch 的手写代码。"));
			if (result.bytes.byteLength > 2 * 1024 * 1024) return fail(tr("The src= file exceeds 2 MB; use a smaller source file instead.", "src= 文件超过 2 MB；请改引较小的源码文件。"));
			if (result.bytes.includes(0)) return fail(tr("src= is a binary file; use a text source file instead.", "src= 是二进制文件；请改引文本源码文件。"));
			const text = new TextDecoder().decode(result.bytes);
			// Inspect the whole file before taking a slice: excluded lines may still hold credentials.
			if (findSecret(text)) return fail(tr("The src= file contains a suspected secret or token, so no part will be displayed; use source code without credentials, or write hand-written code with title=sketch.", "src= 文件包含疑似密钥或令牌，任何片段都不会显示；请改引不含凭据的源码，或写 title=sketch 的手写代码。"));
			const all = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
			start = source.range?.from ?? 1;
			const end = source.range?.to ?? all.length;
			if (end > all.length) return fail(tr(`The src= file has only ${all.length} lines; change the lines= range to lines that exist in the file.`, `src= 文件只有 ${all.length} 行；请将 lines= 范围改为文件内实际存在的行。`));
			body = all.slice(start - 1, end);
			numbers = true;
			if (spec.title === null) header = source.path + (source.range ? `:${start}${end === start ? "" : `-${end}`}` : "");
			if (!language) language = posix.extname(source.path.replace(/\\/g, "/")).slice(1).toLowerCase();
			const length = lengthFinding(body.length, spec.fenceLine);
			if (length?.severity === "error") return { nodes: [], diagnostics: [length] };
			if (length) diagnostics.push(length);
			break;
		}
	}
	const text = body.join("\n");
	if (findSecret(text)) {
		const offset = body.findIndex(line => findSecret(line) !== null);
		return fail(tr("The code contains a suspected secret or token, so it will not be displayed; use code without credentials, or write illustrative hand-written code with title=sketch.", "代码包含疑似密钥或令牌，内容不会显示；请改引不含凭据的代码，或写 title=sketch 的示意代码。"), spec.bodyLine + Math.max(0, offset));
	}
	const highlight = highlightFinding(spec.highlights, start, body.length, spec.fenceLine);
	if (highlight) return { nodes: [], diagnostics: [highlight] };
	const marks = [];
	for (let offset = 0; offset < body.length; offset++) {
		const line = start + offset;
		if (spec.highlights.some(range => line >= range.from && line <= range.to)) marks.push({ line, tone: "warning" });
	}
	return {
		nodes: [{ id: `${ctx.id}.code`, k: "code", p: { text, lang: language, start, numbers, marks, path: header } }],
		diagnostics,
	};
}
