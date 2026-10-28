// The playbook_* tools' detailed call instructions, served on demand as `tool://<tool>/<topic>`.
// Each tool's own description stays short (omp shows a plugin device's first 200 characters);
// omp-config's tool-topics extension lists these topics under it in the prompt.
//
// Bodies are `topics/<tool>.<name>.md` beside this module (a `---` header with `title` and `when`),
// and one body built per read: the language rule, whose value is the language when it is read.
// They are published through the `tool://` registry omp-config holds on omp's URL router, joined by
// its versioned capability, so this package needs no file of omp-config to build or load. Without
// omp-config there is no registry: the tools keep working, with their short descriptions only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { language } from "../i18n";

/** The registry capability omp-config's `_shared/tool-topics.ts` puts on its `tool://` handler. */
const REGISTRATION = Symbol.for("omp-config.tool-topics.registration.v1");
const OWNER = "omp-playbooks";
const FILE = /^(playbook_[a-z]+)\.([a-z-]+)\.md$/;
const FENCED = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const header = z.object({ title: z.string().min(1), when: z.string().min(1) }).strict();
const result = z.union([
	z.object({ kind: z.literal("registered") }),
	z.object({ kind: z.literal("invalid"), reason: z.string() }),
	z.object({ kind: z.literal("conflict"), reason: z.string() }),
]);

interface Topic {
	readonly name: string;
	readonly title: string;
	readonly when: string;
	readonly read: () => string;
}

interface Registry {
	registerTopics(registration: { readonly tool: string; readonly owner: string; readonly topics: readonly Topic[] }): unknown;
}

function isRegistry(handler: object): handler is Registry {
	return Reflect.get(handler, REGISTRATION) === true && typeof Reflect.get(handler, "registerTopics") === "function";
}

/** The rule every text added to a Playbook follows, in the language of this omp process now. */
function languageTopic(): string {
	const writeIn = language() === "zh" ? "Chinese" : "English";
	return [
		"# Language",
		"",
		`Write the text you add to a Playbook (titles, task bodies, designs, panel titles after the role word, slot options) in ${writeIn}. That language is set by OMOMP_LANG (else the locale) of this omp process, and it holds whatever language the user writes to you in and whatever language the file already uses.`,
		"",
		"Text already in the file stays exactly as written: never translate it, also when you edit around it. The role words of `## A Where · …` panels stay English.",
		"",
	].join("\n");
}

/** Every tool's topics, from the files beside this module and the language rule. */
export function playbookTopics(dir = join(import.meta.dir, "topics")): ReadonlyMap<string, readonly Topic[]> {
	const tools = new Map<string, Topic[]>([["playbook_open", [{ name: "language", title: "Language of new text", when: "before writing or editing any Playbook text", read: languageTopic }]]]);
	for (const file of readdirSync(dir).sort()) {
		const name = FILE.exec(file);
		if (!name) continue;
		const text = readFileSync(join(dir, file), "utf8");
		const parts = FENCED.exec(text);
		if (!parts) throw new Error(`${file}: missing --- header`);
		const meta = header.parse(Bun.YAML.parse(parts[1]!));
		const body = parts[2]!.trim();
		if (!body) throw new Error(`${file}: empty body`);
		const list = tools.get(name[1]!) ?? [];
		list.push({ name: name[2]!, title: meta.title, when: meta.when, read: () => `${body}\n` });
		tools.set(name[1]!, list);
	}
	return tools;
}

/** Publish the topics; a missing or incompatible registry is logged once, never thrown into omp. */
export function registerPlaybookTopics(pi: ExtensionAPI): void {
	try {
		const handler = InternalUrlRouter.instance().getHandler("tool");
		if (!handler || !isRegistry(handler)) {
			pi.logger.warn(`omp-playbooks: no tool:// topics registry (${handler ? "incompatible tool:// handler" : "omp-config's tool-topics not loaded"}); playbook_* tools keep their short descriptions only`);
			return;
		}
		for (const [tool, topics] of playbookTopics()) {
			const outcome = result.parse(handler.registerTopics({ tool, owner: OWNER, topics }));
			if (outcome.kind !== "registered") pi.logger.warn(`omp-playbooks: ${tool} topics not registered`, { reason: outcome.reason });
		}
	} catch (error) {
		pi.logger.warn("omp-playbooks: tool:// topics failed", { error: error instanceof Error ? error.message : String(error) });
	}
}
