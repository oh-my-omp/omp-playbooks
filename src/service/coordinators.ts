// Choosing a coordinator from the Playbook pane. Tern says which panes of this window run omp; the pane
// socket of the omp session there says whether omp-playbooks is loaded and makes it connect. The service
// itself becomes "online" only through that session's K1 hello, as with playbook_open.
import { tmpdir } from "node:os";
import { tr, withLanguage } from "../i18n";
import { paneSocketPath, type PaneReply, type PaneRequest } from "../domain/protocol";
import { listPanes, movePane, splitPane, type TernPane } from "./panes";

export interface OmpPane extends TernPane {
	/** Whether the omp session in the pane answers on its pane socket (omp-playbooks loaded). */
	readonly loaded: boolean;
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

const PING_MS = 1_000;
const ATTACH_MS = 15_000;

function parseReply(line: string): PaneReply | null {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || !("ok" in value)) return null;
		if (value.ok === true && "session" in value && typeof value.session === "string" && "cwd" in value && typeof value.cwd === "string") return { ok: true, session: value.session, cwd: value.cwd };
		if (value.ok === false && "error" in value && typeof value.error === "object" && value.error !== null && "code" in value.error && "message" in value.error) {
			return { ok: false, error: { code: String(value.error.code), message: String(value.error.message) } };
		}
		return null;
	} catch {
		return null;
	}
}

/** One request on a pane socket; the session replies with one line and closes. */
async function ask(pane: string, request: PaneRequest, timeoutMs: number): Promise<PaneReply> {
	const { promise, resolve } = Promise.withResolvers<PaneReply>();
	const fail = (code: string, message: string): void => resolve({ ok: false, error: { code, message } });
	const timer = setTimeout(() => fail("Timeout", tr(`Pane ${pane} did not respond within ${timeoutMs / 1000} s`, `面板 ${pane} 在 ${timeoutMs / 1000} 秒内没有响应`)), timeoutMs);
	let text = "";
	Bun.connect({
		unix: paneSocketPath(tmpdir(), pane),
		socket: {
			open(socket) { socket.write(`${JSON.stringify(request)}\n`); },
			data(_socket, chunk) { text += new TextDecoder().decode(chunk); },
			close() {
				clearTimeout(timer);
				const reply = parseReply(text.trim());
				if (reply) resolve(reply);
				else fail("BadReply", tr(`Pane ${pane} responded with ${JSON.stringify(text)}`, `面板 ${pane} 返回了 ${JSON.stringify(text)}`));
			},
			error(_socket, error) { clearTimeout(timer); fail("Socket", error.message); },
		},
	}).catch((error: unknown) => { clearTimeout(timer); fail("NoListener", error instanceof Error ? error.message : String(error)); });
	return promise;
}

/**
 * The omp panes of this window other than `own`: a pane whose omp session answers on its pane socket
 * (omp-playbooks loaded), or one Tern knows runs omp (its session file) without that socket. Tern's
 * session file alone misses an omp started with --no-session, so the socket is asked of every pane.
 */
export async function ompPanes(own: string): Promise<{ ok: true; panes: readonly OmpPane[] } | { ok: false; error: string }> {
	const listed = await listPanes();
	if (!listed.ok) return listed;
	const probed = await Promise.all(listed.panes.filter(pane => pane.pane !== own).map(async (pane): Promise<OmpPane> => ({ ...pane, loaded: (await ask(pane.pane, { op: "ping" }, PING_MS)).ok })));
	// Panes that can become coordinator first; Tern's order within each group.
	const omp = probed.filter(pane => pane.loaded || pane.ompSession !== null);
	return { ok: true, panes: [...omp.filter(pane => pane.loaded), ...omp.filter(pane => !pane.loaded)] };
}

/** Ask the omp session in `pane` to connect to this document as its coordinator; resolves once it did or could not. */
export async function attach(pane: string, doc: string): Promise<Outcome> {
	const reply = await ask(pane, { op: "attach", doc }, ATTACH_MS);
	return reply.ok ? { ok: true } : { ok: false, error: `${reply.error.code}: ${reply.error.message}` };
}

/** Make `own` (this Playbook pane) the right half of `target`, however deeply either is nested. */
export function pairBeside(own: string, target: string): Promise<Outcome> {
	return movePane(own, "right-of", target);
}

/** The first user prompt of a session started from the Playbook pane. */
export function initPrompt(doc: string): string {
	return tr(`Call playbook_open with doc ${doc} and act as this Playbook's coordinator. First use playbook_read to read it once, then wait: after each Playbook notice, follow its Next step.`, `调用 playbook_open，doc 为 ${doc}，作为这份 Playbook 的协调者。先用 playbook_read 读一遍它，然后等待：之后每收到 Playbook 通知，就按通知里的下一步做。`);
}

/** Start omp with the init prompt in a new pane on the left of `own`, so the Playbook pane is its right half. */
export async function newSession(own: string, doc: string, cwd: string): Promise<Outcome> {
	const omp = Bun.which("omp");
	if (omp === null) return { ok: false, error: tr("omp was not found in this pane's PATH", "找不到 omp：它不在这个面板的 PATH 里") };
	const split = await splitPane(own, cwd, withLanguage([omp, initPrompt(doc)]));
	if (!split.ok) return split;
	return movePane(split.pane, "left-of", own);
}

/** What choosing a pane did: the attach and the move are answered by different owners (omp, Tern). */
export type Chosen =
	| { readonly kind: "paired" }
	| { readonly kind: "attachFailed"; readonly error: string }
	| { readonly kind: "moveFailed"; readonly error: string };

/** The Playbook pane's way to pick or start its coordinator. */
export interface CoordinatorPicker {
	/** The omp panes of this window, asked of Tern and their sessions now. */
	list(): Promise<{ ok: true; panes: readonly OmpPane[] } | { ok: false; error: string }>;
	/** Make the session in `pane` the coordinator, then this pane its right half. */
	choose(pane: string): Promise<Chosen>;
	/** A new omp session on the left of this pane, started with the init prompt. */
	newSession(): Promise<Outcome>;
}

export function coordinatorPicker(doc: string, cwd: string, own: string | null): CoordinatorPicker {
	const error = tr("This Playbook pane is not running in a Tern pane (TERN_PANE is missing), so panes cannot be listed or arranged", "这个 Playbook 面板不在 Tern 的面板里运行（没有 TERN_PANE），无法列出或排列面板");
	return {
		list: () => own === null ? Promise.resolve({ ok: false, error }) : ompPanes(own),
		async choose(pane) {
			if (own === null) return { kind: "attachFailed", error };
			const attached = await attach(pane, doc);
			if (!attached.ok) return { kind: "attachFailed", error: attached.error };
			const moved = await pairBeside(own, pane);
			return moved.ok ? { kind: "paired" } : { kind: "moveFailed", error: moved.error };
		},
		newSession: () => own === null ? Promise.resolve({ ok: false, error }) : newSession(own, doc, cwd),
	};
}
