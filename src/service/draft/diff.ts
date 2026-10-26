import { tr } from "../../i18n";
import { findSecret } from "./code";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";

export interface DiffSpec {
	/** Diff body without non-drawn git metadata; blank context lines are preserved. */
	readonly text: string;
	readonly lineCount: number;
	readonly file: string;
	readonly title: string;
	readonly language: string;
	readonly added: number;
	readonly removed: number;
	readonly numbering: { readonly kind: "none" } | { readonly kind: "hunks" } | { readonly kind: "start"; readonly start: number };
	readonly highlights: readonly number[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const META = /^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (?:from|to) )/;

interface HunkCount {
	readonly line: number;
	readonly oldCount: number;
	readonly newCount: number;
	oldSeen: number;
	newSeen: number;
}

function headerPath(line: string): string {
	const path = line.slice(4).split("\t")[0]!.trim().replace(/^[ab]\//, "");
	return path === "/dev/null" ? "" : path;
}

export function parseDiff(input: FenceInput): Parsed<DiffSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	const fail = (line: number, message: string): void => { diagnostics.push(diagnostic("diff", line, message)); };
	const argLine = Math.max(1, input.line - 1);
	let file: string | undefined;
	let title: string | undefined;
	let start: number | undefined;
	let hl: string | undefined;
	let remaining = input.args.trim();
	while (remaining) {
		const match = /^([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+|$)/.exec(remaining);
		if (!match) {
			fail(argLine, tr('Write arguments as file=src/code.ts title="Change description" start=22 hl=22-25,30.', '参数写成 file=src/code.ts title="修改说明" start=22 hl=22-25,30。'));
			break;
		}
		const value = match[2] ?? match[3] ?? match[4]!;
		switch (match[1]) {
			case "file": file = value; break;
			case "title": title = value; break;
			case "hl": hl = value; break;
			case "start":
				if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(argLine, tr("The starting line number must be a positive integer, e.g. start=22.", "起始行号须为正整数，例如 start=22。"));
				else start = Number(value);
				break;
			case "src": fail(argLine, tr("diff does not support src=; paste a unified diff inside the fence.", "diff 不支持 src=；把统一 diff 粘贴到围栏内。")); break;
			case "lines": fail(argLine, tr("diff does not support lines=; use start=22 or @@ -22,2 +22,3 @@ numbering.", "diff 不支持 lines=；用 start=22 或 @@ -22,2 +22,3 @@ 编号。")); break;
			default: fail(argLine, tr(`Unknown parameter ${match[1]}; use only file=, title=, start=, and hl=.`, `未知参数 ${match[1]}；只使用 file=、title=、start=、hl=。`));
		}
		remaining = remaining.slice(match[0].length);
	}
	if (input.lines.length > 200) fail(input.line, tr("diff exceeds 200 lines; split it into blocks of at most 200 lines.", "diff 超过 200 行；拆成每块最多 200 行。"));
	else if (input.lines.length > 40) diagnostics.push(diagnostic("diff", input.line, tr("diff exceeds 40 lines; select the 10–40 lines that best show the change.", "diff 超过 40 行；选取最能说明修改的 10–40 行。"), "warning"));
	const body = input.lines.join("\n");
	const secret = findSecret(body);
	if (secret) fail(input.line + body.slice(0, secret.index).split("\n").length - 1, tr("This line appears to contain a secret or token; remove the credential and use illustrative code without secrets.", "此行疑似含密钥或令牌；删除凭据，改用不含秘密的示意代码。"));
	if (diagnostics.some(item => item.severity === "error")) return { ok: false, diagnostics };

	const lines: string[] = [];
	const newLines = new Set<number>();
	let inferredFile = "";
	let oldPath = "";
	let added = 0;
	let removed = 0;
	let newNumber = start ?? 1;
	let hunk: HunkCount | undefined;
	let hasHunk = false;
	let started = false;
	let previousOldHeader = false;
	const closeHunk = (): void => {
		if (hunk && (hunk.oldCount !== hunk.oldSeen || hunk.newCount !== hunk.newSeen)) {
			diagnostics.push(diagnostic("diff", hunk.line, tr(`The block has ${hunk.oldSeen} old-side lines and ${hunk.newSeen} new-side lines; correct the @@ counts or add the missing content.`, `区块实际有旧侧 ${hunk.oldSeen} 行、新侧 ${hunk.newSeen} 行；修正 @@ 的行数或补齐内容。`), "warning"));
		}
		hunk = undefined;
	};
	for (let i = 0; i < input.lines.length; i++) {
		const line = input.lines[i]!;
		const sourceLine = input.line + i;
		if (line.startsWith("diff --git ")) {
			closeHunk();
			started = false;
			oldPath = "";
			previousOldHeader = false;
			continue;
		}
		if (META.test(line) || line === "\\ No newline at end of file") { previousOldHeader = false; continue; }
		const preamble = (!hunk && !started) || (hunk !== undefined && hunk.oldSeen >= hunk.oldCount && hunk.newSeen >= hunk.newCount);
		if (preamble && line.startsWith("--- ") && (input.lines[i + 1]?.startsWith("+++ ") || /^--- (?:a\/|\/dev\/null)/.test(line))) {
			oldPath = headerPath(line);
			previousOldHeader = true;
			continue;
		}
		if (preamble && line.startsWith("+++ ") && (previousOldHeader || /^\+\+\+ (?:b\/|\/dev\/null)/.test(line))) {
			inferredFile ||= headerPath(line) || oldPath;
			previousOldHeader = false;
			continue;
		}
		previousOldHeader = false;
		const match = HUNK.exec(line);
		if (match) {
			closeHunk();
			const oldStart = Number(match[1]);
			newNumber = Number(match[3]);
			const oldCount = match[2] === undefined ? 1 : Number(match[2]);
			const newCount = match[4] === undefined ? 1 : Number(match[4]);
			if (![oldStart, newNumber, oldCount, newCount].every(Number.isSafeInteger) || !Number.isSafeInteger(oldStart + oldCount) || !Number.isSafeInteger(newNumber + newCount)) {
				fail(sourceLine, tr("The block line numbers or counts are too large; write @@ -22,2 +22,3 @@.", "区块行号或行数过大；写成 @@ -22,2 +22,3 @@。"));
				continue;
			}
			hasHunk = true;
			hunk = { line: sourceLine, oldCount, newCount, oldSeen: 0, newSeen: 0 };
			lines.push(line);
			continue;
		}
		if (line.startsWith("@@")) { fail(sourceLine, tr("Write a hunk header as @@ -22,2 +22,3 @@ (old start and count, new start and count).", "区块头写成 @@ -22,2 +22,3 @@（旧起点和行数、新起点和行数）。")); continue; }
		if (/^ ?(?:\.\.\.|…)\s*$/.test(line)) { fail(sourceLine, tr("Do not use ... or … to omit lines; split into blocks that each have @@ -22,2 +22,3 @@.", "不能用 ... 或 … 省略行；拆成各自带 @@ -22,2 +22,3 @@ 的区块。")); continue; }
		const kind = line === "" ? " " : line[0];
		if (kind !== "+" && kind !== "-" && kind !== " ") { fail(sourceLine, tr("A diff line must start with +, -, or a space; prefix unchanged code with one space.", "diff 行须以 +、- 或空格开头；未修改的代码前加一个空格。")); continue; }
		started = true;
		if (kind === "+") added++;
		if (kind === "-") removed++;
		if (kind !== "+" && hunk) hunk.oldSeen++;
		if (kind !== "-") {
			if (!Number.isSafeInteger(newNumber)) fail(sourceLine, tr("The line number is too large; reduce the starting line number in start= or @@.", "行号过大；减小 start= 或 @@ 中的起始行号。"));
			newLines.add(newNumber++);
			if (hunk) hunk.newSeen++;
		}
		lines.push(line);
	}
	closeHunk();
	const highlights = new Set<number>();
	if (hl !== undefined) {
		if (!hasHunk && start === undefined) fail(argLine, tr("hl= needs new-side line numbers; add @@ -22,2 +22,3 @@ or start=22.", "hl= 需要新侧行号；添加 @@ -22,2 +22,3 @@ 或 start=22。"));
		for (const part of hl.split(",")) {
			const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
			const from = match ? Number(match[1]) : 0;
			const to = match ? Number(match[2] ?? match[1]) : 0;
			if (!match || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
				fail(argLine, tr("Write the highlight range as hl=22-25,30; the start must be greater than zero and no later than the end.", "高亮范围写成 hl=22-25,30，起点须大于零且不晚于终点。"));
				continue;
			}
			// At most 200 body lines exist. Stop at the first missing number rather than expanding arbitrary ranges.
			for (let number = from; number <= to; number++) {
				if (!newLines.has(number)) { fail(argLine, tr(`hl=${number} is not on the new side of the diff; choose an existing new-side line number.`, `hl=${number} 不在 diff 新侧；选择实际存在的新侧行号。`)); break; }
				highlights.add(number);
			}
		}
	}
	if (diagnostics.some(item => item.severity === "error")) return { ok: false, diagnostics };
	const name = file ?? inferredFile;
	const basename = name.split(/[\\/]/).at(-1) ?? "";
	const extension = /\.([^.]+)$/.exec(basename)?.[1]?.toLowerCase() ?? "diff";
	return {
		ok: true,
		value: {
			text: lines.join("\n"), lineCount: lines.length, file: name, title: title ?? name, language: extension, added, removed,
			numbering: hasHunk ? { kind: "hunks" } : start !== undefined ? { kind: "start", start } : { kind: "none" },
			highlights: [...highlights].sort((a, b) => a - b),
		},
		diagnostics,
	};
}

export function renderDiff(spec: DiffSpec, ctx: RenderContext): Rendered {
	let text = spec.text;
	if (spec.numbering.kind === "start") {
		const count = spec.lineCount;
		text = `@@ -${spec.numbering.start},${count - spec.added} +${spec.numbering.start},${count - spec.removed} @@\n${text}`;
	}
	return {
		nodes: [
			{ id: `${ctx.id}.header`, k: "text", p: { spans: [
				{ t: spec.title, s: "strong" }, { t: `${spec.title ? "  " : ""}+${spec.added}`, s: "success" }, { t: ` −${spec.removed}`, s: "error" },
			] } },
			{ id: `${ctx.id}.diff`, k: "diff", p: { text, path: spec.file, lang: spec.language } },
			...(spec.highlights.length ? [{ id: `${ctx.id}.highlights`, k: "text", p: { spans: [{ t: tr(`Highlight: ${spec.highlights.join(", ")}`, `高亮：${spec.highlights.join(", ")}`), s: "muted" }] } }] : []),
		],
		diagnostics: [],
	};
}
