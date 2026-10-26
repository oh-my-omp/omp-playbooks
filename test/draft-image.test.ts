import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { FileRead, RenderContext } from "../src/service/draft/contract";
import { parseImage, renderImage, type ImageSpec } from "../src/service/draft/image";
import type { TspNode } from "../src/service/tsp-types";

const LINE = 27;
const LIMIT = 5 * 1024 * 1024;

function parse(source: string): ImageSpec {
	const result = parseImage(fence({ args: "", lines: [source], line: LINE }));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}

function fakeContext(file: FileRead = { ok: true, bytes: new Uint8Array([1, 2, 3]), path: "/playbook/example.png" }) {
	const reads: string[] = [];
	const images: { id: string; bytes: Uint8Array; mime: string; alt: string }[] = [];
	const ctx: RenderContext = { ...renderDefaults,
		id: "draft.panel.image",
		view: "changes",
		readFile(path) { reads.push(path); return file; },
		image(id, bytes, mime, alt) {
			images.push({ id, bytes, mime, alt });
			return { id, k: "image", p: { alt, mime } };
		},
		svg() { throw new Error("Image component must not create SVGs"); },
	};
	return { ctx, reads, images };
}

function visibleText(nodes: readonly TspNode[]): string[] {
	return nodes.flatMap(node => {
		if (node.k !== "text") return [];
		if (typeof node.p?.text === "string") return [node.p.text];
		const spans: unknown = node.p?.spans;
		if (!Array.isArray(spans)) return [];
		return spans.flatMap((span: unknown) => {
			if (typeof span !== "object" || span === null || !("t" in span) || typeof span.t !== "string") return [];
			return [span.t];
		});
	});
}

function expectIds(nodes: readonly TspNode[], prefix: string): void {
	const ids = nodes.map(node => node.id);
	expect(ids.every(id => id.startsWith(`${prefix}.`))).toBe(true);
	expect(new Set(ids).size).toBe(ids.length);
}

describe("image syntax", () => {
	for (const path of ["screenshots/login screen.png", "/absolute/path/to/screenshot.png", "../screenshots/example.JPG"]) {
		test(`preserves alt, source line and path ${path}`, () => {
			const result = parseImage(fence({ args: "", lines: [`![登录页面](${path})`], line: LINE }));
			expect(result).toEqual({ ok: true, value: { line: LINE, alt: "登录页面", path }, diagnostics: [] });
		});
	}
	for (const alt of ["", "   "]) {
		test(`empty caption ${JSON.stringify(alt)} is a warning`, () => {
			const result = parseImage(fence({ args: "", lines: [`![${alt}](example.png)`], line: LINE }));
			expect(result.ok).toBe(true);
			expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "warning", component: "image", line: LINE })]);
			expect(result.diagnostics[0]!.message).toContain("![图片内容](screenshots/example.png)");
		});
	}
	for (const source of ["", "![alt]()", "![alt](   )", "[alt](example.png)", "before ![alt](example.png)", "![alt](example.png) after", "![a](a.png) ![b](b.png)", "![alt\ntext](example.png)", "![alt](example\n.png)", "![alt](example.png)\n"]) {
		test(`rejects invalid single-line syntax ${JSON.stringify(source)}`, () => {
			const result = parseImage(fence({ args: "", lines: [source], line: LINE }));
			expect(result.ok).toBe(false);
			expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", component: "image", line: LINE })]);
			expect(result.diagnostics[0]!.message).toContain("![图片内容](screenshots/example.png)");
		});
	}
	test("rejects missing line and reports second line for extra content", () => {
		const missing = parseImage(fence({ args: "", lines: [], line: LINE }));
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics[0]).toMatchObject({ line: LINE, severity: "error" });
		const extra = parseImage(fence({ args: "", lines: ["![alt](example.png)", "extra"], line: LINE }));
		expect(extra.ok).toBe(false);
		expect(extra.diagnostics[0]).toMatchObject({ line: LINE + 1, severity: "error" });
	});
});

