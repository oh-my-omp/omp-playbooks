import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenPane, type PaneListener } from "../src/extension/pane-listener";

const dirs: string[] = [];
const listeners: PaneListener[] = [];
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function socketIn(): string {
	const dir = mkdtempSync("/tmp/pb-pane-");
	dirs.push(dir);
	return join(dir, "pane-1.sock");
}
async function ask(path: string, line: string): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let text = "";
	await Bun.connect({
		unix: path,
		socket: {
			open(socket) { socket.write(line); },
			data(_socket, chunk) { text += new TextDecoder().decode(chunk); },
			close() { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } },
			error(_socket, error) { reject(error); },
		},
	});
	return promise;
}

describe("pane socket", () => {
	test("answers requests, refuses malformed ones, and a second process never takes a live path", async () => {
		const path = socketIn();
		const first = await listenPane(path, async request => request.op === "ping" ? { ok: true, session: "s1", cwd: "/w" } : { ok: false, error: { code: "Busy", message: request.doc } });
		expect(first).not.toBeNull();
		listeners.push(first!);
		expect(await ask(path, `${JSON.stringify({ op: "ping" })}\n`)).toEqual({ ok: true, session: "s1", cwd: "/w" });
		expect(await ask(path, `${JSON.stringify({ op: "attach", doc: "/p.yaml" })}\n`)).toEqual({ ok: false, error: { code: "Busy", message: "/p.yaml" } });
		expect(await ask(path, "{\"op\":\"nope\"}\n")).toMatchObject({ ok: false, error: { code: "BadRequest" } });
		expect(await listenPane(path, async () => ({ ok: true, session: "s2", cwd: "/x" }))).toBeNull();
		first!.close();
		listeners.length = 0;
		expect(existsSync(path)).toBe(false);
	});
	test("a stale socket file left by a dead process is replaced", async () => {
		const path = socketIn();
		writeFileSync(path, "");
		const listener = await listenPane(path, async () => ({ ok: true, session: "s3", cwd: "/y" }));
		expect(listener).not.toBeNull();
		listeners.push(listener!);
		expect(await ask(path, `${JSON.stringify({ op: "ping" })}\n`)).toEqual({ ok: true, session: "s3", cwd: "/y" });
	});
});
