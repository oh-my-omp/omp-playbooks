import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { listenPane, type PaneListener } from "../src/extension/pane-listener";

const POSIX = process.platform !== "win32";

const dirs: string[] = [];
const listeners: PaneListener[] = [];
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function endpointIn(): string {
	const dir = mkdtempSync("/tmp/pb-pane-");
	dirs.push(dir);
	return ipcEndpoint(dir, "pane-1");
}
async function ask(endpoint: string, line: string): Promise<unknown> {
	const connection = await IpcConnection.connect(endpoint, { framing: "lines" });
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	connection.start(text => resolve(JSON.parse(text)), () => connection.destroy());
	connection.send(line);
	return promise;
}

describe("pane endpoint", () => {
	test("answers requests, refuses malformed ones, and a second listener never takes a live endpoint", async () => {
		const endpoint = endpointIn();
		const first = await listenPane(endpoint, async request => request.op === "ping" ? { ok: true, session: "s1", cwd: "/w" } : { ok: false, error: { code: "Busy", message: request.doc } });
		expect(first).not.toBeNull();
		listeners.push(first!);
		expect(await ask(endpoint, JSON.stringify({ op: "ping" }))).toEqual({ ok: true, session: "s1", cwd: "/w" });
		expect(await ask(endpoint, JSON.stringify({ op: "attach", doc: "/p.yaml" }))).toEqual({ ok: false, error: { code: "Busy", message: "/p.yaml" } });
		expect(await ask(endpoint, JSON.stringify({ op: "nope" }))).toMatchObject({ ok: false, error: { code: "BadRequest" } });
		expect(await listenPane(endpoint, async () => ({ ok: true, session: "s2", cwd: "/x" }))).toBeNull();
		first!.close();
		listeners.length = 0;
		if (POSIX) expect(existsSync(endpoint)).toBe(false);
	});
	test("takes over the endpoint a killed session left behind", async () => {
		const endpoint = endpointIn();
		const child = Bun.spawn([process.execPath, "-e", `import { IpcServer } from "@oh-my-pi/pi-natives"; await IpcServer.listen(${JSON.stringify(endpoint)}, { framing: "lines" }, () => {}); console.log("ready")`], { stdout: "pipe", stderr: "inherit" });
		const reader = child.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
		reader.releaseLock();
		child.kill("SIGKILL");
		await child.exited;
		const listener = await listenPane(endpoint, async () => ({ ok: true, session: "s3", cwd: "/y" }));
		expect(listener).not.toBeNull();
		listeners.push(listener!);
		expect(await ask(endpoint, JSON.stringify({ op: "ping" }))).toEqual({ ok: true, session: "s3", cwd: "/y" });
	});
});
