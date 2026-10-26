import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { parseCode, renderCode, type CodeSpec } from "../src/service/draft/code";
import type { FileRead, RenderContext } from "../src/service/draft/contract";

function parsed(args: string, lines: readonly string[] = [], line = 12): CodeSpec {
	const result = parseCode(fence({ args, lines, line }));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}

function context(result: FileRead = { ok: true, bytes: new TextEncoder().encode("one\ntwo\nthree\n"), path: "/playbook/example.ts" }): { ctx: RenderContext; reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		ctx: { ...renderDefaults,
			id: "draft.code-1", view: "changes",
			svg() { throw new Error("code must use a native TSP node"); },
			image() { throw new Error("code must use a native TSP node"); },
			readFile(path) { reads.push(path); return result; },
		},
	};
}

function file(text: string, path = "/playbook/example.ts"): FileRead {
	return { ok: true, bytes: new TextEncoder().encode(text), path };
}

function rejects(args: string, lines: readonly string[] = [], message?: string): void {
	const result = parseCode(fence({ args, lines, line: 12 }));
	expect(result.ok).toBe(false);
	expect(result.diagnostics.some(item => item.severity === "error")).toBe(true);
	expect(result.diagnostics[0]?.line).toBe(11);
	if (message) expect(result.diagnostics[0]?.message).toContain(message);
}

function secretRefused(args: string, result: FileRead, typed: readonly string[] = []): void {
	const { ctx } = context(result);
	const rendered = renderCode(parsed(args, typed), ctx);
	expect(rendered.nodes).toEqual([]);
	expect(rendered.diagnostics).toHaveLength(1);
	expect(rendered.diagnostics[0]).toMatchObject({ component: "code", severity: "error" });
}

