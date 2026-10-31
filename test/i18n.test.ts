import { describe, expect, test } from "bun:test";
import { language, resolveLanguage, withLanguage } from "../src/i18n";

describe("process language", () => {
	test("the eight shared-rule language vectors", () => {
		expect(resolveLanguage({ OMOMP_LANG: " ZH " })).toBe("zh");
		expect(resolveLanguage({ OMOMP_LANG: "zh-CN", LANG: "en_US.UTF-8" })).toBe("en");
		expect(resolveLanguage({ LC_ALL: "", LC_MESSAGES: "zh_CN.UTF-8" })).toBe("zh");
		expect(resolveLanguage({ LC_ALL: "C", LANG: "zh_CN.UTF-8" })).toBe("en");
		expect(resolveLanguage({})).toBe("en");
		expect(resolveLanguage({ LANG: "en_US.UTF-8" }, "zh")).toBe("zh");
		expect(resolveLanguage({ OMOMP_LANG: "en" }, "zh")).toBe("en");
		// The strict config boundary rejects uppercase ZH and supplies no configured language.
		expect(resolveLanguage({ LANG: "zh_CN.UTF-8" }, null)).toBe("zh");
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
	test("a configured language sits after explicit OMOMP_LANG and before locale fallback", () => {
		expect(resolveLanguage({ OMOMP_LANG: "en", LANG: "zh_CN.UTF-8" }, "zh")).toBe("en");
		expect(resolveLanguage({ LANG: "en_US.UTF-8" }, "zh")).toBe("zh");
		expect(resolveLanguage({}, null)).toBe("en");
	});
	test("language and withLanguage resolve the environment at call time", () => {
		const previous = process.env.OMOMP_LANG;
		try {
			process.env.OMOMP_LANG = "en";
			expect(language()).toBe("en");
			expect(withLanguage(["bun", "service.ts"])).toEqual(["env", "OMOMP_LANG=en", "bun", "service.ts"]);
			process.env.OMOMP_LANG = "zh";
			expect(language()).toBe("zh");
			expect(withLanguage(["omp"])).toEqual(["env", "OMOMP_LANG=zh", "omp"]);
		} finally {
			if (previous === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = previous;
		}
	});
	test("no setting at all is English", () => {
		expect(resolveLanguage({})).toBe("en");
	});
});
