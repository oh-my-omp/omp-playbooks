import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { parseEr, renderEr, type ErSpec } from "../src/service/draft/er";
import type { ChangeView, RenderContext } from "../src/service/draft/contract";
import type { TspNode } from "../src/service/tsp-types";

function parsed(text: string, args = "", line = 10): ErSpec {
	const result = parseEr(fence({ args, lines: text.split("\n"), line }));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	expect(result.diagnostics).toEqual([]);
	return result.value;
}
function error(text: string, offset: number, includes: string, args = ""): void {
	const result = parseEr(fence({ args, lines: text.split("\n"), line: 10 }));
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected error");
	expect(result.diagnostics[0]).toMatchObject({ component: "er", severity: "error", line: 10 + offset });
	expect(result.diagnostics[0]!.message).toContain(includes);
}
function draw(spec: ErSpec, view: ChangeView = "changes"): { svg: string; nodes: readonly TspNode[]; width: number } {
	let svg = "";
	let width = 0;
	const ctx: RenderContext = { ...renderDefaults,
		id: "er.test", view,
		svg(id, source, size, alt) { svg = source; width = size.w; return { id, k: "image", p: { alt } }; },
		image() { throw new Error("Unexpected image"); },
		readFile() { throw new Error("Unexpected file"); },
	};
	const result = renderEr(spec, ctx);
	expect(result.diagnostics).toEqual([]);
	return { svg, nodes: result.nodes, width };
}
const EXAMPLE = "*User\n  id PK\n  email string UK\nOrder\n  id PK\n  user_id FK -> User\nUser 1--* Order: places";
const MARKED = "User\n  ~ email varchar(320) UK\n  + phone string\nOrder\n  + coupon_id FK -> Coupon\n  - legacy_ref string\n+ Coupon\n  id PK\n- AuditLog\n  id PK\n+ User 1--* Coupon: owns";

describe("ER schema parsing", () => {
	test("am example, optional types, key badges, default and requested directions", () => {
		const spec = parsed(EXAMPLE, "LR");
		expect(spec.direction).toBe("LR");
		expect(spec.marked).toBe(false);
		expect(spec.entities[0]).toMatchObject({ name: "User", highlighted: true, change: "same", line: 10 });
		expect(spec.entities[0]!.fields).toEqual([
			{ name: "id", type: "", key: "PK", ref: null, change: "same", line: 11 },
			{ name: "email", type: "string", key: "UK", ref: null, change: "same", line: 12 },
		]);
		expect(spec.relationships).toHaveLength(1);
		expect(spec.relationships[0]).toMatchObject({ from: "User", to: "Order", fromCard: "1", toCard: "*", label: "places", source: { kind: "written" } });
		expect(parsed("User").direction).toBe("TB");
		for (const direction of ["TB", "BT", "LR", "RL"] as const) expect(parsed("User", direction).direction).toBe(direction);
	});
	test("all cardinalities; optional labels, whitespace and attached colon", () => {
		for (const left of ["1", "0..1", "*", "1..*"]) for (const right of ["1", "0..1", "*", "1..*"]) {
			const spec = parsed(`A\nB\nA ${left} -- ${right} B: 中文 标签`);
			expect(spec.relationships[0]).toMatchObject({ fromCard: left, toCard: right, label: "中文 标签" });
		}
		expect(parsed("A\nB\nA 1--1 B").relationships[0]!.label).toBe("");
	});
	test("two FKs create two relationships; reverse written relation replaces every implied edge", () => {
		const fields = "User\n  id PK\nOrder\n  creator FK -> User\n  approver int FK -> User";
		const spec = parsed(fields);
		expect(spec.relationships).toHaveLength(2);
		expect(spec.relationships.map(rel => rel.source)).toEqual([{ kind: "field", name: "creator" }, { kind: "field", name: "approver" }]);
		expect(spec.relationships[0]).toMatchObject({ from: "Order", to: "User", fromCard: "*", toCard: "1" });
		expect(parsed(`${fields}\nUser 0..1--1..* Order`).relationships).toHaveLength(1);
	});
	test("self references and multiline types are accepted", () => {
		const spec = parsed("Employee\n  parent bigint unsigned FK -> Employee");
		expect(spec.entities[0]!.fields[0]!.type).toBe("bigint unsigned");
		expect(spec.relationships[0]).toMatchObject({ from: "Employee", to: "Employee" });
	});
	test("Mermaid errors include corrected line and source location", () => {
		error("USER\nORDER\nUSER ||--o{ ORDER : places", 2, "USER 1--* ORDER: places");
		error("+ USER ||..o{ ORDER: places", 0, "+ USER 1--* ORDER: places");
		error("~ USER ||--o{ ORDER", 0, "改为 USER 1--* ORDER");
	});
	test("empty, duplicate, missing and indented entities, malformed fields and relations", () => {
		error("", 0, "至少一个实体");
		error("*", 0, "实体需要名称");
		error("User\n+ User", 1, "重复");
		error("  User\n    id PK", 0, "第 0 列");
		error("Order\n  user_id FK -> User\n  User", 1, "第 0 列写 User");
		error("A\nA 1--* Missing", 1, "第 0 列写 Missing");
		error("A\nB\nA 1--* B\n  id PK", 3, "字段前");
		error("User\n  id FK ->", 1, "FK -> User");
		error("User\n  id FK -> A B", 1, "外键目标");
		error("User\n  id -> User", 1, "只有 FK");
		error("User\n  id PK string", 1, "键标记");
		error("A\nB\nA 2--1 B", 2, "A 1--* B");
		error("User", 0, "方向", "wrong");
	});
});

