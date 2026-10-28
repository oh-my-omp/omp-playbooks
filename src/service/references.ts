import { parseBlockId } from "../domain/model";
import type { BlockContent, BlockId, CompileInput, CompileResult, ErrorSite, ExternalTarget, IssueValue, Reference, ReferenceExpression, Selector, Source, Target } from "../domain/model";
import { tr } from "../i18n";
import { panelText, replacePanel } from "./draft/document";
import type { ReferencesModule } from "../domain/ports";
import { qualifiedUses, resolveSlots, slotTable, slotTexts, type SlotTable } from "./draft/slot";
type Span = { start: number; end: number };
type Selection = { ok: true; text: string } | { ok: false; reason: string };
type ParsedExpression = { ok: true; value: ReferenceExpression } | { ok: false; reason: string };

/** Fence spans include their delimiter lines, and an unclosed fence extends to EOF. */
function fenceSpans(body: string): Span[] {
	const spans: Span[] = [];
	let fence: { character: string; length: number; start: number } | null = null;
	let offset = 0;
	for (const line of body.split("\n")) {
		if (fence) {
			const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
			if (closing && closing[1]!.startsWith(fence.character) && closing[1]!.length >= fence.length) {
				spans.push({ start: fence.start, end: Math.min(body.length, offset + line.length + 1) });
				fence = null;
			}
		} else {
			const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (opening && !(opening[1]!.startsWith("`") && opening[2]!.includes("`"))) {
				fence = { character: opening[1]![0]!, length: opening[1]!.length, start: offset };
			}
		}
		offset += line.length + 1;
	}
	if (fence) spans.push({ start: fence.start, end: body.length });
	return spans;
}

function codeSpans(body: string): Span[] {
	const fences = fenceSpans(body);
	const spans: Span[] = [];
	let index = 0;
	let fenceIndex = 0;
	while (index < body.length) {
		const fence = fences[fenceIndex];
		if (fence && index >= fence.start) {
			spans.push(fence);
			index = fence.end;
			fenceIndex++;
			continue;
		}
		if (body[index] !== "`") { index++; continue; }
		const start = index;
		while (body[index] === "`") index++;
		const length = index - start;
		let close = index;
		const limit = fence?.start ?? body.length;
		let found = false;
		while (close < limit) {
			if (body[close] !== "`") { close++; continue; }
			const run = close;
			while (body[close] === "`") close++;
			if (close - run === length) {
				spans.push({ start, end: close });
				index = close;
				found = true;
				break;
			}
		}
		if (!found) index = start + length;
	}
	return spans;
}

function parseReferences(body: string): Reference[] {
	const spans = codeSpans(body);
	const result: Reference[] = [];
	let spanIndex = 0;
	for (let index = 0; index < body.length - 1; index++) {
		while (spans[spanIndex] && spans[spanIndex]!.end <= index) spanIndex++;
		const span = spans[spanIndex];
		if (span && index >= span.start) { index = span.end - 1; continue; }
		if (!body.startsWith("((", index)) continue;
		let parentheses = 0;
		let quoted = false;
		let escaped = false;
		let terminator = -1;
		let fallback = -1;
		for (let end = index + 2; end < body.length - 1; end++) {
			const character = body[end]!;
			if (character === "\n" || character === "\r" || (span && end >= span.start)) break;
			if (body.startsWith("))", end)) {
				if (fallback < 0) fallback = end;
				if (!quoted && parentheses === 0) { terminator = end; break; }
			}
			if (quoted) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') quoted = false;
				continue;
			}
			if (character === '"') quoted = true;
			else if (character === "(") parentheses++;
			else if (character === ")" && parentheses > 0) parentheses--;
		}
		if (terminator < 0) terminator = fallback;
		if (terminator >= 0) {
			const inner = body.slice(index + 2, terminator);
			const separator = inner.indexOf("|");
			result.push({ text: body.slice(index, terminator + 2), targetText: (separator < 0 ? inner : inner.slice(0, separator)).trim(), expressionText: separator < 0 ? null : inner.slice(separator + 1).trim(), offset: index });
			index = terminator + 1;
		}
	}
	return result;
}

