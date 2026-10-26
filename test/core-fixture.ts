import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockId, DocRef, FetchOutcome, PlaybookDoc } from "../src/domain/model";
import type { Connection } from "../src/domain/ports";
import type { EventPayload, Request } from "../src/domain/protocol";
import { Core } from "../src/service/core";
import { checks } from "../src/service/checks";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

export const template: DocRef = { kind: "template" };
export function task(id: BlockId, body = "Task body"): Block { return { id, title: id, content: { kind: "task", body }, progress: { kind: "tracked", status: "todo", report: null } }; }
export function design(id: BlockId, text = "## A Plan\nDesign", requirement = "Requirement"): Block { return { id, title: id, content: { kind: "design", design: text, requirement }, progress: { kind: "tracked", status: "todo", report: null } }; }
const cleanups: (() => void)[] = [];
export function registerCoreCleanup(): void {
	afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
}

export function coreFixture(blocks: readonly Block[] = [task("b1"), task("b2", "Other")]) {
	const directory = mkdtempSync("/tmp/tern-current-core-");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const store = createStore(join(directory, "book.yaml"));
	const document: PlaybookDoc = { title: "Playbook", blocks };
	store.write(template, store.serialize(document, null));
	const events: EventPayload[] = [];
	const fetched: FetchOutcome = { ok: true, at: 100, value: { kind: "file", text: "External context" } };
	const core = new Core({ store, references, checks, fetcher: { fetch: async () => fetched }, panes: { ownPane: () => "service-pane", focusPane: async () => ({ ok: true }) } });
	cleanups.push(() => core.stop());
	expect(core.load()).toBeNull();
	const connection: Connection = { id: 1, send: event => events.push(event), close() {} };
	let sequence = 0;
	const request = (value: Request) => core.handle(connection, `q${++sequence}`, value);
	async function success(value: Request): Promise<unknown> {
		const result = await request(value);
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		return result.result;
	}
	async function connect() { core.connected(connection); await success({ op: "hello", args: { session: "test-session", pane: "coordinator-pane" } }); }
	return { core, store, directory, events, connection, request, success, connect };
}
