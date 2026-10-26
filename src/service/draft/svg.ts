import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";

/** Validated raw SVG; dimensions are positive user units, not CSS layout sizes. */
export interface SvgSpec {
	readonly source: string;
	readonly width: number;
	readonly height: number;
}

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Decode only XML's built-in references; declarations and custom entities are unsupported. */
function xmlText(value: string): string {
	return value.replace(/&(?:#(x[0-9a-f]+|\d+)|(amp|lt|gt|quot|apos));/gi, (reference: string, numeric: string | undefined, named: string | undefined) => {
		if (numeric !== undefined) {
			const code = numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
		}
		switch (named) {
			case "amp": return "&";
			case "lt": return "<";
			case "gt": return ">";
			case "quot": return '"';
			case "apos": return "'";
		}
		return reference;
	});
}

function cssText(value: string): string {
	return value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([\s\S]))/gi, (_escape: string, hex: string | undefined, newline: string | undefined, character: string | undefined) => {
		if (hex !== undefined) {
			const code = Number.parseInt(hex, 16);
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
		}
		return newline !== undefined ? "" : character!;
	});
}

function dimension(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const text = value.trim().replace(/px$/, "");
	if (!numberPattern.test(text)) return undefined;
	const number = Number(text);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function viewBoxSize(value: string | undefined): { readonly width: number; readonly height: number } | undefined {
	if (value === undefined) return undefined;
	const parts = value.trim().split(/[\s,]+/);
	if (parts.length !== 4 || parts.some(part => !numberPattern.test(part) || !Number.isFinite(Number(part)))) return undefined;
	const width = Number(parts[2]);
	const height = Number(parts[3]);
	return width > 0 && height > 0 ? { width, height } : undefined;
}

export function parseSvg(input: FenceInput): Parsed<SvgSpec> {
	const source = input.lines.join("\n");
	const diagnostics: DraftDiagnostic[] = [];
	const lineAt = (offset: number): number => {
		let line = input.line;
		for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
		return line;
	};
	const error = (offset: number, message: string): void => {
		diagnostics.push(diagnostic("svg", lineAt(offset), message));
	};
	const checkCss = (value: string, at: number, style: boolean): void => {
		if (style && value.includes("\\")) {
			error(at, tr("SVG <style> does not support backslash escapes; use static CSS without escapes.", "SVG 的 <style> 不支持反斜杠转义；请使用未转义的静态 CSS。"));
			return;
		}
		const css = cssText(value);
		if (/@import\b/i.test(css)) error(at, tr("SVG forbids CSS @import; put static styles directly in the SVG.", "SVG 禁止 CSS @import；请将静态样式直接写入 SVG。"));
		const urls = /\burl\s*\(/gi;
		let match: RegExpExecArray | null;
		while ((match = urls.exec(css)) !== null) {
			const end = css.indexOf(")", urls.lastIndex);
			let target = end < 0 ? "" : css.slice(urls.lastIndex, end).trim();
			if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) target = target.slice(1, -1);
			if (!/^#[^\s"'()\\]+$/.test(target)) error(at, tr("SVG CSS url() allows only #fragment; change it to url(#shape-id).", "SVG 的 CSS url() 仅允许 #fragment；请改为 url(#图形ID)。"));
			if (end < 0) break;
			urls.lastIndex = end + 1;
		}
	};
	const stack: string[] = [];
	const styles: { readonly depth: number; readonly offset: number; text: string }[] = [];
	const appendStyleText = (text: string): void => {
		for (const style of styles) style.text += text;
	};
	let root = false;
	let rootOffset = 0;
	let widthAttribute: string | undefined;
	let heightAttribute: string | undefined;
	let viewBoxAttribute: string | undefined;
	let offset = 0;

	// Inspect markup, not text inside comments/CDATA or quoted attributes. Never rewrite source.
	while (offset < source.length) {
		if (source[offset] !== "<") {
			const end = source.indexOf("<", offset);
			const next = end < 0 ? source.length : end;
			if (stack.length === 0 && source.slice(offset, next).trim()) {
				error(offset, tr("The SVG root element must be <svg>; put the content inside <svg>…</svg>.", "SVG 根元素必须是 <svg>；请将内容放入 <svg>…</svg>。"));
				break;
			}
			if (styles.length > 0) appendStyleText(xmlText(source.slice(offset, next)));
			offset = next;
			continue;
		}
		let terminator: string | undefined;
		if (source.startsWith("<!--", offset)) terminator = "-->";
		else if (source.startsWith("<![CDATA[", offset) && stack.length > 0) terminator = "]]>";
		else if (source.startsWith("<?", offset)) terminator = "?>";
		if (terminator !== undefined) {
			const end = source.indexOf(terminator, offset + 2);
			if (end < 0) {
				error(offset, tr(`The SVG marker is not closed; add ${terminator}.`, `SVG 标记未闭合；请补上 ${terminator}。`));
				break;
			}
			if (terminator === "]]>") appendStyleText(source.slice(offset + 9, end));
			offset = end + terminator.length;
			continue;
		}
		if (source.startsWith("<!", offset)) {
			error(offset, tr("SVG does not support declarations; remove DOCTYPE and other declarations, and use <svg>…</svg> directly.", "SVG 不支持声明；请移除 DOCTYPE 等声明，直接使用 <svg>…</svg>。"));
			break;
		}
		const opening = /^<(\/?)([A-Za-z_][\w:.-]*)/.exec(source.slice(offset));
		if (!opening) {
			error(offset, tr("The SVG tag is invalid; use <svg>…</svg>, and write < as &lt; in text.", "SVG 标签无效；请使用 <svg>…</svg>，文本中的 < 写作 &lt;。"));
			break;
		}
		const closing = opening[1] === "/";
		const name = opening[2]!;
		const localName = name.slice(name.lastIndexOf(":") + 1).toLowerCase();
		const isRoot = !root && !closing;
		if (isRoot) {
			root = true;
			rootOffset = offset;
			if (name !== "svg") error(offset, tr("The SVG root element must be <svg>; use <svg>…</svg>.", "SVG 根元素必须是 <svg>；请使用 <svg>…</svg>。"));
		} else if (!closing && stack.length === 0) {
			error(offset, tr("SVG may have only one root element; put all graphics inside the same <svg>.", "SVG 只能有一个根元素；请将全部图形放入同一个 <svg>。"));
		}
		if (!closing && (localName === "script" || localName === "foreignobject")) {
			error(offset, tr(`SVG forbids <${name}>; remove this element and use static SVG graphics instead.`, `SVG 禁止 <${name}>；请移除此元素，改用静态 SVG 图形。`));
		}
		let cursor = offset + opening[0].length;
		let selfClosing = false;
		let ended = false;
		const attributes = new Set<string>();
		while (cursor < source.length) {
			const beforeWhitespace = cursor;
			while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++;
			if (source[cursor] === ">" || (!closing && source.startsWith("/>", cursor))) {
				selfClosing = source[cursor] === "/";
				cursor += selfClosing ? 2 : 1;
				ended = true;
				break;
			}
			if (closing || cursor === beforeWhitespace) break;
			const attribute = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(source.slice(cursor));
			if (!attribute) break;
			const attributeName = attribute[1]!;
			const value = attribute[2] ?? attribute[3]!;
			if (attributes.has(attributeName)) error(cursor, tr(`SVG attribute ${attributeName} is repeated; each element may specify an attribute name only once.`, `SVG 属性 ${attributeName} 重复；每个元素只能指定一次同名属性。`));
			attributes.add(attributeName);
			const lowerName = attributeName.toLowerCase();
			const attributeLocalName = lowerName.slice(lowerName.lastIndexOf(":") + 1);
			if (attributeLocalName.startsWith("on")) {
				error(cursor, tr(`SVG forbids the ${attributeName} event handler; remove this attribute.`, `SVG 禁止 ${attributeName} 事件处理器；请移除此属性。`));
			}
			if (attributeLocalName === "href" && (!/^#[^\s]+$/.test(value) || !/^#[^\s]+$/.test(xmlText(value)))) {
				error(cursor, tr(`SVG ${attributeName} allows only #fragment; change it to href="#shape-id".`, `SVG 的 ${attributeName} 仅允许 #fragment；请改为 href="#图形ID"。`));
			}
			checkCss(xmlText(value), cursor, false);
			if (isRoot) {
				if (attributeName === "width") widthAttribute = value;
				else if (attributeName === "height") heightAttribute = value;
				else if (attributeName === "viewBox") viewBoxAttribute = value;
			}
			cursor += attribute[0].length;
		}
		if (!ended) {
			error(cursor, tr("The SVG tag or attribute is not closed; use name=\"value\" and add >.", "SVG 标签或属性未闭合；请使用 name=\"值\" 并补上 >。"));
			break;
		}
		if (closing) {
			if (stack.pop() !== name) error(offset, tr(`The SVG closing tag does not match; add the corresponding </${name}>.`, `SVG 结束标签不匹配；请补上对应的 </${name}>。`));
			const style = styles.at(-1);
			if (style !== undefined && style.depth > stack.length) {
				checkCss(style.text, style.offset, true);
				styles.pop();
			}
		} else if (!selfClosing) {
			stack.push(name);
			if (localName === "style") styles.push({ depth: stack.length, offset, text: "" });
		}
		offset = cursor;
	}
	if (!root && diagnostics.length === 0) error(0, tr("The SVG root element must be <svg>; use <svg>…</svg>.", "SVG 根元素必须是 <svg>；请使用 <svg>…</svg>。"));
	if (stack.length > 0 && diagnostics.length === 0) error(rootOffset, tr("The SVG tag is not closed; add the corresponding closing tag, such as </svg>.", "SVG 标签未闭合；请补上对应的结束标签，如 </svg>。"));
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const width = dimension(widthAttribute);
	const height = dimension(heightAttribute);
	let size = width !== undefined && height !== undefined ? { width, height } : viewBoxSize(viewBoxAttribute);
	if (size === undefined) {
		size = { width: 600, height: 300 };
		diagnostics.push(diagnostic("svg", lineAt(rootOffset), tr("SVG has no valid dimensions; drawing at 600×300. Add width=\"600\" height=\"300\" or viewBox=\"0 0 600 300\".", "SVG 未指定有效尺寸，按 600×300 绘制；请添加 width=\"600\" height=\"300\" 或 viewBox=\"0 0 600 300\"。"), "warning"));
	}
	return { ok: true, value: { source, ...size }, diagnostics };
}

export function renderSvg(spec: SvgSpec, ctx: RenderContext): Rendered {
	return { nodes: [ctx.svg(`${ctx.id}.image`, spec.source, { w: spec.width, h: spec.height }, tr("SVG graphic", "SVG 图形"))], diagnostics: [] };
}