function parseTarget(text: string): Target | null {
	const value = text.trim();
	const block = parseBlockId(value);
	if (block) return { kind: "block", block };
	if (value.endsWith(".result")) {
		const result = parseBlockId(value.slice(0, -7));
		if (result) return { kind: "result", block: result };
	}
	const github = /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(value);
	if (github) {
		const number = Number(github[4]);
		if (!Number.isSafeInteger(number)) return null;
		const owner = github[1]!.toLowerCase();
		const repo = github[2]!.toLowerCase();
		const kind = github[3] === "issues" ? "issue" : "pull";
		return { kind, owner, repo, number, url: `https://github.com/${owner}/${repo}/${kind === "issue" ? "issues" : "pull"}/${number}` };
	}
	if (value.startsWith("file:")) {
		const path = value.slice(5);
		if (path.length > 0 && !path.startsWith("/") && !/[\r\n\0]/.test(path)) return { kind: "file", path };
	}
	return null;
}

function targetKey(target: Target): string {
	switch (target.kind) {
		case "block": return target.block;
		case "result": return `${target.block}.result`;
		case "issue": return `https://github.com/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}/issues/${target.number}`;
		case "pull": return `https://github.com/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}/pull/${target.number}`;
		case "file": {
			const parts: string[] = [];
			for (const part of target.path.split("/")) {
				if (!part || part === ".") continue;
				if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
				else parts.push(part);
			}
			return `file:${parts.join("/") || "."}`;
		}
	}
}

function parseExpression(expression: string | null): ParsedExpression {
	if (expression === null) return { ok: true, value: { alias: null, selectors: [], selection: null } };
	const tokens: string[] = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < expression.length; index++) {
		const character = expression[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
		} else if (character === '"') quoted = true;
		else if (character === ",") { tokens.push(expression.slice(start, index).trim()); start = index + 1; }
	}
	if (quoted) return { ok: false, reason: tr("Unclosed quoted string", "未闭合的引号字符串") };
	tokens.push(expression.slice(start).trim());
	let alias: string | null = null;
	const selectors: Selector[] = [];
	const picks: string[] = [];
	for (const token of tokens) {
		const named = /^as\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(token);
		if (named) {
			if (alias !== null) return { ok: false, reason: tr(`Only one as(…) is allowed: ${token}`, `只能写一个 as(…)：${token}`) };
			let value: unknown;
			try { value = JSON.parse(named[1]!); } catch { return { ok: false, reason: tr(`Invalid alias: ${token}`, `别名无效：${token}`) }; }
			if (typeof value !== "string" || !value.trim()) return { ok: false, reason: tr(`An alias cannot be blank: ${token}`, `别名不能为空：${token}`) };
			alias = value.trim();
			continue;
		}
		picks.push(token);
		if (token === "title" || token === "body" || token === "comments" || token === "requirement" || token === "design") { selectors.push({ kind: token }); continue; }
		const panel = /^panel\(\s*"?([A-Z][0-9]*)"?\s*\)$/.exec(token);
		if (panel) { selectors.push({ kind: "panel", id: panel[1]! }); continue; }
		const range = /^(lines|comments)\(\s*([1-9][0-9]*)\s*\.\.\s*([1-9][0-9]*)\s*\)$/.exec(token);
		if (range) {
			const from = Number(range[2]);
			const to = Number(range[3]);
			if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return { ok: false, reason: tr(`Invalid range: ${token}`, `范围无效：${token}`) };
			selectors.push({ kind: range[1] === "lines" ? "lines" : "commentsRange", from, to });
			continue;
		}
		const last = /^comments\(\s*-([1-9][0-9]*)\s*\)$/.exec(token);
		if (last) {
			const count = Number(last[1]);
			if (!Number.isSafeInteger(count)) return { ok: false, reason: tr(`Invalid count: ${token}`, `数量无效：${token}`) };
			selectors.push({ kind: "commentsLast", count });
			continue;
		}
		const section = /^section\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(token);
		if (section) {
			try {
				const heading: unknown = JSON.parse(section[1]!);
				if (typeof heading === "string") { selectors.push({ kind: "section", heading }); continue; }
			} catch { /* Malformed quoted titles are expression errors. */ }
		}
		return { ok: false, reason: tr(`Unknown selector: ${token}`, `未知选择器：${token}`) };
	}
	// Without an alias the selection is the expression as written, so existing sources keep their text.
	const selection = alias === null ? expression : picks.length > 0 ? picks.join(", ") : null;
	return { ok: true, value: { alias, selectors, selection } };
}

