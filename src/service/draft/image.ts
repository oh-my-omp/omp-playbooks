import { extname } from "node:path";
import { diagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";

export interface ImageSpec {
	readonly line: number;
	readonly alt: string;
	readonly path: string;
}

/** Largest image a card draws; a pasted image above it is refused rather than saved undrawable. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** File extension a pasted image is saved under, by MIME type; each is one `imageMime` draws. */
export const IMAGE_EXTENSIONS: Readonly<Partial<Record<string, string>>> = {
	"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg",
};
const EXAMPLE = "![图片内容](screenshots/example.png)";

export function parseImage(input: FenceInput): Parsed<ImageSpec> {
	if (input.lines.length !== 1) {
		return { ok: false, diagnostics: [diagnostic("image", input.line + (input.lines.length > 1 ? 1 : 0), `图片必须独占一行；请写 ${EXAMPLE}`)] };
	}
	const match = /^!\[([^\]\r\n]*)\]\(([^()\r\n]+)\)$/.exec(input.lines[0]!);
	if (!match || match[0] !== input.lines[0] || !match[2]!.trim()) {
		return { ok: false, diagnostics: [diagnostic("image", input.line, `图片格式或路径无效；请写 ${EXAMPLE}`)] };
	}
	const alt = match[1]!;
	return {
		ok: true,
		value: { line: input.line, alt, path: match[2]! },
		diagnostics: alt.trim() ? [] : [diagnostic("image", input.line, `图片说明为空；请填写说明，如 ${EXAMPLE}`, "warning")],
	};
}

/** The MIME type a card draws a file of this name as; null when it draws no such file. */
export function imageMime(path: string): string | null {
	switch (extname(path).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".avif": return "image/avif";
		case ".svg": return "image/svg+xml";
		default: return null;
	}
}

export function renderImage(spec: ImageSpec, ctx: RenderContext): Rendered {
	if (/^(?:https?:\/\/|data:)/i.test(spec.path)) {
		return {
			nodes: [
				{ id: `${ctx.id}.alt`, k: "text", p: { text: spec.alt.trim() ? spec.alt : "图片（未填写说明）" } },
				{ id: `${ctx.id}.url`, k: "text", p: { spans: [{ t: spec.path, s: "muted" }] } },
			],
			diagnostics: [diagnostic("image", spec.line, `不加载网络或 data: 图片；请改用本地文件，如 ${EXAMPLE}`, "warning")],
		};
	}
	const mime = imageMime(spec.path);
	const fail = (message: string): Rendered => ({
		nodes: [{ id: `${ctx.id}.placeholder`, k: "text", p: { text: spec.alt.trim() ? spec.alt : "图片（未填写说明）" } }],
		diagnostics: [diagnostic("image", spec.line, message)],
	});
	if (!mime) return fail(`图片格式不支持；请使用 PNG、JPG、GIF、WebP、AVIF 或 SVG，如 ${EXAMPLE}`);
	const file = ctx.readFile(spec.path);
	if (!file.ok) return fail(`无法读取图片“${spec.path}”；请确认文件存在且路径可访问，如 ${EXAMPLE}`);
	if (file.bytes.byteLength > MAX_IMAGE_BYTES) return fail(`图片超过 5 MB；请压缩或裁剪到 5 MB 以内，如 ${EXAMPLE}`);
	return {
		nodes: [
			ctx.image(`${ctx.id}.image`, file.bytes, mime, spec.alt),
			{ id: `${ctx.id}.caption`, k: "text", p: { spans: [{ t: spec.alt, s: "muted" }] } },
		],
		diagnostics: [],
	};
}
