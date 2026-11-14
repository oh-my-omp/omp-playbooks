// Person-facing text follows the language of the process at the time it is used, resolved
// from the environment on every call: `OMOMP_LANG`, then the locale, then English.

export type Language = "en" | "zh";

/** The environment variable that names the language explicitly: `en` or `zh`. */
export const LANGUAGE_ENV = "OMOMP_LANG";
/** `en` or `zh` when `value` names one (any case, surrounding space ignored). */
export function parseLanguage(value: string | undefined): Language | null {
	const normalized = value?.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : null;
}

/**
 * `OMOMP_LANG` when it is `en` or `zh` (any case); any other value is ignored. Otherwise
 * the first non-empty of LC_ALL, LC_MESSAGES and LANG: Chinese when it starts with `zh`,
 * else English. Otherwise English.
 */
export function resolveLanguage(env: Readonly<Record<string, string | undefined>>): Language {
	const explicit = parseLanguage(env[LANGUAGE_ENV]);
	if (explicit !== null) return explicit;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** Resolve the current process language at call time from the live environment. */
export function language(): Language {
	return resolveLanguage(process.env);
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}

/**
 * `value` as one bash word without a double quote character: single-quoted, `'` as `'\''` and `"` as
 * `$'\x22'`. The replacers are functions because `$'` in a replacement string means "text after the match".
 */
function shellWord(value: string): string {
	return `'${value.replaceAll("'", () => `'\\''`).replaceAll('"', () => `'$'\\x22''`)}'`;
}

/**
 * `argv` run with the current process language in a Tern pane that does not inherit this process's
 * environment: omp's own bash runs `argv` with the variable set and exits with its status, on every
 * platform. The line holds no double quote, which Windows PowerShell 5.1 drops from the arguments of
 * programs it starts.
 */
export function withLanguage(argv: readonly string[]): string[] {
	return ["omp", "bash", "-c", `${LANGUAGE_ENV}=${language()} ${argv.map(shellWord).join(" ")}`];
}