function sectionText(text: string, heading: string): Selection {
	const lines = text.split("\n");
	const fences = fenceSpans(text);
	const headings: { line: number; end: number; level: number; title: string }[] = [];
	let offset = 0;
	let fenceIndex = 0;
	for (let index = 0; index < lines.length; index++) {
		while (fences[fenceIndex] && fences[fenceIndex]!.end <= offset) fenceIndex++;
		const fence = fences[fenceIndex];
		const line = lines[index]!;
		if (!(fence && offset >= fence.start)) {
			const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)\r?$/.exec(line);
			if (atx) headings.push({ line: index, end: index + 1, level: atx[1]!.length, title: (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim() });
			else if (line.trim() && index + 1 < lines.length) {
				const underline = /^ {0,3}(=+|-+)[ \t]*\r?$/.exec(lines[index + 1]!);
				if (underline) headings.push({ line: index, end: index + 2, level: underline[1]![0] === "=" ? 1 : 2, title: line.trim() });
			}
		}
		offset += line.length + 1;
	}
	const index = headings.findIndex(candidate => candidate.title === heading);
	if (index < 0) return { ok: false, reason: tr(`Section not found: ${heading}`, `未找到章节：${heading}`) };
	const selected = headings[index]!;
	const next = headings.slice(index + 1).find(candidate => candidate.level <= selected.level);
	return { ok: true, text: lines.slice(selected.end, next?.line ?? lines.length).join("\n") };
}

function selectText(text: string, selectors: readonly Selector[]): Selection {
	if (selectors.length === 0) return { ok: true, text };
	const selected: string[] = [];
	for (const selector of selectors) {
		switch (selector.kind) {
			case "lines": {
				const lines = text.split("\n");
				if (selector.to > lines.length) return { ok: false, reason: tr("Line range out of bounds", "行范围超出边界") };
				selected.push(lines.slice(selector.from - 1, selector.to).join("\n"));
				break;
			}
			case "section": {
				const section = sectionText(text, selector.heading);
				if (!section.ok) return section;
				selected.push(section.text);
				break;
			}
			case "title": case "body": case "comments": case "commentsLast": case "commentsRange": case "requirement": case "design": case "panel":
				return { ok: false, reason: tr(`Selector ${selector.kind} is invalid for text targets`, `选择器 ${selector.kind} 对文本目标无效`) };
		}
	}
	return { ok: true, text: selected.join("\n\n") };
}

function selectIssue(issue: IssueValue, selectors: readonly Selector[]): Selection {
	const selected: string[] = [];
	const comments = [...issue.comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	const format = (items: typeof comments): string => items.map(comment => `@${comment.author} ${comment.createdAt}:\n${comment.body}`).join("\n\n");
	const effective: readonly Selector[] = selectors.length === 0 ? [{ kind: "title" }, { kind: "body" }, { kind: "comments" }] : selectors;
	for (const selector of effective) {
		switch (selector.kind) {
			case "title": selected.push(issue.title); break;
			case "body": selected.push(issue.body); break;
			case "comments": selected.push(format(comments)); break;
			case "commentsLast":
				if (selector.count > comments.length) return { ok: false, reason: tr("Comment count out of bounds", "评论数量超出边界") };
				selected.push(format(comments.slice(-selector.count)));
				break;
			case "commentsRange":
				if (selector.to > comments.length) return { ok: false, reason: tr("Comment range out of bounds", "评论范围超出边界") };
				selected.push(format(comments.slice(selector.from - 1, selector.to)));
				break;
			case "lines": case "section": case "requirement": case "design": case "panel": return { ok: false, reason: tr(`Selector ${selector.kind} is invalid for issue targets`, `选择器 ${selector.kind} 对 issue 目标无效`) };
		}
	}
	return { ok: true, text: selected.join("\n\n") };
}

/**
 * References a block's content takes part in: a task body's, read with its slots as their values as
 * the compiler reads it (a slot's value may hold a reference); a design is an opaque leaf.
 */
function referencesOf(content: BlockContent | undefined, table: SlotTable): Reference[] {
	if (content?.kind !== "task") return [];
	const resolved = resolveSlots(content.body, table);
	return parseReferences(resolved.ok ? resolved.text : content.body);
}

/**
 * The blocks `roots` compile from. Expanded blocks are the roots and the blocks their task bodies
 * reference: their references and `{{bN.name}}` uses are followed. A block reached only by a
 * `{{bN.name}}` is a leaf: only its slot's value is read, so nothing of it is followed. Missing ids
 * are kept, so a block added later changes the closure.
 */
function reach(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): { readonly table: SlotTable; readonly expanded: Set<BlockId>; readonly leaves: Set<BlockId> } {
	const table = slotTable(contents);
	const expanded = new Set<BlockId>();
	const leaves = new Set<BlockId>();
	const pending = [...roots].reverse();
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (expanded.has(block)) continue;
		expanded.add(block);
		leaves.delete(block);
		const content = contents.get(block);
		if (content === undefined) continue;
		for (const { text } of slotTexts(content)) for (const use of qualifiedUses(text)) if (!expanded.has(use.block)) leaves.add(use.block);
		const children = referencesOf(content, table).map(reference => parseTarget(reference.targetText)).filter((target): target is Extract<Target, { kind: "block" }> => target?.kind === "block");
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!.block);
	}
	return { table, expanded, leaves };
}

