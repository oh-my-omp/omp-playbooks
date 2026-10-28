import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { slotParts } from "./slot";
import { inlineSpans, type Span } from "./text";

type TableAlignment = "start" | "center" | "end";

interface TableColumn {
	readonly header: string;
	readonly align: TableAlignment;
}

export interface TableSpec {
	readonly columns: readonly TableColumn[];
	/** Body rows have exactly one cell for each column. */
	readonly rows: readonly (readonly string[])[];
}

/** Split structural pipes, removing only the backslash that escapes a literal pipe. */
function splitRow(source: string): string[] {
	const text = source.trim();
	const cells: string[] = [];
	let cell = "";
	for (const char of text) {
		if (char !== "|") {
			cell += char;
			continue;
		}
		let backslashes = 0;
		for (let index = cell.length - 1; index >= 0 && cell[index] === "\\"; index--) backslashes++;
		if (backslashes % 2 === 1) cell = `${cell.slice(0, -1)}|`;
		else {
			cells.push(cell.trim());
			cell = "";
		}
	}
	cells.push(cell.trim());
	if (text.startsWith("|")) cells.shift();
	if (cells.length > 1 && cells[cells.length - 1] === "" && text.endsWith("|")) cells.pop();
	return cells;
}

export function parseTable(input: FenceInput): Parsed<TableSpec> {
	const headers = splitRow(input.lines[0] ?? "");
	const delimiter = input.lines[1];
	const delimiters = delimiter === undefined ? [] : splitRow(delimiter);
	if (delimiter === undefined || delimiters.length !== headers.length || delimiters.some(cell => !/^:?-+:?$/.test(cell))) {
		return {
			ok: false,
			diagnostics: [diagnostic("table", input.line + 1, tr("The table is missing a valid delimiter row; after the header, write the same number of columns as | --- | ---: |.", "表格缺少有效分隔行；在表头后写与列数相同的 | --- | ---: |。"))],
		};
	}
	const columns: TableColumn[] = headers.map((header, index) => {
		const delimiterCell = delimiters[index]!;
		const align: TableAlignment = delimiterCell.endsWith(":") ? (delimiterCell.startsWith(":") ? "center" : "end") : "start";
		return { header, align };
	});
	const rows: string[][] = [];
	const diagnostics: DraftDiagnostic[] = [];
	for (let index = 2; index < input.lines.length; index++) {
		const cells = splitRow(input.lines[index]!);
		if (cells.length !== columns.length) {
			diagnostics.push(diagnostic("table", input.line + index, tr(`This row has ${cells.length} cells; change it to the same ${columns.length} cells as the header.`, `此行有 ${cells.length} 格；请改为与表头相同的 ${columns.length} 格。`), "warning"));
			cells.length = columns.length;
			for (let column = 0; column < columns.length; column++) cells[column] ??= "";
		}
		rows.push(cells);
	}
	return { ok: true, value: { columns, rows }, diagnostics };
}

function cellSpans(cell: string): readonly Span[] {
	const status = /^(ok|no|warn)(?:\s+(.*))?$/s.exec(cell);
	if (!status) return inlineSpans(cell);
	const label = (status[2] ?? "").trim();
	const word = status[1];
	const icon = word === "ok" ? "✓" : word === "no" ? "✗" : "!";
	const tone = word === "ok" ? "success" : word === "no" ? "error" : "warning";
	return inlineSpans(`${icon}${label ? ` ${label}` : ""}`, tone);
}

export function renderTable(spec: TableSpec, ctx: RenderContext): Rendered {
	const cols = spec.columns.map((column, index) => ({
		id: `${ctx.id}.column.${index}`,
		head: inlineSpans(column.header),
		align: column.align,
		// Without grow Tern sizes a column to its head and cuts longer cells to "…".
		grow: 1,
	}));
	const rows = spec.rows.map((row, index) => {
		const cells: Record<string, readonly Span[]> = {};
		// A cell is text, not a control: a slot shows its current value, switched where it is used in prose.
		const shown = (cell: string): string => slotParts(cell, ctx.slots).map(part => part.kind === "slot" ? ctx.slots.get(part.name)!.value : part.text).join("");
		for (let column = 0; column < cols.length; column++) cells[cols[column]!.id] = cellSpans(shown(row[column]!));
		return { id: `${ctx.id}.row.${index}`, cells };
	});
	return { nodes: [{ id: `${ctx.id}.table`, k: "table", p: { cols, rows } }], diagnostics: [] };
}