describe("ER change markers", () => {
	test("field changes do not mark entities; + and - inherit, ~ does not; combine with highlight", () => {
		const spec = parsed("User\n  ~ email string\n+ *Coupon\n  id PK\n  + code UK\n- Log\n  id PK\n~ *Product\n  id PK");
		expect(spec.marked).toBe(true);
		expect(spec.entities.map(entity => entity.change)).toEqual(["same", "added", "removed", "changed"]);
		expect(spec.entities.map(entity => entity.fields.map(field => field.change))).toEqual([["changed"], ["added", "added"], ["removed"], ["same"]]);
		expect(spec.entities[1]!.highlighted).toBe(true);
	});
	test("every conflicting inherited marker and changed relationship is rejected", () => {
		for (const [entity, field] of [["+", "-"], ["+", "~"], ["-", "+"], ["-", "~"]]) error(`${entity} User\n  ${field} id PK`, 1, "冲突");
		error("A\nB\n~ A 1--* B", 2, "- A 1--* B 与 + A 1--1 B");
	});
	test("markers require a space", () => {
		const spec = parsed("-Old\n  -legacy string\n  +1 int\n  ~x\n+New");
		expect(spec.marked).toBe(false);
		expect(spec.entities.map(entity => entity.name)).toEqual(["-Old", "+New"]);
		expect(spec.entities[0]!.fields.map(field => field.name)).toEqual(["-legacy", "+1", "~x"]);
	});
	test("FK relationship takes +/- field state, ~ leaves relation unchanged", () => {
		const spec = parsed("Order\n  + creator FK -> User\n  - approver FK -> User\n  ~ owner FK -> User\nUser");
		expect(spec.relationships.map(rel => rel.change)).toEqual(["added", "removed", "same"]);
	});
	test("endpoint inheritance, written markers and replacement field markers", () => {
		expect(parsed("A\n+ B\nA 1--* B").relationships[0]!.change).toBe("added");
		expect(parsed("A\n- B\nA 1--* B").relationships[0]!.change).toBe("removed");
		expect(parsed("A\nB\n- A 1--* B\n+ A 1--1 B").relationships.map(rel => rel.change)).toEqual(["removed", "added"]);
		expect(parsed("A\n  + b FK -> B\nB\nB 1--* A").relationships[0]!.change).toBe("added");
	});
	test("relationships may not dangle between incompatible changes", () => {
		error("+ A\n- B\nA 1--1 B", 2, "前后视图均不存在");
		error("A\n- B\n+ A 1--* B", 2, "新增关系不能连接已删除");
		error("A\n+ B\n- A 1--* B", 2, "删除关系不能连接新增");
		error("A\n  + b FK -> B\n- B", 1, "新增关系不能连接已删除");
		error("A\n  - b FK -> B\n+ B", 1, "删除关系不能连接新增");
		// A written relationship replaces the FK, including its incompatible endpoint check.
		expect(parsed("A\n  + b FK -> B\n- B\n- A 1--* B").relationships[0]!.change).toBe("removed");
	});
});

