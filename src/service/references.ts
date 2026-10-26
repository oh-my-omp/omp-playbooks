import { parseBlockId } from "../domain/model";
import type { BlockContent, BlockId, CompileInput, CompileResult, ErrorSite, ExternalTarget, IssueValue, Reference, Selector, Source, Target } from "../domain/model";
import { panelText, replacePanel } from "./draft/document";
import { resolveSlots } from "./draft/slot";
import type { ReferencesModule } from "../domain/ports";

type Span = { start: number; end: number };
type Selection = { ok: true; text: string } | { ok: false; reason: string };
type ParsedExpression = { ok: true; selectors: readonly Selector[] } | { ok: false; reason: string };

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
	if (expression === null) return { ok: true, selectors: [] };
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
	if (quoted) return { ok: false, reason: "Unclosed section title" };
	tokens.push(expression.slice(start).trim());
	const selectors: Selector[] = [];
	for (const token of tokens) {
		if (token === "title" || token === "body" || token === "comments" || token === "requirement" || token === "design") { selectors.push({ kind: token }); continue; }
		const panel = /^panel\(\s*"?([A-Z][0-9]*)"?\s*\)$/.exec(token);
		if (panel) { selectors.push({ kind: "panel", id: panel[1]! }); continue; }
		const range = /^(lines|comments)\(\s*([1-9][0-9]*)\s*\.\.\s*([1-9][0-9]*)\s*\)$/.exec(token);
		if (range) {
			const from = Number(range[2]);
			const to = Number(range[3]);
			if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return { ok: false, reason: `Invalid range: ${token}` };
			selectors.push({ kind: range[1] === "lines" ? "lines" : "commentsRange", from, to });
			continue;
		}
		const last = /^comments\(\s*-([1-9][0-9]*)\s*\)$/.exec(token);
		if (last) {
			const count = Number(last[1]);
			if (!Number.isSafeInteger(count)) return { ok: false, reason: `Invalid count: ${token}` };
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
		return { ok: false, reason: `Unknown selector: ${token}` };
	}
	return { ok: true, selectors };
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
	if (index < 0) return { ok: false, reason: `Section not found: ${heading}` };
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
				if (selector.to > lines.length) return { ok: false, reason: "Line range out of bounds" };
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
				return { ok: false, reason: `Selector ${selector.kind} is invalid for text targets` };
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
				if (selector.count > comments.length) return { ok: false, reason: "Comment count out of bounds" };
				selected.push(format(comments.slice(-selector.count)));
				break;
			case "commentsRange":
				if (selector.to > comments.length) return { ok: false, reason: "Comment range out of bounds" };
				selected.push(format(comments.slice(selector.from - 1, selector.to)));
				break;
			case "lines": case "section": case "requirement": case "design": case "panel": return { ok: false, reason: `Selector ${selector.kind} is invalid for issue targets` };
		}
	}
	return { ok: true, text: selected.join("\n\n") };
}

/** References a block's content takes part in: a task body's; a design is an opaque leaf. */
function referencesOf(content: BlockContent | undefined): Reference[] {
	return content?.kind === "task" ? parseReferences(content.body) : [];
}

function closure(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): Set<BlockId> {
	const reached = new Set<BlockId>();
	const pending = [...roots].reverse();
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (reached.has(block)) continue;
		reached.add(block);
		const children = referencesOf(contents.get(block)).map(reference => parseTarget(reference.targetText)).filter((target): target is Extract<Target, { kind: "block" }> => target?.kind === "block");
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!.block);
	}
	return reached;
}

function externalTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): ExternalTarget[] {
	const targets = new Map<string, ExternalTarget>();
	for (const block of closure(roots, contents)) {
		for (const reference of referencesOf(contents.get(block))) {
			const target = parseTarget(reference.targetText);
			if (target && (target.kind === "file" || target.kind === "issue" || target.kind === "pull")) targets.set(targetKey(target), target);
		}
	}
	return [...targets.values()];
}

function resultTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): BlockId[] {
	const targets = new Set<BlockId>();
	for (const block of closure(roots, contents)) {
		for (const reference of referencesOf(contents.get(block))) {
			const target = parseTarget(reference.targetText);
			if (target?.kind === "result") targets.add(target.block);
		}
	}
	return [...targets];
}

/** A design block as prompt text: both parts by default, or what `selectors` pick (requirement, design, panels). Slots read as their values. */
function selectDesign(written: Extract<BlockContent, { kind: "design" }>, selectors: readonly Selector[]): Selection {
	const content = { requirement: resolveSlots(written.requirement), design: resolveSlots(written.design) };
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
				return { ok: false, reason: `Selector ${selector.kind} is invalid for design blocks` };
		}
	}
	return { ok: true, text: selected.join("\n\n") };
}

function xmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function compiler(input: CompileInput) {
	const sources: Source[] = [];
	const badExpression = (at: ErrorSite, reason: string): CompileResult => ({ kind: "Err", error: { kind: "BadExpression", reason, at } });
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
					const selected = selectDesign(content, expression.selectors);
					if (!selected.ok) return badExpression(at, selected.reason);
					sources.push({ kind: "block", target: key, expression: reference.expressionText });
					return { kind: "Ok", text: selected.text, sources };
				}
				const selected = selectText(resolveSlots(content.body), expression.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "block", target: key, expression: reference.expressionText });
				return compileText(target.block, selected.text, [...path, target.block]);
			}
			case "result": {
				const result = input.results.get(target.block);
				if (!result) return { kind: "Err", error: { kind: "NoResult", block: target.block, at } };
				const selected = selectText(result.text, expression.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "result", target: key, expression: reference.expressionText, seq: result.seq, origin: result.origin, launch: result.launch });
				return { kind: "Ok", text: selected.text, sources };
			}
			case "file": case "issue": case "pull": {
				const fetched = input.fetches.get(key);
				if (!fetched || !fetched.ok) return { kind: "Err", error: { kind: "FetchFailed", target: key, error: fetched?.error ?? "Target is absent from the fetch table", at } };
				if ((target.kind === "file") !== (fetched.value.kind === "file")) return { kind: "Err", error: { kind: "FetchFailed", target: key, error: "Fetched value does not match target kind", at } };
				const selected = fetched.value.kind === "file" ? selectText(fetched.value.text, expression.selectors) : selectIssue(fetched.value.issue, expression.selectors);
				if (!selected.ok) return badExpression(at, selected.reason);
				sources.push({ kind: "external", target: key, expression: reference.expressionText, fetchedAt: fetched.at });
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
	return { sources, expand, compileText };
}

function compile(order: readonly BlockId[], input: CompileInput): CompileResult {
	const context = compiler(input);
	const parts: string[] = [];
	for (const block of order) {
		const content = input.blocks.get(block);
		if (content === undefined) return { kind: "Err", error: { kind: "UnknownBlock", block, at: { block, reference: "" } } };
		if (content.kind === "design") {
			const selected = selectDesign(content, []);
			if (!selected.ok) return { kind: "Err", error: { kind: "BadExpression", reason: selected.reason, at: { block, reference: "" } } };
			parts.push(selected.text);
			continue;
		}
		const compiled = context.compileText(block, resolveSlots(content.body), [block]);
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

export const references: ReferencesModule = { parseReferences, parseTarget, targetKey, closure, externalTargets, resultTargets, compile, expandOne, unifiedDiff, replacePanel };
