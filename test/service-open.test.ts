import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { documentEndpoint } from "../src/domain/protocol";

// The document service entry, started as the Tern plugin starts it: this file is the only test
// that runs `main.ts --open` as a program, so it pins the argv contract the Luau plugin passes.
const ENTRY = resolve(import.meta.dir, "../src/service/main.ts");
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function temporaryDirectory(): Promise<string> {
	const dir = await mkdtemp("/tmp/pb-open-");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
/** A Playbook document at its real path, as `main.ts` resolves the argument it is given. */
async function document(): Promise<string> {
	const path = (await temporaryDirectory()) + "/book.yaml";
	await Bun.write(path, "title: Book\nblocks: []\n");
	return realpath(path);
}
/** The `tern` this child finds first: it records the argv of the split and answers with a pane. */
async function fakeTern(): Promise<{ dir: string; args(): Promise<string[]> }> {
	const dir = await temporaryDirectory();
	const capture = dir + "/args";
	await Bun.write(dir + "/tern", `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\nprintf '%s' '{"block": 42}'\n`);
	await chmod(dir + "/tern", 0o755);
	return { dir, args: async () => (await Bun.file(capture).text()).trim().split("\n") };
}
/** Run the service entry with only the fake `tern` added; `OMOMP_LANG=en` fixes the pane command's language. */
async function run(args: readonly string[], tern: { readonly dir: string }): Promise<{ exitCode: number; stderr: string }> {
	// Asynchronous so this process's own endpoint listener keeps answering while the child runs.
	const child = Bun.spawn([process.execPath, ENTRY, ...args], { env: { ...process.env, PATH: `${tern.dir}:${process.env.PATH}`, OMOMP_LANG: "en" }, stdout: "ignore", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	return { exitCode, stderr };
}

test("--open starts the document service beside the pane when none runs", async () => {
	const doc = await document();
	const tern = await fakeTern();
	const result = await run(["--open", doc, "7"], tern);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	expect(await tern.args()).toEqual(["split", "7", "right", "--cwd", dirname(doc), "--json", "--", "omp", "bash", "-c", `OMOMP_LANG=en 'bun' '${ENTRY}' '${doc}'`]);
});

test("--open shows the running service's pane and starts nothing", async () => {
	const doc = await document();
	const tern = await fakeTern();
	const requests: unknown[] = [];
	const server = await IpcServer.listen(documentEndpoint(doc), { framing: "lines" }, connection => {
		connection.start(line => {
			requests.push(JSON.parse(line));
			connection.send(JSON.stringify({ id: "reveal", ok: true, result: null }));
		}, () => undefined);
	});
	cleanup.push(() => server.close());
	const result = await run(["--open", doc, "7"], tern);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	expect(requests).toEqual([{ id: "reveal", op: "reveal", args: {} }]);
	expect(await Bun.file(tern.dir + "/args").exists()).toBe(false);
});

test("--open without a pane id is a usage error", async () => {
	const doc = await document();
	const tern = await fakeTern();
	const result = await run(["--open", doc], tern);
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("omp-playbook --open <playbook.yaml> <pane id>");
	expect(await Bun.file(tern.dir + "/args").exists()).toBe(false);
});
