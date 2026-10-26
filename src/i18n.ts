// The language the person- and model-facing texts of this process are written in, fixed for the
// life of the process. Each process resolves its own: the extension in the omp session, the
// document service in its pane. Processes this package starts (the service pane, a new
// coordinator session) are given the starter's language so they match it; a process started
// elsewhere keeps the language of its own environment.

export type Language = "en" | "zh";

/** The environment variable that names the language explicitly: `en` or `zh`. */
export const LANGUAGE_ENV = "OMP_PLAYBOOKS_LANG";

/**
 * `OMP_PLAYBOOKS_LANG` when it is `en` or `zh` (any case); any other value is ignored. Otherwise
 * the first non-empty of LC_ALL, LC_MESSAGES and LANG: Chinese when it starts with `zh`, else
 * English. Otherwise English.
 */
export function resolveLanguage(env: Readonly<Record<string, string | undefined>>): Language {
	const explicit = env[LANGUAGE_ENV]?.trim().toLowerCase();
	if (explicit === "en" || explicit === "zh") return explicit;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

export const LANGUAGE: Language = resolveLanguage(process.env);

/** The text for this process's language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return LANGUAGE === "zh" ? zh : en;
}

/** `argv` run with this process's language, for a program started in a Tern pane (which does not inherit this process's environment). */
export function withLanguage(argv: readonly string[]): string[] {
	return ["env", `${LANGUAGE_ENV}=${LANGUAGE}`, ...argv];
}
