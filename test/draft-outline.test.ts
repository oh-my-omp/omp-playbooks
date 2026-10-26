import { describe, expect, test } from "bun:test";
import { outlineProblems } from "../src/service/draft/outline";

const where = "## A Where · 现状\n服务在 10.0.0.1。";
const what = "## B What · 决定\n只开 22 端口。";
const how = "## C How · 处置\n1. 改防火墙";

describe("Where/What/How outline", () => {
	test("a lead, panels of no role and a role spanning several panels follow the outline", () => {
		expect(outlineProblems(`一句话总述。\n\n## X 背景\n来由。\n\n${where}\n\n${what}\n\n${how}\n\n## D How · 验收与回退\n- nc 探测\n\n## E 附图\n![图](a.png)`)).toEqual([]);
	});
	test("an empty text is not yet written, not out of outline", () => {
		expect(outlineProblems(" \n")).toEqual([]);
	});
	test("each missing role is named once", () => {
		const problems = outlineProblems(`${where}\n\n## B 决定\n只开 22。`);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("缺少 What");
		expect(problems[1]).toContain("缺少 How");
	});
	test("a panel that goes back to an earlier role breaks the order", () => {
		expect(outlineProblems(`${what}\n\n${where}\n\n${how}`)).toEqual(["第 4 行的 Where 面板排在第 1 行的 What 之后：顺序是 Where → What → How"]);
		expect(outlineProblems(`${where}\n\n${what}\n\n${how}\n\n## D What · 补充\n再说一点。`)).toHaveLength(1);
	});
	test("a role panel with no readable content, or an empty fence only, is empty", () => {
		expect(outlineProblems(`${where}\n\n## B What · 决定\n\n${how}`)).toEqual(["第 4 行的 What 面板是空的：写目标、决定、预期结果与边界"]);
		expect(outlineProblems(`${where}\n\n## B What · 决定\n\`\`\`callout\n\`\`\`\n\n${how}`)).toHaveLength(1);
	});
	test("a bare role panel hides its heading from the person", () => {
		expect(outlineProblems(`${where}\n\n## B What · 决定 {bare}\n只开 22。\n\n${how}`)).toEqual(["第 4 行的 What 面板设了 bare，标题不显示：去掉 bare"]);
	});
	test("the role word ends at the title end, a space or a separator, and is case-sensitive", () => {
		for (const title of ["How", "How：处置", "How: steps", "How｜处置", "How — steps"]) {
			expect(outlineProblems(`${where}\n\n${what}\n\n## C ${title}\n做。`)).toEqual([]);
		}
		for (const title of ["Howto", "how · 处置", "HOW"]) {
			expect(outlineProblems(`${where}\n\n${what}\n\n## C ${title}\n做。`)[0]).toContain("缺少 How");
		}
	});
});
