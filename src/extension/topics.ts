// The playbook_* tools' detailed instructions, served by their own docTopics() as
// `xd://<tool>/<topic>`. File headers supply the description pointers; only bodies are served.
// The language rule is generated each time docTopics() reads it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import { language } from "../i18n";

const FILE = /^(playbook_[a-z]+)\.([a-z-]+)\.md$/;
const FENCED = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const header = z.object({ title: z.string().min(1), when: z.string().min(1) }).strict();

interface Topic {
	readonly name: string;
	readonly title: string;
	readonly when: string;
	readonly read: () => string;
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
