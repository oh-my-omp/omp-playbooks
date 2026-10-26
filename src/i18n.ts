// Person-facing text follows the language of the process at the time it is used. The OMP
// extension registers an agent-directory omomp reader; the document service does not, because it
// also runs outside OMP and receives its language through the environment of the process that
// started it.

export type Language = "en" | "zh";

/** The environment variable that names the language explicitly: `en` or `zh`. */
export const LANGUAGE_ENV = "OMOMP_LANG";

type LanguageReader = () => Language | null;
let languageReader: LanguageReader | null = null;
let configured: Language | null | undefined;

/** Register the OMP-only fallback reader before extension registration starts. */
export function configureLanguageReader(reader: LanguageReader): void {
	languageReader = reader;
	configured = undefined;
}

/** `en` or `zh` when `value` names one (any case, surrounding space ignored). */
export function parseLanguage(value: string | undefined): Language | null {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : null;
}

/**
 * `OMOMP_LANG` when it is `en` or `zh` (any case); any other value is ignored. Otherwise the
 * optional OMP-only configured language, then the first non-empty of LC_ALL, LC_MESSAGES and LANG:
 * Chinese when it starts with `zh`, else English. Otherwise English.
 */
export function resolveLanguage(env: Readonly<Record<string, string | undefined>>, configuredLanguage: Language | null = null): Language {
	const explicit = parseLanguage(env[LANGUAGE_ENV]);
	if (explicit !== null) return explicit;
	if (configuredLanguage !== null) return configuredLanguage;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** Read the OMP-only fallback once per process; a missing reader means service-side env/locale only. */
function configuredLanguage(): Language | null {
	if (configured !== undefined) return configured;
	configured = languageReader?.() ?? null;
	return configured;
}

/** Resolve the current process language at call time; only the configured file read is cached. */
export function language(): Language {
	return resolveLanguage(process.env, configuredLanguage());
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}

/** `argv` run with the current process language in a Tern pane that does not inherit this process's environment. */
export function withLanguage(argv: readonly string[]): string[] {
	return ["env", `${LANGUAGE_ENV}=${language()}`, ...argv];
}
