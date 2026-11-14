import { describe, expect, test } from "bun:test";
import { language, resolveLanguage, withLanguage } from "../src/i18n";

describe("process language", () => {
	test("the language vectors: OMOMP_LANG, then locale, then English", () => {
		expect(resolveLanguage({ OMOMP_LANG: " ZH " })).toBe("zh");
		expect(resolveLanguage({ OMOMP_LANG: "zh-CN", LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveLanguage({ LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ LC_ALL: "C", LANG: "zh_CN.UTF-8" })).toBe("en");
		expect(resolveLanguage({})).toBe("en");
	});
	test("OMOMP_LANG en or zh wins over the locale", () => {
		expect(resolveLanguage({ OMOMP_LANG: "zh", LANG: "en_US.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ OMOMP_LANG: " EN ", LC_ALL: "zh_CN.UTF-8" })).toBe("en");
	});
	test("any other OMOMP_LANG value is ignored, locale style included", () => {
		expect(resolveLanguage({ OMOMP_LANG: "zh_CN", LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveLanguage({ OMOMP_LANG: "fr", LANG: "zh_TW.UTF-8" })).toBe("zh");
	});
	test("the first non-empty of LC_ALL, LC_MESSAGES, LANG decides; only zh locales are Chinese", () => {
		expect(resolveLanguage({ LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ LC_ALL: "C.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
		expect(resolveLanguage({ LANG: "ZH-tw" })).toBe("zh");
		for (const value of ["en_US.UTF-8", "C", "POSIX", "ja_JP.UTF-8"]) expect(resolveLanguage({ LANG: value })).toBe("en");
	});
	test("withLanguage starts argv unchanged with the language resolved at call time", async () => {
		const previous = process.env.OMOMP_LANG;
		const words = ["a b", "c'd", 'say "hi"', "e$'x", "D:\\x y\\"];
		const probe = ["bun", "-e", "console.log(JSON.stringify([process.env.OMOMP_LANG, ...process.argv.slice(1)]))", ...words];
		const run = async (argv: string[]): Promise<unknown> => JSON.parse(await new Response(Bun.spawn(argv, { env: { ...process.env, OMOMP_LANG: "" } }).stdout).text());
		try {
			process.env.OMOMP_LANG = "en";
			expect(language()).toBe("en");
			const en = withLanguage(probe);
			expect(en.join(" ")).not.toContain('"');
			process.env.OMOMP_LANG = "zh";
			expect(language()).toBe("zh");
			expect(await run(en)).toEqual(["en", ...words]);
			expect(await run(withLanguage(probe))).toEqual(["zh", ...words]);
		} finally {
			if (previous === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = previous;
		}
	});
	test("no setting at all is English", () => {
		expect(resolveLanguage({})).toBe("en");
	});
});
