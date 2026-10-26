import { startUi, type ClipboardImageReader } from "../src/service/ui";
import type { FrameOp, FrameStatus, TspEvent, TspInput, TspNode, TspSession } from "../src/service/tsp-types";
import type { CoordinatorPicker, OmpPane } from "../src/service/coordinators";
import { coreFixture, task } from "./core-fixture";

export class TestTsp implements TspSession {
	input: (input: TspInput) => void = () => {};
	statusListener: (blocks: readonly string[]) => void = () => {};
	roots = new Map<string, TspNode>();
	frames: { ops: readonly FrameOp[]; blocks: readonly string[] }[] = [];
	ready = Promise.withResolvers<void>();
	start(_app: string, input: (input: TspInput) => void) { this.input = input; }
	open() {}
	blob() {}
	frame(ops: readonly FrameOp[], blocks: readonly string[]) {
		this.frames.push({ ops, blocks });
		for (const op of ops) { if (op[0] === "add") this.roots.set(op[1], op[4]); else if (op[0] === "del") this.roots.delete(op[1]); }
		this.ready.resolve();
		return this.frames.length;
	}
	status(): FrameStatus { return { blockError: false, documentError: false, pendingOverdue: false }; }
	fullRedraw() {}
	onStatusChange(listener: (blocks: readonly string[]) => void) { this.statusListener = listener; }
	action(id: string, act = "invoke", mods: readonly string[] = []) { this.input({ kind: "event", event: { ev: "action", id, act, mods } }); }
	event(event: TspEvent) { this.input({ kind: "event", event }); }
	keys(bytes: string) { this.input({ kind: "keys", bytes }); }
	nodes(): TspNode[] {
		const walk = (node: TspNode): TspNode[] => [node, ...(node.c ?? []).flatMap(walk)];
		return [...this.roots.values()].flatMap(walk);
	}
	node(id: string): TspNode { const found = this.nodes().find(node => node.id === id); if (!found) throw new Error(`Missing node ${id}`); return found; }
}

/** A coordinator picker that answers from fixed data and records what was asked of it. */
export function fakeCoordinators(panes: readonly OmpPane[] = []) {
	const calls: string[] = [];
	const coordinators: CoordinatorPicker = {
		list: async () => { calls.push("list"); return { ok: true, panes }; },
		choose: async pane => { calls.push(`choose ${pane}`); return { kind: "paired" }; },
		newSession: async () => { calls.push("new"); return { ok: true }; },
	};
	return { coordinators, calls };
}

export async function fixture(blocks = [task("b1"), task("b2")], coordinators = fakeCoordinators(), clipboard: ClipboardImageReader = async () => null) {
	const f = coreFixture(blocks);
	const tsp = new TestTsp();
	startUi(f.core, tsp, f.directory, coordinators.coordinators, clipboard);
	tsp.input({ kind: "hello", dark: true });
	await tsp.ready.promise;
	return { ...f, tsp, calls: coordinators.calls };
}

/** The fakes answer at once; draining queued promise callbacks lets the UI apply each answer. */
export const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
