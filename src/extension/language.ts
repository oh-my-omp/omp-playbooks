import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { configureLanguageReader, type Language } from "../i18n";

type ConfigExtension = "yml" | "yaml" | "json" | "toml";
type Mapping = Readonly<Record<string, unknown>>;

type ReaderState =
	| { readonly kind: "unread" }
	| { readonly kind: "read"; readonly value: Language | null };

const CONFIG_EXTENSIONS: readonly ConfigExtension[] = ["yml", "yaml", "json", "toml"];
let state: ReaderState = { kind: "unread" };

function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(text: string, extension: ConfigExtension): unknown {
	switch (extension) {
		case "yml":
		case "yaml": return Bun.YAML.parse(text);
		case "json": return JSON.parse(text);
		case "toml": return Bun.TOML.parse(text);
	}
}

function readConfiguredLanguage(): Language | null {
	if (state.kind === "read") return state.value;
	let value: Language | null = null;
	try {
		const dir = getAgentDir();
		const candidates = CONFIG_EXTENSIONS.flatMap(extension => {
			const path = join(dir, `omomp.${extension}`);
			return existsSync(path) ? [{ path, extension }] : [];
		});
		if (candidates.length === 1) {
			const candidate = candidates[0]!;
			const root: unknown = parseConfig(readFileSync(candidate.path, "utf8"), candidate.extension);
			if (isMapping(root)) {
				const section: unknown = root["omomp-lang"];
				if (isMapping(section) && Object.keys(section).length === 1 && (section.language === "en" || section.language === "zh")) {
					value = section.language;
				}
			}
		}
	} catch {
		// A missing, unreadable, malformed or wrongly shaped omomp file has no language value.
	}
	state = { kind: "read", value };
	return value;
}

/** Register the cached agent-directory fallback without making the service import an OMP host package. */
export function configureExtensionLanguage(): void {
	configureLanguageReader(readConfiguredLanguage);
}
