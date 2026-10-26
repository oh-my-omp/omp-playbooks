import { describe, expect, test } from "bun:test";
import { parseSlot, parseSlots, resolveSlots, setSlotValue, slotParts } from "../src/service/draft/slot";
import { fence } from "./draft-helpers";

const source = "Before {{mode}}.\n```slot mode\n= Fast\n* Fast | recommended\n- Safe | slower\n~ Old | previous\n```\nAfter {{ mode }} and {{unknown}}.\n";

describe("slots", () => {
	test("parses current value, all option kinds and notes", () => {
		const parsed = parseSlots(source);
		expect(parsed.slots.get("mode")).toEqual({ name: "mode", value: "Fast", line: 3, options: [{ label: "Fast", note: "recommended", kind: "recommended" }, { label: "Safe", note: "slower", kind: "option" }, { label: "Old", note: "previous", kind: "past" }] });
		expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ line: 8, severity: "warning", component: "slot" }));
	});
	for (const lines of [["- No current"], ["= A", "= B"], ["= A", "invalid"], ["= A", "- | no label"]]) {
		test(`rejects invalid declaration ${JSON.stringify(lines)}`, () => {
			const parsed = parseSlot(fence({ args: "mode", line: 4, lines }));
			expect(parsed.ok).toBe(false);
			expect(parsed.diagnostics.some(item => item.severity === "error")).toBe(true);
		});
	}
	test("a repeated option keeps its first occurrence with a warning and the slot still parses", () => {
		const parsed = parseSlot(fence({ args: "mode", line: 4, lines: ["= B", "~ A | earlier", "* A | recommended", "- B"] }));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.options).toEqual([{ label: "A", note: "earlier", kind: "past" }, { label: "B", note: "", kind: "option" }]);
		expect(parsed.diagnostics).toEqual([expect.objectContaining({ line: 6, severity: "warning", component: "slot" })]);
	});
	test("duplicate names retain the first declaration and diagnose the second", () => {
		const parsed = parseSlots(source + "```slot mode\n= Other\n```\n");
		expect(parsed.slots.get("mode")?.value).toBe("Fast");
		expect(parsed.diagnostics.some(item => item.severity === "error")).toBe(true);
	});
	test("template braces inside code are not reported as undeclared slots", () => {
		const text = "Run `docker ps --format '{{.Names}}'` then {{missing}}.\n```sh\necho {{.Image}}\n```\n";
		expect(parseSlots(text).diagnostics.map(item => item.message)).toEqual(["{{missing}} 没有对应的 slot 声明"]);
	});
	test("setting known options round-trips without changing prose or options", () => {
		const next = setSlotValue(source, "mode", "Safe");
		expect(next).not.toBeNull();
		expect(next).toBe(source.replace("= Fast", "= Safe"));
		expect(parseSlots(next!).slots.get("mode")?.value).toBe("Safe");
		expect(setSlotValue(next!, "mode", "Fast")).toBe(source);
	});
	test("custom values remain available as a past option without duplication", () => {
		const next = setSlotValue(source, "mode", "Custom")!;
		const slot = parseSlots(next).slots.get("mode")!;
		expect(slot.value).toBe("Custom");
		expect(slot.options.at(-1)).toMatchObject({ label: "Custom", kind: "past" });
		expect(setSlotValue(next, "mode", "Custom")).toBe(next);
		expect(setSlotValue(source, "missing", "x")).toBeNull();
		expect(setSlotValue(source, "mode", "two\nlines")).toBeNull();
	});
	test("resolution removes declaration fences and substitutes only declared uses", () => {
		expect(resolveSlots(source)).toBe("Before Fast.\nAfter Fast and {{unknown}}.\n");
		expect(resolveSlots("No declaration: {{mode}}")).toBe("No declaration: {{mode}}");
		expect(slotParts("x {{mode}} y {{unknown}}", parseSlots(source).slots)).toEqual([{ kind: "text", text: "x " }, { kind: "slot", name: "mode" }, { kind: "text", text: " y {{unknown}}" }]);
	});
});
