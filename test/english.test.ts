import { describe, expect, test } from "bun:test";
import { LANGUAGE } from "../src/i18n";
import { availableAgents } from "../src/extension/agents";
import { initPrompt } from "../src/service/coordinators";
import { launchFooter } from "../src/service/footer";
import { draftDiagnostics } from "../src/service/draft/components";
import { outlineProblems } from "../src/service/draft/outline";
import type { TspNode } from "../src/service/tsp-types";
import { design, registerCoreCleanup, task, template } from "./core-fixture";
import { fixture, settle } from "./ui-fixture";

// The suite runs in Chinese (test/language-preload.ts); this file's checks run in an English
// process of their own, started by the last test below.
const HAN = /\p{Script=Han}/u;
function texts(nodes: readonly TspNode[]): string[] {
	return nodes.flatMap(node => {
		const p = node.p ?? {};
		const spans = Array.isArray(p.spans) ? p.spans.map((span: { t?: unknown }) => span.t) : [];
		return [p.text, p.aria, p.title, p.placeholder, ...spans].filter((value): value is string => typeof value === "string");
	});
}

describe.skipIf(LANGUAGE !== "en")("English texts", () => {
	test("the pane, its overlays and notices have no Chinese", async () => {
		const pane = await fixture([task("b1", "Do it."), design("b2")]);
		const seen: string[] = [];
		const look = (): string[] => { const now = texts(pane.tsp.nodes()); seen.push(...now); return now; };
		expect(look()).toEqual(expect.arrayContaining(["Launch", "SUBAGENT", "ISOLATED WORKTREE"]));
		pane.tsp.action("b1.more");
		expect(look()).toContain("Delete block");
		pane.tsp.action("status.coordinator");
		await settle();
		expect(look()).toContain("New session");
		pane.tsp.keys("\x16");
		await settle();
		expect(pane.tsp.nodes().find(node => node.k === "toast")?.p?.text).toBe("There is no image in the clipboard");
		pane.tsp.action("b2.fold");
		look();
		expect(seen.filter(text => HAN.test(text))).toEqual([]);
	});
	test("core refusals, outline problems, component diagnostics, the launch footer and the init prompt are English", () => {
		const outputs = [
			...outlineProblems(""),
			...draftDiagnostics("```flow XX\nA -> \n```\n\n```er\n  id PK\n```\n\n![](x)\n\n```code src=\n```\n\n```diff file=a src=b\n```").map(found => found.message),
			launchFooter("/tmp/book.yaml", [{ id: "b1", title: "" }]),
			initPrompt("/tmp/book.yaml"),
		];
		expect(outputs.length).toBeGreaterThan(5);
		expect(outputs.filter(text => HAN.test(text))).toEqual([]);
		const agents = availableAgents([]);
		expect(agents.kind === "unavailable" && HAN.test(agents.reason)).toBe(false);
	});
	test("a stale edit is refused in English", async () => {
		const pane = await fixture();
		const refused = pane.core.edit(template, "b1", "title", "not the title", "x");
		expect(refused).not.toBeNull();
		expect(HAN.test(refused!)).toBe(false);
	});
});

test.skipIf(LANGUAGE === "en")("the English texts hold in an English process", () => {
	const run = Bun.spawnSync(["bun", "test", "test/english.test.ts"], { cwd: `${import.meta.dir}/..`, env: { ...process.env, OMOMP_LANG: "en" }, stdout: "pipe", stderr: "pipe" });
	expect(run.stderr.toString()).toContain(" 0 fail");
	expect(run.exitCode).toBe(0);
});

registerCoreCleanup();
