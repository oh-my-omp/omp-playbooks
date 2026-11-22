import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import { language } from "../../omomp-shared/i18n";
import type { ToolTopicDoc } from "../../omomp-shared/internal-url";

const FILE = /^(playbook_[a-z_]+)\.([a-z-]+)\.md$/;
const FENCED = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const header = z.object({ title: z.string().min(1), when: z.string().min(1) }).strict();

function languageSection(): string {
	const writeIn = language() === "zh" ? "Chinese" : "English";
	return [
		"# Language",
		"",
		`Write the text you add to a Playbook (titles, task bodies, designs, panel titles after the role word, slot options) in ${writeIn}. That language is set by OMOMP_LANG (else the locale) of this omp process, and it holds whatever language the user writes to you in and whatever language the file already uses.`,
		"",
		"Text already in the file stays exactly as written: never translate it, also when you edit around it. The role words of `## A Where · …` panels stay English.",
	].join("\n");
}

export function playbookTopics(dir = join(import.meta.dir, "topics")): readonly ToolTopicDoc[] {
	const docs: ToolTopicDoc[] = [];
	for (const file of readdirSync(dir).sort()) {
		const name = FILE.exec(file);
		if (!name) continue;
		const text = readFileSync(join(dir, file), "utf8");
		const parts = FENCED.exec(text);
		if (!parts) throw new Error(`${file}: missing --- header`);
		const meta = header.parse(Bun.YAML.parse(parts[1]!));
		const body = parts[2]!.trim();
		if (!body) throw new Error(`${file}: empty body`);
		const tool = name[1]!;
		const topic = name[2]!;
		docs.push({
			tool,
			topic,
			title: meta.title,
			when: meta.when,
			body: topic === "execution" || topic === "format-outline" ? () => `${body}\n\n${languageSection()}\n` : `${body}\n`,
		});
	}
	return docs;
}
