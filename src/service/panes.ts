// Tern panes through the `tern` CLI: the daemon owns panes, their programs and the layout; this module
// only asks it and reports its answer.
import { tr } from "../i18n";
type TernResult = { ok: true; json: unknown } | { ok: false; error: string };
type PaneResult = { ok: true; pane: string } | { ok: false; error: string };

/** The daemon supplies this id to programs running in its panes. */
export function ownPane(): string | null {
	return process.env.TERN_PANE ?? null;
}

async function tern(args: readonly string[]): Promise<TernResult> {
	try {
		const child = Bun.spawn(["tern", ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (exitCode !== 0) return { ok: false, error: tr(`tern ${args[0]} exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`, `tern 以退出码 ${exitCode} 退出：${stderr.trim() || stdout.trim()}`) };
		return { ok: true, json: stdout.trim() ? JSON.parse(stdout) : null };
	} catch (error: unknown) {
		return { ok: false, error: tr(`tern: ${error instanceof Error ? error.message : String(error)}`, `tern：${error instanceof Error ? error.message : String(error)}`) };
	}
}

function paneOf(result: TernResult): PaneResult {
	if (!result.ok) return result;
	const json = result.json;
	if (typeof json === "object" && json !== null && "block" in json) {
		const block = json.block;
		if (typeof block === "string" && block.length > 0) return { ok: true, pane: block };
		if (typeof block === "number" && Number.isSafeInteger(block)) return { ok: true, pane: String(block) };
	}
	return { ok: false, error: tr("tern returned an invalid pane ID", "tern 返回了无效的面板 ID") };
}

/** The daemon, not the caller, owns the new pane and its program (contracts.md K5). */
export async function splitPane(pane: string, cwd: string, command: readonly string[]): Promise<PaneResult> {
	return paneOf(await tern(["split", pane, "right", "--cwd", cwd, "--json", "--", ...command]));
}

export async function focusPane(pane: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await tern(["focus", pane, "--json"]);
	return result.ok ? { ok: true } : result;
}

/** Move an existing pane, its program running on, beside `target` wherever that sits in the layout. */
export async function movePane(pane: string, side: "left-of" | "right-of", target: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await tern(["move", pane, side, target, "--json"]);
	return result.ok ? { ok: true } : result;
}

/** A pane of this window as `tern inspect --json` reports it. */
export interface TernPane {
	readonly pane: string;
	readonly title: string;
	readonly cwd: string;
	/** Where the window shows it: its session's name and the tab's number in that session. */
	readonly place: { readonly session: string; readonly tab: number } | null;
	/** Set when omp runs in the pane: its session file. */
	readonly ompSession: string | null;
}

const idOf = (value: unknown): string | null => typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && value ? value : null;
const textOf = (value: unknown): string => typeof value === "string" ? value : "";

/** Every pane of the window this program runs in (Tern scopes `inspect` to it). */
export async function listPanes(): Promise<{ ok: true; panes: readonly TernPane[] } | { ok: false; error: string }> {
	const result = await tern(["inspect", "--json"]);
	if (!result.ok) return result;
	const json = result.json;
	if (typeof json !== "object" || json === null || !("panes" in json) || !Array.isArray(json.panes)) return { ok: false, error: tr("tern inspect returned no panes", "tern inspect 没有返回面板") };
	const places = new Map<string, { session: string; tab: number }>();
	const sessions = "sessions" in json && Array.isArray(json.sessions) ? json.sessions : [];
	for (const session of sessions) {
		if (typeof session !== "object" || session === null) continue;
		const name = "name" in session ? textOf(session.name) : "";
		for (const tab of "tabs" in session && Array.isArray(session.tabs) ? session.tabs : []) {
			if (typeof tab !== "object" || tab === null) continue;
			const number = "number" in tab && typeof tab.number === "number" ? tab.number : null;
			for (const block of "blocks" in tab && Array.isArray(tab.blocks) ? tab.blocks : []) {
				const id = typeof block === "object" && block !== null && "id" in block ? idOf(block.id) : null;
				if (id !== null && number !== null) places.set(id, { session: name, tab: number });
			}
		}
	}
	const panes: TernPane[] = [];
	for (const entry of json.panes) {
		if (typeof entry !== "object" || entry === null || !("pane" in entry)) continue;
		const pane = idOf(entry.pane);
		if (pane === null) continue;
		const ompSession = "omp_session_file" in entry && typeof entry.omp_session_file === "string" && entry.omp_session_file ? entry.omp_session_file : null;
		panes.push({ pane, title: "title" in entry ? textOf(entry.title) : "", cwd: "cwd" in entry ? textOf(entry.cwd) : "", place: places.get(pane) ?? null, ompSession });
	}
	return { ok: true, panes };
}