function closure(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): Set<BlockId> {
	const { expanded, leaves } = reach(roots, contents);
	return new Set([...expanded, ...leaves]);
}

function externalTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): ExternalTarget[] {
	const targets = new Map<string, ExternalTarget>();
	const { table, expanded } = reach(roots, contents);
	for (const block of expanded) {
		for (const reference of referencesOf(contents.get(block), table)) {
			const target = parseTarget(reference.targetText);
			if (target && (target.kind === "file" || target.kind === "issue" || target.kind === "pull")) targets.set(targetKey(target), target);
		}
	}
	return [...targets.values()];
}

function resultTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): BlockId[] {
	const targets = new Set<BlockId>();
	const { table, expanded } = reach(roots, contents);
	for (const block of expanded) {
		for (const reference of referencesOf(contents.get(block), table)) {
			const target = parseTarget(reference.targetText);
			if (target?.kind === "result") targets.add(target.block);
		}
	}
	return [...targets];
}

/** A design's two texts with their slots already read as their values. */
type DesignText = { readonly requirement: string; readonly design: string };

/** A design block as prompt text: both parts by default, or what `selectors` pick (requirement, design, panels). */
function selectDesign(content: DesignText, selectors: readonly Selector[]): Selection {
	// An empty requirement is not a requirement: the agent gets no empty <requirement> element.
	if (selectors.length === 0) return { ok: true, text: [...(content.requirement.trim() ? [`<requirement>\n${content.requirement}\n</requirement>`] : []), `<design>\n${content.design}\n</design>`].join("\n\n") };
	const selected: string[] = [];
	for (const selector of selectors) {
		switch (selector.kind) {
			case "requirement": if (content.requirement.trim()) selected.push(content.requirement); break;
			case "design": selected.push(content.design); break;
			case "panel": {
				const panel = panelText(content.design, selector.id);
				if (!panel.ok) return panel;
				selected.push(panel.text);
				break;
			}
			case "lines": case "section": case "title": case "body": case "comments": case "commentsLast": case "commentsRange":
				return { ok: false, reason: tr(`Selector ${selector.kind} is invalid for design blocks`, `选择器 ${selector.kind} 对设计块无效`) };
		}
	}
	return { ok: true, text: selected.join("\n\n") };
}

function xmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function compiler(input: CompileInput) {
	const sources: Source[] = [];
	const table = slotTable(input.blocks);
	const badExpression = (at: ErrorSite, reason: string): CompileResult => ({ kind: "Err", error: { kind: "BadExpression", reason, at } });
	type Resolved<T> = ({ ok: true } & T) | { ok: false; error: CompileResult };
	/** `text` of `block` with its slots read as their values; a `{{bN.name}}` that reaches no slot fails here. */
	function resolve(block: BlockId, text: string): Resolved<{ text: string }> {
		const resolved = resolveSlots(text, table);
		return resolved.ok ? resolved : { ok: false, error: { kind: "Err", error: { kind: "UnknownSlot", block: resolved.block, slot: resolved.slot, at: { block, reference: resolved.use } } } };
	}
	function resolveDesign(block: BlockId, written: Extract<BlockContent, { kind: "design" }>): Resolved<{ content: DesignText }> {
		const requirement = resolve(block, written.requirement);
		if (!requirement.ok) return requirement;
		const design = resolve(block, written.design);
		return design.ok ? { ok: true, content: { requirement: requirement.text, design: design.text } } : design;
	}
	function expand(block: BlockId, reference: Reference, path: readonly BlockId[]): CompileResult {
		const at = { block, reference: reference.text };
		const target = parseTarget(reference.targetText);
		if (!target) return { kind: "Err", error: { kind: "UnknownTarget", at } };
		const expression = parseExpression(reference.expressionText);
		if (!expression.ok) return badExpression(at, expression.reason);
		const key = targetKey(target);
		switch (target.kind) {
			case "block": {
				if (path.includes(target.block)) return { kind: "Err", error: { kind: "Cycle", path: [...path, target.block], at } };
				if (path.length >= 8) return { kind: "Err", error: { kind: "TooDeep", at } };
				const content = input.blocks.get(target.block);
				if (content === undefined) return { kind: "Err", error: { kind: "UnknownBlock", block: target.block, at } };
				if (content.kind === "design") {
					const resolved = resolveDesign(target.block, content);
					if (!resolved.ok) return resolved.error;
					const selected = selectDesign(resolved.content, expression.value.selectors);
					if (!selected.ok) return badExpression(at, selected.reason);
					sources.push({ kind: "block", target: key, expression: expression.value.selection });
					return { kind: "Ok", text: selected.text, sources };
				}
				const resolved = resolve(target.block, content.body);
				if (!resolved.ok) return resolved.error;
				const selected = selectText(resolved.text, expression.value.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "block", target: key, expression: expression.value.selection });
				return compileText(target.block, selected.text, [...path, target.block]);
			}
			case "result": {
				const result = input.results.get(target.block);
				if (!result) return { kind: "Err", error: { kind: "NoResult", block: target.block, at } };
				const selected = selectText(result.text, expression.value.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "result", target: key, expression: expression.value.selection, seq: result.seq, origin: result.origin, launch: result.launch });
				return { kind: "Ok", text: selected.text, sources };
			}
			case "file": case "issue": case "pull": {
				const fetched = input.fetches.get(key);
				if (!fetched || !fetched.ok) return { kind: "Err", error: { kind: "FetchFailed", target: key, error: fetched?.error ?? tr("Target is absent from the fetch table", "目标不在 fetch 表中"), at } };
				if ((target.kind === "file") !== (fetched.value.kind === "file")) return { kind: "Err", error: { kind: "FetchFailed", target: key, error: tr("Fetched value does not match target kind", "获取的值与目标类型不匹配"), at } };
				const selected = fetched.value.kind === "file" ? selectText(fetched.value.text, expression.value.selectors) : selectIssue(fetched.value.issue, expression.value.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "external", target: key, expression: expression.value.selection, fetchedAt: fetched.at });
				return { kind: "Ok", text: `<external source="${xmlAttribute(key)}" fetched="${new Date(fetched.at).toISOString()}">\n${selected.text}\n</external>`, sources };
			}
		}
	}
	function compileText(block: BlockId, body: string, path: readonly BlockId[]): CompileResult {
		const parts: string[] = [];
		let offset = 0;
		for (const reference of parseReferences(body)) {
			parts.push(body.slice(offset, reference.offset));
			const expanded = expand(block, reference, path);
			if (expanded.kind === "Err") return expanded;
			parts.push(expanded.text);
			offset = reference.offset + reference.text.length;
		}
		parts.push(body.slice(offset));
		return { kind: "Ok", text: parts.join(""), sources };
	}
	return { sources, expand, compileText, resolve, resolveDesign };
}

function compile(order: readonly BlockId[], input: CompileInput): CompileResult {
	const context = compiler(input);
	const parts: string[] = [];
	for (const block of order) {
		const content = input.blocks.get(block);
		if (content === undefined) return { kind: "Err", error: { kind: "UnknownBlock", block, at: { block, reference: "" } } };
		if (content.kind === "design") {
			const resolved = context.resolveDesign(block, content);
			if (!resolved.ok) return resolved.error;
			const selected = selectDesign(resolved.content, []);
			if (!selected.ok) return { kind: "Err", error: { kind: "BadExpression", reason: selected.reason, at: { block, reference: "" } } };
			parts.push(selected.text);
			continue;
		}
		const resolved = context.resolve(block, content.body);
		if (!resolved.ok) return resolved.error;
		const compiled = context.compileText(block, resolved.text, [block]);
		if (compiled.kind === "Err") return compiled;
		parts.push(compiled.text);
	}
	return { kind: "Ok", text: parts.join("\n\n"), sources: context.sources };
}

function expandOne(block: BlockId, reference: Reference, input: CompileInput): CompileResult {
	return compiler(input).expand(block, reference, [block]);
}