describe("draft code syntax and native rendering", () => {
	test("typed sketch supports quoted title, preserved code, start and shown-number highlights", () => {
		const spec = parsed('ts title="limits.ts · sketch" start=38 hl="38-39,40"', ["export const LIMIT = 50", "", "use(LIMIT)"]);
		expect(spec).toMatchObject({ language: "ts", title: "limits.ts · sketch", source: { kind: "inline", start: 38, numbered: true } });
		expect(spec.highlights).toEqual([{ from: 38, to: 39 }, { from: 40, to: 40 }]);
		const { ctx, reads } = context();
		const rendered = renderCode(spec, ctx);
		expect(reads).toEqual([]);
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.nodes).toEqual([{
			id: "draft.code-1.code", k: "code", p: {
				text: "export const LIMIT = 50\n\nuse(LIMIT)", lang: "ts", path: "limits.ts · sketch", start: 38, numbers: true,
				marks: [{ line: 38, tone: "warning" }, { line: 39, tone: "warning" }, { line: 40, tone: "warning" }],
			},
		}]);
	});

	test("optional language, single quotes, escaped quotes and empty typed blocks are accepted", () => {
		const { ctx } = context();
		expect(renderCode(parsed("title='A sketch'", ["hello"]), ctx).nodes[0]?.p).toMatchObject({ lang: "", path: "A sketch", numbers: false, start: 1 });
		expect(parsed('ts title="sketch \\"A\\""', ["hello"]).title).toBe('sketch "A"');
		expect(renderCode(parsed("", []), ctx).nodes[0]?.p).toMatchObject({ text: "", lang: "", numbers: false });
		expect(parsed('"" title=sketch', ["hello"]).language).toBe("");
	});

	test("reads source only when rendering, slices inclusively, normalizes file newlines and infers extension", () => {
		const result = parseCode(fence({ args: 'src="source file.TS" lines=2-3 hl=2', lines: [], line: 12 }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("parse rejected valid source");
		const { ctx, reads } = context(file("one\r\ntwo\rthree\n"));
		expect(reads).toEqual([]);
		const rendered = renderCode(result.value, ctx);
		expect(reads).toEqual(["source file.TS"]);
		expect(rendered.nodes[0]?.p).toEqual({ text: "two\nthree", lang: "ts", path: "source file.TS:2-3", start: 2, numbers: true, marks: [{ line: 2, tone: "warning" }] });
		expect(rendered.diagnostics).toEqual([]);
	});

	test("single selected line shows path:line, title wins, source numbering ignores typed start", () => {
		const { ctx } = context();
		expect(renderCode(parsed("js src=example.ts lines=2 start=38"), ctx).nodes[0]?.p).toMatchObject({ text: "two", path: "example.ts:2", lang: "js", start: 2, numbers: true });
		expect(renderCode(parsed('src=example.ts title="real source"'), ctx).nodes[0]?.p).toMatchObject({ path: "real source", text: "one\ntwo\nthree", start: 1 });
	});

	test("nonempty src block warns at the first nonblank design line and renders only the actual file", () => {
		const result = parseCode(fence({ args: "ts src=example.ts", lines: [" ", "not the source"], line: 12 }));
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ severity: "warning", component: "code", line: 13 });
		if (!result.ok) throw new Error("src plus body is a warning, not an error");
		const { ctx, reads } = context();
		expect(renderCode(result.value, ctx).nodes[0]?.p?.text).toBe("one\ntwo\nthree");
		expect(reads).toEqual(["example.ts"]);
		expect(parseCode(fence({ args: "src=example.ts", lines: ["", "  "], line: 12 })).diagnostics).toEqual([]);
	});

	test("unknown, malformed and duplicate settings report the fence line", () => {
		for (const args of ["ts unknown=yes", "ts start", "ts src=", "ts src=a src=b", 'ts title="open', "ts src=a lines=0", "ts src=a lines=3-2", "ts src=a lines=1..2", "ts lines=2", "ts start=0", "ts start=2-3", "ts start=-2", "ts start=9007199254740992", "ts hl=0", "ts hl=2-1", "ts hl=", "ts hl=1,,2"]) rejects(args);
		rejects("ts lines=18", [], "start=38");
	});

	test("highlight positions must be within shown line numbers without huge-range expansion", () => {
		rejects("ts start=38 hl=1", ["one"]);
		rejects("ts hl=1-9007199254740991", ["one"]);
		rejects("ts start=9007199254740991", ["one", "two"]);
		const { ctx } = context();
		const rendered = renderCode(parsed("src=example.ts lines=2 hl=1"), ctx);
		expect(rendered.nodes).toEqual([]);
		expect(rendered.diagnostics[0]).toMatchObject({ line: 11, severity: "error" });
		expect(renderCode(parsed("ts hl=1,1", ["one"]), ctx).nodes[0]?.p?.marks).toEqual([{ line: 1, tone: "warning" }]);
	});

	test("typed length limits warn above 40 and reject above 200 at the first body line", () => {
		for (const count of [0, 40, 41, 200, 201]) {
			const result = parseCode(fence({ args: "ts", lines: Array.from({ length: count }, () => "line"), line: 12 }));
			expect(result.ok).toBe(count <= 200);
			expect(result.diagnostics).toHaveLength(count > 40 ? 1 : 0);
			if (count > 40) expect(result.diagnostics[0]).toMatchObject({ line: 12, severity: count > 200 ? "error" : "warning" });
		}
	});

	test("file length limits apply to the selected slice, not whole file, and use the fence line", () => {
		for (const count of [40, 41, 200, 201]) {
			const { ctx } = context(file(Array.from({ length: count }, () => "line").join("\n") + "\n"));
			const rendered = renderCode(parsed("src=example.ts"), ctx);
			expect(rendered.nodes).toHaveLength(count > 200 ? 0 : 1);
			expect(rendered.diagnostics).toHaveLength(count > 40 ? 1 : 0);
			if (count > 40) expect(rendered.diagnostics[0]).toMatchObject({ line: 11, severity: count > 200 ? "error" : "warning" });
			expect(renderCode(parsed("src=example.ts lines=1-2"), ctx).diagnostics).toEqual([]);
		}
	});

	test("missing or out-of-directory source, out-of-bounds ranges, binary and oversized files never produce code", () => {
		for (const result of [{ ok: false, error: "ENOENT" } satisfies FileRead, { ok: false, error: "outside directory" } satisfies FileRead, file("one\0two"), { ok: true, path: "/playbook/large.ts", bytes: new Uint8Array(2 * 1024 * 1024 + 1).fill(65) } satisfies FileRead]) {
			const { ctx } = context(result);
			const rendered = renderCode(parsed("src=example.ts"), ctx);
			expect(rendered.nodes).toEqual([]);
			expect(rendered.diagnostics[0]).toMatchObject({ line: 11, severity: "error" });
		}
		const { ctx } = context();
		for (const range of ["1-4", "4"]) {
			const rendered = renderCode(parsed(`src=example.ts lines=${range}`), ctx);
			expect(rendered.nodes).toEqual([]);
			expect(rendered.diagnostics[0]?.message).toContain("只有 3 行");
		}
	});

	test("every rendered id is unique and uses the context prefix", () => {
		const { ctx } = context();
		for (const spec of [parsed("ts", ["one"]), parsed("src=example.ts")]) {
			const nodes = renderCode(spec, ctx).nodes;
			expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length);
			expect(nodes.every(node => node.id.startsWith(`${ctx.id}.`))).toBe(true);
		}
	});
});