describe("ER SVG and views", () => {
	test("changes draw fields, keys, signs and counts with unique prefixed ids", () => {
		const result = draw(parsed(MARKED));
		for (const text of ["email varchar(320)", "phone string", "Coupon", "AuditLog", "PK", "UK", "owns"]) expect(result.svg).toContain(text);
		expect(result.svg).toContain("line-through");
		expect(result.svg).toContain("var(--warning)");
		expect(result.svg).toContain("var(--success)");
		expect(result.nodes[1]!.p!.text).toBe("+5 新增 · −3 删除 · ~1 修改（实体、字段、关系行）");
		const ids = result.nodes.map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => id.startsWith("er.test."))).toBe(true);
	});
	test("before and after exclude correct entities, fields and relationships, without marker styling", () => {
		const spec = parsed(MARKED);
		const before = draw(spec, "before");
		const after = draw(spec, "after");
		for (const text of ["Coupon", "phone string", "coupon_id", "owns"]) expect(before.svg).not.toContain(text);
		expect(before.svg).toContain("AuditLog");
		expect(before.svg).toContain("legacy_ref string");
		for (const text of ["AuditLog", "legacy_ref"]) expect(after.svg).not.toContain(text);
		expect(after.svg).toContain("Coupon");
		expect(after.svg).toContain("phone string");
		for (const result of [before, after]) {
			expect(result.nodes).toHaveLength(1);
			expect(result.svg).not.toContain("line-through");
			expect(result.svg).not.toContain("var(--success)");
			expect(result.svg).not.toContain("var(--warning)");
		}
		expect(draw(parsed("+ A"), "before").svg).toContain("此视图没有实体");
	});
	test("direction puts source before target; self references and parallel FKs render separately", () => {
		for (const direction of ["TB", "BT", "LR", "RL"] as const) {
			const result = draw(parsed("A\nB\nA 1--* B", direction));
			const positions = [...result.svg.matchAll(/data-entity="([AB])"[^>]*><rect x="([\d.]+)" y="([\d.]+)"/g)];
			expect(positions).toHaveLength(2);
			const axis = direction === "LR" || direction === "RL" ? 2 : 3;
			const a = Number(positions[0]![axis]);
			const b = Number(positions[1]![axis]);
			expect(direction === "LR" || direction === "TB" ? a < b : a > b).toBe(true);
			const loops = draw(parsed("Employee\n  boss FK -> Employee\n  mentor FK -> Employee", direction));
			expect([...loops.svg.matchAll(/data-relationship=/g)]).toHaveLength(2);
			expect(loops.svg).not.toMatch(/NaN|undefined|Infinity/);
		}
	});
	test("CJK and XML text, cycles, disconnected entities, long names stay valid and bounded", () => {
		const result = draw(parsed("客户与账户实体\n  显示名称 string UK\n  related FK -> 节点B\n节点B\n  ref FK -> 客户与账户实体\n孤立实体\n  verylongfieldnamewithoutspacesandmanyletters int\nA&B<测试>"));
		expect(result.width).toBeLessThanOrEqual(1000);
		expect(result.svg).toContain("客户与账户实体");
		expect(result.svg).toContain("A&amp;B&lt;测试&gt;");
		expect(result.svg).not.toMatch(/NaN|undefined|Infinity/);
	});
});

test("disconnected components never interrupt a connected component's ranks", () => {
	for (const direction of ["TB", "BT", "LR", "RL"] as const) {
		const result = draw(parsed("A\nB\nUnrelated\nA 1--* B", direction));
		const boxes = [...result.svg.matchAll(/data-entity="([^"]+)"[^>]*><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
		expect(boxes).toHaveLength(3);
		const a = boxes.find(box => box[1] === "A")!;
		const b = boxes.find(box => box[1] === "B")!;
		const unrelated = boxes.find(box => box[1] === "Unrelated")!;
		expect(Number(unrelated[3])).toBeGreaterThan(Math.max(Number(a[3]) + Number(a[5]), Number(b[3]) + Number(b[5])));
	}
});

test("empty marked lines remain markers and give a helpful source-line error", () => {
	error("+ ", 0, "实体需要名称");
	error("User\n  + ", 1, "字段需要名称");
});
