// The Where/What/How outline a card's text for a person follows (a task body, a design): panels
// whose titles start with the role word, every role present with content, roles in that order.
import { parseDocument, type Panel, type Segment } from "./document";
import { tr } from "../../i18n";

export type OutlineRole = "Where" | "What" | "How";

const ROLES: readonly OutlineRole[] = ["Where", "What", "How"];
/** What each role's panels answer; the problems and the coordinator's guidance use the same words. */
function roleMeaning(): Readonly<Record<OutlineRole, string>> {
	return {
		Where: tr("object, location, scope, current state and evidence", "对象、位置、范围、现状与证据"),
		What: tr("goal, decision, expected result and boundaries", "目标、决定、预期结果与边界"),
		How: tr("steps, verification, failure handling and rollback", "步骤、验证、失败处理与回退"),
	};
}
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
	const meanings = roleMeaning();
	const problems: string[] = [];
	for (const role of ROLES) {
		if (!roles.some(item => item.role === role)) problems.push(tr(`Missing ${role} panel: write \`## <letter> ${role} · <title>\` with content covering ${meanings[role]}`, `缺少 ${role} 面板：写 \`## <字母> ${role} · <标题>\`，内容是${meanings[role]}`));
	}
	roles.forEach((item, index) => {
		const before = roles.slice(0, index).find(earlier => earlier.rank > item.rank);
		if (before) problems.push(tr(`Line ${item.panel.line}'s ${item.role} panel comes after line ${before.panel.line}'s ${before.role} panel; the order is Where → What → How`, `第 ${item.panel.line} 行的 ${item.role} 面板排在第 ${before.panel.line} 行的 ${before.role} 之后：顺序是 Where → What → How`));
		if (item.panel.bare) problems.push(tr(`Line ${item.panel.line}'s ${item.role} panel uses bare, so its title is hidden; remove bare`, `第 ${item.panel.line} 行的 ${item.role} 面板设了 bare，标题不显示：去掉 bare`));
		if (!item.panel.segments.some(readable)) problems.push(tr(`Line ${item.panel.line}'s ${item.role} panel is empty: write ${meanings[item.role]}`, `第 ${item.panel.line} 行的 ${item.role} 面板是空的：写${meanings[item.role]}`));
	});
	return problems;
}