describe("draft code credential protection", () => {
	test("conventional secret names and folders are rejected before file I/O", () => {
		for (const path of [".env", ".env.production", "KEY.PEM", "private.key", "id_rsa", "id_ed25519.pub", ".netrc", ".npmrc", ".yarnrc.yml", ".pypirc", ".pgpass", ".my.cnf", ".git-credentials", ".htpasswd", "credentials.json", "secrets.yaml", "bash_history", "settings.local.json", "keys.p12", "keys.pfx", "keys.keystore", "keys.jks", "vars.tfvars", "x.tfstate.backup", "x.sqlite3", "x.db", "x.kdbx", "x.ovpn", ".ssh/config", ".git/config", ".aws/config", ".azure/config", ".gnupg/x", ".kube/config", ".docker/config.json", ".password-store/x", "dir\\.ssh\\config"]) {
			const { ctx, reads } = context();
			const rendered = renderCode(parsed(`src=${path}`), ctx);
			expect(rendered.nodes).toEqual([]);
			expect(rendered.diagnostics[0]).toMatchObject({ line: 11, severity: "error" });
			expect(reads).toEqual([]);
		}
	});

	test("template env files and ordinary source files remain allowed", () => {
		for (const path of [".env.example", ".env.sample", ".env.template", "secrets-reader.ts", "notsecret.ts", "constructor", "toString"]) {
			const { ctx } = context(file("export const LIMIT = 50", `/playbook/${path}`));
			expect(renderCode(parsed(`src=${path}`), ctx).nodes).toHaveLength(1);
		}
	});

	test("resolved file path is checked to stop innocuous aliases into credential files", () => {
		secretRefused("src=alias.ts", file("safe-looking text", "/playbook/.ssh/config"));
		secretRefused("src=alias.ts", file("safe-looking text", "/playbook/secret.key"));
	});

	test("whole file is scanned before slicing and diagnostic never repeats the token", () => {
		const token = "ghp_" + "A".repeat(36);
		const { ctx } = context(file(`safe\n${token}\n`));
		const rendered = renderCode(parsed("src=example.ts lines=1"), ctx);
		expect(rendered.nodes).toEqual([]);
		expect(rendered.diagnostics[0]).toMatchObject({ line: 11, severity: "error" });
		expect(JSON.stringify(rendered)).not.toContain(token);
	});

	test.each([
		"sk-proj-" + "A".repeat(48),
		"sk-" + "Ab_9-".repeat(4),
		"sk-" + "A".repeat(20),
	])("refuses separator-bearing and minimum-length sk keys %j", token => {
		const { ctx } = context(file(`safe\n${token}\n`));
		const sourced = renderCode(parsed("src=example.ts lines=1"), ctx);
		expect(sourced.nodes).toEqual([]);
		expect(sourced.diagnostics).toContainEqual(expect.objectContaining({ component: "code", severity: "error", line: 11, message: expect.stringContaining("密钥或令牌") }));
		expect(JSON.stringify(sourced)).not.toContain(token);
		const typed = renderCode(parsed("ts", ["safe", token]), ctx);
		expect(typed.nodes).toEqual([]);
		expect(typed.diagnostics).toContainEqual(expect.objectContaining({ component: "code", severity: "error", line: 13, message: expect.stringContaining("密钥或令牌") }));
		expect(JSON.stringify(typed)).not.toContain(token);
	});

	test.each(["password", "passwd", "secret", "token", "API_KEY", "api-key", "apikey", "ACCESS_KEY", "access-key", "accesskey"])("refuses unquoted %s assignments for both separators at the eight-character boundary", key => {
		for (const separator of [": ", "="]) {
			const canary = `${key}${separator}aB_9-xY7`;
			const { ctx } = context(file(`safe\n${canary}\n`));
			const sourced = renderCode(parsed("src=example.ts lines=1"), ctx);
			expect(sourced.nodes).toEqual([]);
			expect(sourced.diagnostics).toContainEqual(expect.objectContaining({ component: "code", severity: "error", line: 11, message: expect.stringContaining("密钥或令牌") }));
			expect(JSON.stringify(sourced)).not.toContain("aB_9-xY7");
			const typed = renderCode(parsed("ts", ["safe", canary]), ctx);
			expect(typed.nodes).toEqual([]);
			expect(typed.diagnostics).toContainEqual(expect.objectContaining({ component: "code", severity: "error", line: 13, message: expect.stringContaining("密钥或令牌") }));
			expect(JSON.stringify(typed)).not.toContain("aB_9-xY7");
		}
	});

	test("short values, unrelated identifiers and quoted placeholders remain allowed", () => {
		for (const text of ["sk-" + "A".repeat(19), "password: abcdefg", "API_KEY=abcdefg", "mytoken=abcdefgh", 'password = "$PASSWORD_FROM_ENV"', 'api_key = "<injected-secret>"', 'token = "${ACCESS_TOKEN}"']) {
			const { ctx } = context(file(text));
			expect(renderCode(parsed("src=example.ts"), ctx).nodes).toHaveLength(1);
			expect(renderCode(parsed("ts", [text]), ctx).nodes).toHaveLength(1);
		}
	});

	test("private keys, supported token formats and literal credentials are refused at render time", () => {
		for (const text of ["-----BEGIN RSA PRIVATE KEY-----", "sk-ant-example", "sk-" + "A".repeat(32), "AKIA" + "A".repeat(16), "ghp_" + "a".repeat(30), "github_pat_" + "a".repeat(30), "xoxb-" + "a".repeat(10), "AIza" + "a".repeat(30), "eyJ" + "a".repeat(20) + "." + "b".repeat(10) + ".", 'password = "longliteralpassword"', 'api_key: "longliteralcredential"']) {
			secretRefused("src=example.ts", file(text));
			secretRefused("ts", file("ignored"), [text]);
		}
		const { ctx } = context();
		const rendered = renderCode(parsed("ts", ["safe", 'access_token = "longliteralcredential"']), ctx);
		expect(rendered.diagnostics[0]).toMatchObject({ line: 13, severity: "error" });
		expect(renderCode(parsed("ts", ['password = "$PASSWORD_FROM_ENV"', 'api_key = "<injected-secret>"']), ctx).nodes).toHaveLength(1);
	});
});
