// The Where/What/How outline a card's text for a person follows (a task body, a design): panels
// whose titles start with the role word, every role present with content, roles in that order.
import { parseDocument, type Panel, type Segment } from "./document";

export type OutlineRole = "Where" | "What" | "How";

const ROLES: readonly OutlineRole[] = ["Where", "What", "How"];
/** What each role's panels answer; the problems and the coordinator's guidance use the same words. */
export const ROLE_MEANING: Readonly<Record<OutlineRole, string>> = {
	Where: "对象、位置、范围、现状与证据",
	What: "目标、决定、预期结果与边界",
	How: "步骤、验证、失败处理与回退",
};
/** The role word starting a panel title (case as written here), then the title's end, a space or a separator. */
const ROLE = /^(Where|What|How)(?=$|[\s·:：|｜\-—])/;

function roleOf(panel: Panel): OutlineRole | null {
	const word = ROLE.exec(panel.title)?.[1];
	return ROLES.find(role => role === word) ?? null;
}

/** Something a person reads: prose, a table, an image, or a fence with a body. */
function readable(segment: Segment): boolean {
	switch (segment.kind) {
		case "markdown": return segment.text.trim() !== "";
		case "fence": return segment.input.lines.some(line => line.trim() !== "");
		case "table": case "image": return true;
	}
}

/**
 * What keeps `text` from the outline; empty when it follows it. A lead and panels of no role may
 * sit anywhere; a role may span several panels (`How · 处置`, `How · 验收与回退`) as long as no
 * panel goes back to an earlier role. An empty text lacks every role.
 */
export function outlineProblems(text: string): readonly string[] {
	const roles = parseDocument(text).panels.flatMap(panel => {
		const role = roleOf(panel);
		return role ? [{ panel, role, rank: ROLES.indexOf(role) }] : [];
	});
	const problems: string[] = [];
	for (const role of ROLES) {
		if (!roles.some(item => item.role === role)) problems.push(`缺少 ${role} 面板：写 \`## <字母> ${role} · <标题>\`，内容是${ROLE_MEANING[role]}`);
	}
	roles.forEach((item, index) => {
		const before = roles.slice(0, index).find(earlier => earlier.rank > item.rank);
		if (before) problems.push(`第 ${item.panel.line} 行的 ${item.role} 面板排在第 ${before.panel.line} 行的 ${before.role} 之后：顺序是 Where → What → How`);
		if (item.panel.bare) problems.push(`第 ${item.panel.line} 行的 ${item.role} 面板设了 bare，标题不显示：去掉 bare`);
		if (!item.panel.segments.some(readable)) problems.push(`第 ${item.panel.line} 行的 ${item.role} 面板是空的：写${ROLE_MEANING[item.role]}`);
	});
	return problems;
}