// Hirschberg's LCS keeps diff memory linear instead of allocating an n*m matrix.
type DiffLine = { text: string; newline: boolean };
type DiffOperation = { kind: " " | "-" | "+"; line: DiffLine };
function diffLines(text: string): DiffLine[] {
	if (!text) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines.map((line, index) => ({ text: line, newline: index < lines.length - 1 || text.endsWith("\n") }));
}
function equalLine(a: DiffLine, b: DiffLine): boolean { return a.text === b.text && a.newline === b.newline; }
function lcsRow(a: readonly DiffLine[], b: readonly DiffLine[]): number[] {
	let previous = new Array<number>(b.length + 1).fill(0);
	let current = new Array<number>(b.length + 1).fill(0);
	for (const line of a) {
		current[0] = 0;
		for (let index = 0; index < b.length; index++) current[index + 1] = equalLine(line, b[index]!) ? previous[index]! + 1 : Math.max(previous[index + 1]!, current[index]!);
		[previous, current] = [current, previous];
	}
	return previous;
}
function diffOperations(a: readonly DiffLine[], b: readonly DiffLine[]): DiffOperation[] {
	if (a.length === 0) return b.map(line => ({ kind: "+", line }));
	if (b.length === 0) return a.map(line => ({ kind: "-", line }));
	if (a.length === 1) {
		const match = b.findIndex(line => equalLine(a[0]!, line));
		if (match < 0) return [{ kind: "-", line: a[0]! }, ...b.map((line): DiffOperation => ({ kind: "+", line }))];
		return [...b.slice(0, match).map((line): DiffOperation => ({ kind: "+", line })), { kind: " ", line: a[0]! }, ...b.slice(match + 1).map((line): DiffOperation => ({ kind: "+", line }))];
	}
	const middle = Math.floor(a.length / 2);
	const left = lcsRow(a.slice(0, middle), b);
	const right = lcsRow(a.slice(middle).toReversed(), b.toReversed());
	let split = 0;
	let best = -1;
	for (let index = 0; index <= b.length; index++) {
		const score = left[index]! + right[b.length - index]!;
		if (score > best) { best = score; split = index; }
	}
	return [...diffOperations(a.slice(0, middle), b.slice(0, split)), ...diffOperations(a.slice(middle), b.slice(split))];
}

function unifiedDiff(before: string, after: string): string {
	if (before === after) return "";
	const a = diffLines(before);
	const b = diffLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && equalLine(a[prefix]!, b[prefix]!)) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && equalLine(a[a.length - suffix - 1]!, b[b.length - suffix - 1]!)) suffix++;
	const operations: DiffOperation[] = [
		...a.slice(0, prefix).map((line): DiffOperation => ({ kind: " ", line })),
		...diffOperations(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
		...a.slice(a.length - suffix).map((line): DiffOperation => ({ kind: " ", line })),
	];
	const hunks: Span[] = [];
	for (let index = 0; index < operations.length; index++) {
		if (operations[index]!.kind === " ") continue;
		const start = Math.max(0, index - 3);
		const end = Math.min(operations.length, index + 4);
		const last = hunks[hunks.length - 1];
		if (last && start <= last.end) last.end = end;
		else hunks.push({ start, end });
	}
	const output = ["--- before", "+++ after"];
	let cursor = 0;
	let oldLine = 1;
	let newLine = 1;
	const range = (start: number, count: number): string => count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`;
	for (const hunk of hunks) {
		while (cursor < hunk.start) {
			if (operations[cursor]!.kind !== "+") oldLine++;
			if (operations[cursor]!.kind !== "-") newLine++;
			cursor++;
		}
		const content = operations.slice(hunk.start, hunk.end);
		const oldCount = content.filter(operation => operation.kind !== "+").length;
		const newCount = content.filter(operation => operation.kind !== "-").length;
		output.push(`@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@`);
		for (const operation of content) {
			output.push(`${operation.kind}${operation.line.text}`);
			if (!operation.line.newline) output.push("\\ No newline at end of file");
			if (operation.kind !== "+") oldLine++;
			if (operation.kind !== "-") newLine++;
			cursor++;
		}
	}
	return `${output.join("\n")}\n`;
}

export const references: ReferencesModule = { parseReferences, parseTarget, parseExpression, targetKey, closure, externalTargets, resultTargets, compile, expandOne, unifiedDiff, replacePanel };