describe("local image rendering", () => {
	const formats = [
		["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
		["gif", "image/gif"], ["webp", "image/webp"], ["avif", "image/avif"],
		["svg", "image/svg+xml"], ["PnG", "image/png"], ["JPEG", "image/jpeg"],
	] as const;
	for (const [extension, mime] of formats) {
		test(`embeds ${extension} bytes and draws caption below`, () => {
			const bytes = new Uint8Array([3, 1, 4]);
			const path = `screenshots/example image.${extension}`;
			const fake = fakeContext({ ok: true, bytes, path: "/resolved/not-used-for-mime.txt" });
			const result = renderImage(parse(`![页面截图](${path})`), fake.ctx);
			expect(result.diagnostics).toEqual([]);
			expect(fake.reads).toEqual([path]);
			expect(fake.images).toHaveLength(1);
			expect(fake.images[0]!.bytes).toBe(bytes);
			expect(fake.images[0]).toMatchObject({ mime, alt: "页面截图", id: `${fake.ctx.id}.image` });
			expect(result.nodes.map(node => node.k)).toEqual(["image", "text"]);
			expect(result.nodes[1]!.p).toEqual({ spans: [{ t: "页面截图", s: "muted" }] });
			expectIds(result.nodes, fake.ctx.id);
		});
	}
	test("absolute path is passed unchanged to context", () => {
		const fake = fakeContext();
		renderImage(parse("![Absolute](/absolute/path/image.png)"), fake.ctx);
		expect(fake.reads).toEqual(["/absolute/path/image.png"]);
	});
	test("accepts exactly 5 MiB", () => {
		const bytes = new Uint8Array(LIMIT);
		const fake = fakeContext({ ok: true, bytes, path: "/image.png" });
		const result = renderImage(parse("![Boundary](image.png)"), fake.ctx);
		expect(result.diagnostics).toEqual([]);
		expect(fake.images[0]!.bytes).toBe(bytes);
	});
	test("empty alt remains empty in image and caption", () => {
		const fake = fakeContext();
		const result = renderImage(parse("![](image.png)"), fake.ctx);
		expect(fake.images[0]!.alt).toBe("");
		expect(result.nodes[1]!.p).toEqual({ spans: [{ t: "", s: "muted" }] });
	});
	for (const failure of ["missing", "oversized", "unknown"] as const) {
		test(`${failure} returns a render-time error and alt placeholder`, () => {
			const file: FileRead = failure === "missing"
				? { ok: false, error: "ENOENT" }
				: { ok: true, bytes: new Uint8Array(failure === "oversized" ? LIMIT + 1 : 3), path: "/image.png" };
			const fake = fakeContext(file);
			const path = failure === "unknown" ? "image.bmp" : "image.png";
			const parsed = parseImage(fence({ args: "", lines: [`![图片占位](${path})`], line: LINE }));
			expect(parsed.diagnostics).toEqual([]);
			if (!parsed.ok) throw new Error("Expected syntactically valid image");
			const result = renderImage(parsed.value, fake.ctx);
			expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", line: LINE, component: "image" })]);
			expect(visibleText(result.nodes)).toContain("图片占位");
			expect(result.diagnostics[0]!.message).toContain("![图片内容](screenshots/example.png)");
			expect(fake.images).toEqual([]);
			expect(fake.reads).toEqual(failure === "unknown" ? [] : [path]);
			expectIds(result.nodes, fake.ctx.id);
		});
	}
	for (const alt of ["", "   "]) {
		test(`missing image with empty alt ${JSON.stringify(alt)} still has visible placeholder`, () => {
			const fake = fakeContext({ ok: false, error: "ENOENT" });
			const result = renderImage(parse(`![${alt}](image.png)`), fake.ctx);
			expect(visibleText(result.nodes)).toEqual(["图片（未填写说明）"]);
		});
	}
});

describe("remote and embedded URL images", () => {
	for (const path of ["http://example.org/image.png", "https://example.org/image.png?x=1", "HTTPS://example.org/image.png", "data:image/png;base64,aGVsbG8=", "DATA:image/svg+xml,<svg/>" ]) {
		test(`shows alt and literal source without reading ${path}`, () => {
			const fake = fakeContext();
			const result = renderImage(parse(`![网络图片](${path})`), fake.ctx);
			expect(fake.reads).toEqual([]);
			expect(fake.images).toEqual([]);
			expect(result.nodes.every(node => node.k === "text")).toBe(true);
			expect(visibleText(result.nodes)).toEqual(["网络图片", path]);
			expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "warning", component: "image", line: LINE })]);
			expectIds(result.nodes, fake.ctx.id);
		});
	}
});
